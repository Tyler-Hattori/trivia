# Accounts (Supabase)

Code: `project/app/sync.js` (auth + sync), `mergeMastery` and the
`mastery-changed` event in `project/features/topic/quiz.js`, the account line on
the home page (`ui/home.js`, hidden until a key is set).

Project: https://oysegbcdjxkrtaokinrt.supabase.co. Paste the **anon public**
key (Project Settings > API) into `SUPABASE_ANON_KEY` in `sync.js`. It is public
by design; row-level security protects the data. Never put the service_role key
in the site.

## One-time setup in the Supabase dashboard

1. SQL editor, run:

```sql
create table public.progress (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  entry_id   text not null,
  record     jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, entry_id)
);
alter table public.progress enable row level security;
create policy "own progress" on public.progress
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

2. Authentication > URL Configuration: Site URL
   `https://tyler-hattori.github.io/trivia/`; Redirect URLs add that and
   `http://localhost:8777/`.
3. Email magic link works out of the box (Supabase's own mailer is rate-limited
   to a few emails an hour; add SMTP later if needed).
4. Google: Authentication > Providers > Google needs a Google Cloud OAuth
   client (Web; authorised redirect URI
   `https://oysegbcdjxkrtaokinrt.supabase.co/auth/v1/callback`), then its id
   and secret pasted in Supabase.

## How sync works

- Signed in (on load, and on sign-in): pull all rows (paged by 1,000), merge
  into `mastery:v2` (newer `at` wins per entry; topic lists `x` unioned; old ids
  mapped through `web/aliases.json`), push every local record newer than the
  account's. So the first login uploads the device's history.
- Each answer: `recordAnswer` fires `mastery-changed`; pushed in a 2 s batch.
- Signed out or no key: nothing loads (supabase-js is imported from esm.sh only
  when a key is set); the site is localStorage-only as before.
