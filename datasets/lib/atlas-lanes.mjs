/**
 * The atlas's organisation: every entry gets ONE home lane, and lanes sit in
 * sections. Used by build-web.mjs (web/atlas/); the browser only reads the result.
 *
 * Lanes are TOPICS (topics/<slug>.json), arranged by the topic tree
 * (topic-structure.json `parent`), in sections named after its roots:
 * Earth & life, World, Europe, Middle East, Africa, Asia, Americas, Oceania,
 * Science, Art, Film, Sports, Arts & ideas. An entry in several topics lives in the one where it
 * matters most (an essential there, its importance, the most specific topic;
 * a collection like Europe only borrows its subtopics' entries, so it loses
 * ties). An entry in no topic falls back to its CATEGORY (the Wikimedia subject,
 * classify.mjs) and region: a physics paper to Physics, a painting to Visual
 * arts, a Polish town's history to "Europe: other".
 *
 * Inside a lane the browser splits entries by KIND (spans, events, people,
 * works and other), as the topic timeline's Lanes do.
 */

const MIN_LANE = 25;

export const SECTIONS = [
  ['earth', 'Earth & life', '#8b6f47'],
  ['world', 'World', '#475569'],
  ['europe', 'Europe', '#2563eb'],
  ['middle-east', 'Middle East', '#b45309'],
  ['africa', 'Africa', '#a16207'],
  ['asia', 'Asia', '#dc2626'],
  ['americas', 'Americas', '#059669'],
  ['oceania', 'Oceania', '#0891b2'],
  ['science', 'Science', '#7c3aed'],
  ['art', 'Art', '#db2777'],
  ['film', 'Film', '#9333ea'],
  ['sports', 'Sports', '#16a34a'],
  ['culture', 'Arts & ideas', '#be185d'],
];

// Roots of the topic tree that are sections of their own, and where the other
// roots (topics without a parent and without children) belong.
const ROOT_SECTION = {
  'history-of-earth': 'earth', 'europe': 'europe', 'middle-east': 'middle-east', 'africa': 'africa',
  'asia': 'asia', 'latin-america': 'americas', 'united-states': 'americas', 'canada': 'americas',
  'oceania': 'oceania', 'science': 'science',
  'byzantine-empire': 'europe', 'renaissance': 'europe', 'impressionism': 'culture',
  'cold-war': 'world', 'world-war-ii': 'world',
  'art-history': 'art', 'film-history': 'film', 'sports': 'sports',
};

// A category with no topic: the science topic that covers it.
const SCIENCE_TOPIC = {
  'Physics': 'physics', 'Chemistry': 'chemistry', 'Biology': 'biology', 'Mathematics': 'mathematics',
  'Medicine & Health': 'medicine', 'Computing': 'computing', 'Space': 'astronomy',
  'Earth and environment': 'geology',
};

/** Region ("Asia › West Asia") -> section. */
export function regionSection(region){
  const [top, sub = ''] = String(region || '').split(' › ');
  if(top === 'Europe') return 'europe';
  if(top === 'Asia') return /West Asia/.test(sub) ? 'middle-east' : 'asia';
  if(top === 'Africa') return /Northern Africa/.test(sub) ? 'middle-east' : 'africa';
  if(top === 'Americas') return 'americas';
  if(top === 'Oceania') return 'oceania';
  return null;
}

/**
 * Build the lanes.
 * `topics`: [{ slug, title, parent, role }] (live ones only, in list order).
 * `members`: Map(id -> [{ slug, key, importance, onTimeline, offTopic, periodKind }]).
 * `points`: [{ id, subject: "Group › Subject", region }].
 * Returns { sections, lanes, laneOf: Map(id -> lane index), best: Map(id -> member record) }.
 */
