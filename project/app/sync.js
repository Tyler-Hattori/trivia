/*
 * Accounts: Supabase auth (email magic link, Google) + the `progress` table,
 * called straight from the browser (no server). The anon key is public by
 * design; row-level security keeps each user to their own rows (SQL in
 * docs/ACCOUNTS.md).
 *
 * What syncs: the quiz memory, `mastery:v2` (one record per entry). On sign-in
 * (and each page load while signed in) the account's records are pulled and
 * merged (newer `at` wins per entry, old ids mapped through web/aliases.json),
 * then every local record that is newer than the account's is pushed. After
 * that each answer is pushed as it is recorded (quiz.js fires
 * `mastery-changed`), batched for a couple of seconds.
 *
 * Signed out, or with no key configured, nothing here runs and the site works
 * from localStorage alone, as before.
 */
import { loadMastery, mergeMastery } from '../features/topic/quiz.js';

export const SUPABASE_URL = 'https://oysegbcdjxkrtaokinrt.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_oc2YjaJJ3-S-oKtrn3esCw_3jJUVS79';   // Project Settings > API > anon public key

// Turn on once Authentication > Providers > Google is configured (docs/ACCOUNTS.md).
const GOOGLE_ENABLED = true;

let client = null, user = null;
const listeners = new Set();
const emit = () => listeners.forEach((f) => { try { f(user); } catch {} });
export const onAccount = (f) => { listeners.add(f); return () => listeners.delete(f); };
export const account = () => user;
export const accountsEnabled = () => !!SUPABASE_ANON_KEY;

async function getClient(){
  if(client || !SUPABASE_ANON_KEY) return client;
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, detectSessionInUrl: true } });
  client.auth.onAuthStateChange((ev, session) => {
    const was = user?.id;
    user = session?.user || null;
    emit();
    if(user && user.id !== was) fullSync().catch((e) => console.warn('sync failed', e));
  });
  return client;
}

/** The redirect back to the page the user signed in from (must be in Supabase's redirect list). */
const back = () => location.origin + location.pathname;

export async function signInEmail(email){
  const c = await getClient();
  const { error } = await c.auth.signInWithOtp({ email, options: { emailRedirectTo: back() } });
  if(error) throw error;
}
export async function signInGoogle(){
  const c = await getClient();
  const { error } = await c.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: back() } });
  if(error) throw error;
}
export async function signOut(){ const c = await getClient(); await c?.auth.signOut(); }

let aliases = null;
async function loadAliases(){
  if(aliases) return aliases;
  try { const r = await fetch('datasets/web/aliases.json'); aliases = r.ok ? ((await r.json()).map || {}) : {}; } catch { aliases = {}; }
  return aliases;
}

/** Pull everything (paged: PostgREST returns 1,000 rows at most), merge, push what is newer here. */
async function fullSync(){
  const c = await getClient();
  if(!c || !user) return;
  const remote = {};
  for(let from = 0; ; from += 1000){
    const { data, error } = await c.from('progress').select('entry_id, record').range(from, from + 999);
    if(error) throw error;
    for(const r of data) remote[r.entry_id] = r.record;
    if(data.length < 1000) break;
  }
  const newer = mergeMastery(remote, await loadAliases());
  await push(newer);
}

async function push(ids){
  const c = await getClient();
  if(!c || !user || !ids.length) return;
  const m = loadMastery();
  const rows = ids.filter((id) => m[id]).map((id) => ({ user_id: user.id, entry_id: id, record: m[id], updated_at: new Date(m[id].at || Date.now()).toISOString() }));
  for(let i = 0; i < rows.length; i += 500){
    const { error } = await c.from('progress').upsert(rows.slice(i, i + 500));
    if(error) throw error;
  }
}

let pending = new Set(), timer = null;
window.addEventListener('mastery-changed', (e) => {
  if(!user) return;
  for(const id of e.detail?.ids || []) pending.add(id);
  clearTimeout(timer);
  timer = setTimeout(() => { const ids = [...pending]; pending = new Set(); push(ids).catch((err) => { ids.forEach((i) => pending.add(i)); console.warn('push failed', err); }); }, 2000);
});

/** Start-up: restore a session (or finish a magic-link / Google redirect). Cheap when no key is set. */
export async function initAccounts(){
  if(!SUPABASE_ANON_KEY) return;
  const c = await getClient();
  const { data } = await c.auth.getSession();
  user = data.session?.user || null;
  emit();
  if(user) fullSync().catch((e) => console.warn('sync failed', e));
}

/** The small account line on the home page; wired by bindAccountBox(). */
export function accountBoxHtml(){
  if(!SUPABASE_ANON_KEY) return '';
  return `<div id="acct" class="flex items-center justify-end gap-2 text-sm text-zinc-500 w-full md:w-auto"></div>`;
}
export function bindAccountBox(){
  const el = document.getElementById('acct');
  if(!el) return;
  const draw = () => {
    if(user){
      el.innerHTML = `<span>Signed in as <b class="text-zinc-700">${user.email || 'you'}</b>: answers sync across devices</span>
        <button data-a="out" class="underline">Sign out</button>`;
    } else {
      el.innerHTML = `<span class="hidden md:inline">Sign in to keep your answers on every device:</span>
        <form data-a="mail" class="flex gap-2 flex-1 md:flex-none min-w-0"><input name="e" type="email" required placeholder="email to sign in" class="rounded-lg border border-zinc-200 px-2 py-1 min-w-0 flex-1 md:w-48">
        <button class="rounded-lg bg-zinc-900 text-white px-3 py-1 whitespace-nowrap">Email link</button></form>
        ${GOOGLE_ENABLED ? '<button data-a="google" class="rounded-lg border border-zinc-300 px-3 py-1">Google</button>' : ''}`;
    }
  };
  draw();
  const off = onAccount(() => document.body.contains(el) ? draw() : off());
  el.addEventListener('click', (e) => {
    const a = e.target.closest('button')?.dataset.a;
    if(a === 'out') signOut();
    if(a === 'google') signInGoogle().catch((err) => alert(err.message));
  });
  el.addEventListener('submit', (e) => {
    e.preventDefault();
    signInEmail(e.target.e.value.trim()).then(() => { el.innerHTML = '<span>Check your email for the sign-in link.</span>'; }, (err) => alert(err.message));
  });
}