export function buildLanes(topics, members, points){
  const bySlug = new Map(topics.map((t) => [t.slug, t]));
  const kids = new Map();
  for(const t of topics){
    const p = t.parent && bySlug.has(t.parent) ? t.parent : null;
    if(p) (kids.get(p) || kids.set(p, []).get(p)).push(t.slug);
  }
  const depthOf = new Map();
  const rootOf = (s) => { let r = s, n = 0; while(bySlug.get(r)?.parent && bySlug.has(bySlug.get(r).parent) && n++ < 9) r = bySlug.get(r).parent; return r; };
  for(const t of topics){ let d = 0, s = t.slug; while(bySlug.get(s)?.parent && bySlug.has(bySlug.get(s).parent) && d < 9){ s = bySlug.get(s).parent; d++; } depthOf.set(t.slug, d); }
  const sectionOfTopic = (s) => ROOT_SECTION[rootOf(s)] || 'world';

  // Lanes in section order, each section's topics depth-first in list order.
  const lanes = [];
  const laneIdx = new Map();
  const add = (key, label, section, extra = {}) => { laneIdx.set(key, lanes.length); lanes.push({ key, label, section, depth: 0, n: 0, ...extra }); };
  for(const [sec] of SECTIONS){
    const roots = topics.filter((t) => !(t.parent && bySlug.has(t.parent)) && sectionOfTopic(t.slug) === sec);
    const walk = (s, d) => {
      const t = bySlug.get(s);
      add(s, t.title, sec, { topic: s, depth: d, collection: t.role === 'collection' });
      for(const k of kids.get(s) || []) walk(k, d + 1);
    };
    for(const r of roots) walk(r.slug, 0);
  }

  // Each entry's home topic.
  const score = (m) => (m.key ? 4 : 0) + (m.importance || 0) * 3 + (m.onTimeline === false ? 0 : 1) - (m.offTopic ? 3 : 0)
    + (depthOf.get(m.slug) || 0) * 0.6 - (bySlug.get(m.slug)?.role === 'collection' ? 2 : 0);
  const laneOf = new Map(), best = new Map();
  const fallback = (p) => {
    const [group, subj = ''] = String(p.subject || '').split(' › ');
    if(group === 'Science & Technology'){
      const t = SCIENCE_TOPIC[subj];
      if(t && laneIdx.has(t)) return t;
      return 'other:science';
    }
    if(group === 'Culture') return `subj:${subj || 'Other culture'}`;
    const sec = regionSection(p.region);
    if(group === 'Geography' && !sec && laneIdx.has('geography')) return 'geography';
    // A big region's leftovers by subregion ("Southern Europe"), so no lane is a dump.
    const sub = String(p.region || '').split(' › ')[1] || '';
    return sub ? `other:${sec}:${sub}` : `other:${sec || 'world'}`;
  };
  const labelOf = (key) => {
    const [kind, v, sub] = key.split(':');
    if(kind === 'subj') return v.replace(/^Other culture$/, 'Other arts & ideas');
    if(sub) return `${sub}: other`;
    const sec = SECTIONS.find(([k]) => k === v);
    return v === 'science' ? 'Other science' : v === 'world' ? 'Other history' : `${sec ? sec[1] : v}: other`;
  };
  for(const p of points){
    const ms = (members.get(p.id) || []).filter((m) => laneIdx.has(m.slug));
    let key;
    if(ms.length){
      // The topic whose article brought the entry in (its id prefix) is where a
      // reader looks for it first: Battle of Hastings in England, not Viking Age.
      const sc = (m) => score(m) + (p.id.startsWith(`${m.slug}:`) ? 1.5 : 0);
      let b = ms[0];
      for(const m of ms) if(sc(m) > sc(b)) b = m;
      key = b.slug;
      best.set(p.id, b);
    } else {
      key = fallback(p);
      if(!laneIdx.has(key)){
        const sec = key.startsWith('subj:') ? 'culture' : key.split(':')[1];
        // After the section's topic lanes.
        const at = lanes.reduce((last, l, i) => (l.section === sec ? i + 1 : last), -1);
        const lane = { key, label: labelOf(key), section: sec, depth: 0, n: 0, fallback: true };
        if(at < 0) lanes.push(lane); else lanes.splice(at, 0, lane);
        laneIdx.clear();
        lanes.forEach((l, i) => laneIdx.set(l.key, i));
      }
    }
    laneOf.set(p.id, key);
  }
  // Keys -> final indices, counts, and lanes with nothing in them dropped.
  for(const key of laneOf.values()) lanes[laneIdx.get(key)].n++;
  // A fallback lane under MIN_LANE entries joins its section's catch-all
  // (Fashion, Software: a handful of entries each is not worth a lane).
  const catchAll = (l) => (l.section === 'culture' ? 'subj:Other culture' : `other:${l.section}`);
  for(const l of lanes){
    if(!l.fallback || l.n >= MIN_LANE || l.key === catchAll(l)) continue;
    const to = catchAll(l);
    if(!laneIdx.has(to)){
      const at = lanes.reduce((last, x, i) => (x.section === l.section ? i + 1 : last), -1);
      lanes.splice(at, 0, { key: to, label: labelOf(to), section: l.section, depth: 0, n: 0, fallback: true });
      laneIdx.clear(); lanes.forEach((x, i) => laneIdx.set(x.key, i));
    }
    for(const [id, key] of laneOf) if(key === l.key){ laneOf.set(id, to); lanes[laneIdx.get(to)].n++; }
    l.n = 0;
  }
  const kept = lanes.filter((l) => l.n > 0 || (kids.get(l.key) || []).length);
  const finalIdx = new Map(kept.map((l, i) => [l.key, i]));
  const out = new Map();
  for(const [id, key] of laneOf) out.set(id, finalIdx.get(key));
  const sections = SECTIONS.filter(([k]) => kept.some((l) => l.section === k)).map(([key, label, color]) => ({ key, label, color }));
  return { sections, lanes: kept, laneOf: out, best };
}

/** Eras for the header bands and the overview strip, per time range (atlas modes). */
export const ERAS = {
  civ: [
    [-3000, -1200, 'Bronze Age'], [-1200, -500, 'Iron Age'], [-500, 500, 'Classical antiquity'],
    [500, 1500, 'Middle Ages'], [1500, 1800, 'Early modern'], [1800, 1945, 'Modern'], [1945, null, 'Contemporary'],
  ],
  human: [
    [-300000, -50000, 'Middle Paleolithic'], [-50000, -10000, 'Upper Paleolithic'], [-10000, -3300, 'Neolithic'],
    [-3300, -1200, 'Bronze Age'], [-1200, 500, 'Antiquity'], [500, 1500, 'Middle Ages'], [1500, null, 'Modern'],
  ],
  earth: [
    [-4.54e9, -4.0e9, 'Hadean'], [-4.0e9, -2.5e9, 'Archean'], [-2.5e9, -538.8e6, 'Proterozoic'],
    [-538.8e6, -251.9e6, 'Paleozoic'], [-251.9e6, -66e6, 'Mesozoic'], [-66e6, null, 'Cenozoic'],
  ],
};
export const ERA_COLORS = ['#b45309', '#7c3aed', '#2563eb', '#059669', '#dc2626', '#0891b2', '#475569'];
