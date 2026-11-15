/*
 * Timeline geometry for a topic. Pure functions — no DOM — so it can be tested
 * in Node.
 *
 * ## x: linear, with marked breaks
 *
 * A topic like England runs from the Palaeolithic to today. On one linear axis
 * that is either 80,000 years of empty scroll or a Tudor period crushed into a
 * few pixels. The atlas rule ("x is linear, always, gaps read as real") is right
 * for an exploratory map; here the job is reading a story, so empty stretches
 * longer than BREAK_PX are cut out and replaced by a visibly hatched break that
 * says how long the gap is. Within a segment x stays strictly linear, so
 * distances you can see are still true.
 *
 * ## y: lanes, most important first
 *
 * Cards are packed first-fit into rows, in IMPORTANCE order rather than time
 * order, so the top row is the headline sequence of the topic and you can read
 * it left to right without looking down. That is the "piece several important
 * events together at once" requirement.
 */

export const GEO = {
  CARD_W: 168,            // narrower on a phone: see setNarrow()
  UNIT: 64,               // one row: a chip (CHIP_H) plus the gap under it
  CHIP_H: 56,
  FULL_ROWS: 3,           // a picture card spans three rows...
  IMG_H: 128,             // ...of which this much is picture
  CARD_GAP: 12,           // horizontal clearance between cards in one row
  LEFT: 90,
  RIGHT: 220,
  BREAK_PX: 520,          // an empty stretch wider than this is cut out...
  BREAK_W: 46,            // ...and replaced by a break this wide
  BANDS_H: 64,            // chapter bands + ticks
  MAX_LINE: 6,            // a span/life line wider than this many cards is not drawn
};
GEO.CARD_H = GEO.FULL_ROWS * GEO.UNIT - (GEO.UNIT - GEO.CHIP_H);

/** On a phone: narrower cards, and picture cards two rows tall instead of three. */
export function setNarrow(on){
  GEO.CARD_W = on ? 148 : 168;
  GEO.FULL_ROWS = on ? 2 : 3;
  GEO.IMG_H = on ? 60 : 128;
  GEO.CARD_H = GEO.FULL_ROWS * GEO.UNIT - (GEO.UNIT - GEO.CHIP_H);
}

/*
 * ## Two sizes of card
 *
 * The timeline is for seeing what happened at a glance, so most entries are
 * CHIPS: one row, date and title, no picture. A picture card (three rows) is
 * kept for the most important essentials that have a picture OF THEMSELVES.
 * A mined event that borrowed its person's portrait ("Pascal's barometer
 * experiment" wearing Pascal's face) is a chip linked to the person: the same
 * face three times over says nothing and costs three cards of space.
 *
 * People are chips with a round portrait and a life line; only the most
 * important people of the view get a picture card.
 */
export function borrowedPortrait(it, lookup){
  if(!it.imageFrom || it.imageFrom === it.id) return false;
  const src = lookup?.(it.imageFrom);
  // A person's face, a country's flag, an era's emblem: none of them is a
  // picture OF this event. The picture of a thing it is about (the Ishango
  // bone, a book) is, and the detail panel keeps it.
  return !src || ['person', 'place', 'group', 'period'].includes(src.type);
}

export function cardTiers(items, lookup){
  const tiers = new Map();
  const key = items.filter((it) => it.key).sort((a, b) => b.importance - a.importance);
  const rank = new Map(key.map((it, i) => [it.id, i / Math.max(1, key.length)]));
  for(const it of items){
    // Only a picture of its own earns a picture card; any borrowed one makes a chip.
    const own = !!it.image && (!it.imageFrom || it.imageFrom === it.id) && it.type !== 'concept';
    const r = rank.get(it.id);
    const full = own && r != null && r < (it.type === 'person' ? 0.22 : 0.45);
    tiers.set(it.id, full ? 'full' : 'chip');
  }
  return tiers;
}

export const rowsOf = (tiers) => (it) => tiers.get(it.id) === 'full' ? GEO.FULL_ROWS : 1;

/**
 * The line drawn in the gap above a card: a person's life, or an event's
 * duration. Null when there is none, or when it is too long to read as this
 * card's own extent (a Middle Ages bar across half the canvas is the chapter
 * band's job).
 */
export function lineSpan(it, scale){
  if(it.kind !== 'span' || it.end == null || it.end === it.start) return null;
  if(it.type === 'person' && it.openEnded) return null;
  let a = scale.x(it.start), b = scale.x(it.end);
  if(b - a < 3 || b - a > GEO.CARD_W * GEO.MAX_LINE) return null;
  // Never draw across a break: the years in it are not on the axis, so a line
  // through the hatching claims time that is not shown. Clip to the segment
  // the card sits in; a clipped end is drawn open (faded, no end tick).
  const cx = scale.x(anchorYear(it));
  let openL = false, openR = false;
  for(const br of scale.breaks || []){
    const l = br.x, r = br.x + br.w;
    if(r <= cx && a < r){ a = r + 2; openL = true; }
    if(l >= cx && b > l){ b = l - 2; openR = true; }
  }
  if(b - a < 3) return null;
  const line = [a, b];
  line.openL = openL; line.openR = openR;
  return line;
}

/** The year an item is drawn at (and sorted by). People sit at their prime. */
export function anchorYear(it){
  if(it.type === 'person' && it.kind === 'span' && it.end != null && it.dataset !== 'leaders'){
    return Math.round(it.start + (it.end - it.start) * 0.6);
  }
  return it.start;
}

/**
 * Build the x scale for a set of visible items at `ppy` pixels per year.
 * Returns { x(year), width, segments, breaks }.
 */
export function makeScale(items, ppy){
  const years = items.map(anchorYear).sort((a, b) => a - b);
  if(!years.length) return { x: () => GEO.LEFT, width: GEO.LEFT + GEO.RIGHT, segments: [], breaks: [] };

  // Segment the years wherever two consecutive anchors are more than BREAK_PX
  // apart at this zoom. The gap test leaves room for one card either side.
  const minGapYears = (GEO.BREAK_PX + GEO.CARD_W) / ppy;
  const segs = [];
  let cur = { y0: years[0], y1: years[0] };
  for(let i = 1; i < years.length; i++){
    if(years[i] - cur.y1 > minGapYears){ segs.push(cur); cur = { y0: years[i], y1: years[i] }; }
    else cur.y1 = years[i];
  }
  segs.push(cur);

  // Lay segments end to end: each is padded half a card either side so a card
  // centred on its first or last year is not cut by the break.
  const pad = GEO.CARD_W / 2 + 10;
  let px = GEO.LEFT;
  const breaks = [];
  segs.forEach((s, i) => {
    if(i > 0){
      breaks.push({ x: px, w: GEO.BREAK_W, years: s.y0 - segs[i - 1].y1, from: segs[i - 1].y1, to: s.y0 });
      px += GEO.BREAK_W;
    }
    s.px0 = px + pad;
    s.px1 = s.px0 + (s.y1 - s.y0) * ppy;
    px = s.px1 + pad;
  });

  const x = (year) => {
    // Inside a segment: linear. Between segments: clamp to the nearer edge, so
    // a span's end that falls in a cut gap still draws to the break.
    for(let i = 0; i < segs.length; i++){
      const s = segs[i];
      if(year <= s.y1 || i === segs.length - 1){
        if(year < s.y0) return i === 0 ? s.px0 - (s.y0 - year) * ppy : s.px0 - pad / 2;
        return s.px0 + (Math.min(year, s.y1 + (i === segs.length - 1 ? Infinity : 0)) - s.y0) * ppy;
      }
      if(year < segs[i + 1].y0) return s.px1 + pad / 2;
    }
    return px;
  };

  return { x, width: px + GEO.RIGHT, segments: segs, breaks, ppy };
}

/** A tick step that gives roughly one label per 110px. */
export function tickStep(ppy){
  const want = 110 / ppy;
  for(const s of [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000]){
    if(s >= want) return s;
  }
  // Deep time: 1-2-5 steps up to billions of years.
  for(let m = 1e5; m < 1e11; m *= 10) for(const k of [2, 5, 10]) if(k * m >= want) return k * m;
  return 1e10;
}

/** Ticks for every segment of a scale. */
export function ticks(scale){
  const step = tickStep(scale.ppy);
  const out = [];
  for(const s of scale.segments){
    const first = Math.ceil(s.y0 / step) * step;
    for(let y = first; y <= s.y1 + step * 0.5; y += step){
      if(y > s.y1 + 1) break;
      out.push({ year: y, x: scale.x(y) });
    }
    // A segment too short for any tick gets one at its own start.
    if(!out.length || out[out.length - 1].x < s.px0 - 1) out.push({ year: s.y0, x: s.px0, edge: true });
  }
  return out;
}

/**
 * Pack cards into rows. `items` must already be filtered; they are placed in
 * importance order (desc), each into the first row where it fits: a card of
 * `rows(it)` rows needs every one of those rows free across its width, and its
 * line (`line(it)`, drawn in the gap above it) must not cross another line or
 * a taller card spanning that gap.
 *
 * `optional` items are placed after all of `items`, in importance order, only
 * where they fit within the first `maxRows` rows; the rest are left out. That
 * is how a zoomed-in Essentials view fills its free space (see layoutTimeline).
 * Returns { pos: Map(id -> {x, lane, rows, line}), laneCount, placed: Set of optional ids }.
 */
export function pack(items, scale, { rows = () => 1, line = () => null, optional = [], maxRows = Infinity } = {}){
  const byImp = (a, b) => (b.importance - a.importance) || (a.start - b.start);
  const cards = [];   // per row: [left, right] intervals of cards in that row
  const gaps = [];    // per row: intervals blocked in the gap ABOVE that row
  const hit = (L, l, r) => !!L && L.some(([a, b]) => l < b && r > a);
  const add = (A, i, iv) => (A[i] || (A[i] = [])).push(iv);
  const pos = new Map();
  const placed = new Set();
  let used = 0;
  const W = GEO.CARD_W + GEO.CARD_GAP;
  const fits = (row, l, r, h, ln) => {
    for(let k = 0; k < h; k++) if(hit(cards[row + k], l, r)) return false;
    // a tall card covers the gaps inside it: no line may run there
    for(let k = 1; k < h; k++) if(hit(gaps[row + k], l, r)) return false;
    return !(ln && hit(gaps[row], ln[0] - 4, ln[1] + 4));
  };
  const put = (it, row, cx, l, r, h, ln) => {
    for(let k = 0; k < h; k++) add(cards, row + k, [l, r]);
    for(let k = 1; k < h; k++) add(gaps, row + k, [l, r]);
    if(ln) add(gaps, row, ln);
    pos.set(it.id, { x: cx, lane: row, rows: h, line: ln });
    used = Math.max(used, row + h);
  };
  for(const it of [...items].sort(byImp)){
    const cx = scale.x(anchorYear(it));
    const l = cx - W / 2, r = cx + W / 2, h = rows(it), ln = line(it);
    let row = 0;
    while(!fits(row, l, r, h, ln)) row++;
    put(it, row, cx, l, r, h, ln);
  }
  for(const it of [...optional].sort(byImp)){
    const cx = scale.x(anchorYear(it));
    const l = cx - W / 2, r = cx + W / 2, h = rows(it), ln = line(it);
    for(let row = 0; row + h <= maxRows; row++){
      if(fits(row, l, r, h, ln)){ put(it, row, cx, l, r, h, ln); placed.add(it.id); break; }
    }
  }
  return { pos, laneCount: used, placed };
}

/*
 * ## The eras track
 *
 * Dynasties, kingdoms and eras are spans of time, not things that happened at
 * a moment: as cards they sat at their first year and said nothing about how
 * long they lasted or what overlapped them. They are drawn as labelled bars
 * in a thin track under the chapter bands (up to `rows` rows), and are no
 * longer cards. Rulers with a stored reign get a track of their own; their
 * cards stay, since a person's card explains the person.
 */
export const isEraBar = (it) => it.type === 'period' && it.end != null && it.end > it.start && !it.openEnded;
export const isReignBar = (it) => it.dataset === 'leaders' && it.kind === 'span' && it.end != null && it.end > it.start;
export const BAR = { H: 15, ROW: 18 };

/**
 * Bars for spans, packed by importance into at most `rows` rows. Returns
 * { bars: [{ it, x0, x1, row, clipL, clipR }], left: items that did not fit,
 *   umbrellas: items spanning far more than the whole view }.
 */
export function packBars(list, scale, rows, range){
  const lo = GEO.LEFT / 2, hi = scale.width - GEO.RIGHT / 2;
  const span = Math.max(1, range[1] - range[0]);
  const rowsIv = Array.from({ length: rows }, () => []);
  const bars = [], left = [], umbrellas = [];
  const order = [...list].sort((a, b) => (!!b.key - !!a.key) || (b.importance - a.importance) || (a.start - b.start));
  for(const it of order){
    // The context of the whole view, not a part of it: Pre-Columbian era on
    // the Inca timeline. A bar across everything says nothing.
    if(it.start <= range[0] && it.end >= range[1] && it.end - it.start > 2 * span){ umbrellas.push(it); continue; }
    // One bar per era: *Kamakura shogunate* and *Kamakura period* are the same
    // 1185–1333 told twice. A span mostly the same sharing a name word is skipped.
    const len = it.end - it.start;
    const word = (t) => new Set(String(t).toLowerCase().match(/[a-zà-ÿ]{4,}/g) || []);
    const w = word(it.title);
    const same = (o) => Math.min(o.end, it.end) - Math.max(o.start, it.start) >= 0.8 * Math.min(len, o.end - o.start) &&
      Math.abs((o.end - o.start) - len) <= 0.35 * Math.max(len, o.end - o.start);
    if(bars.some((b) => same(b.it) &&
      [...word(b.it.title)].some((x) => w.has(x) && !/^(period|empire|kingdom|dynasty|state|republic|era|history)$/.test(x)))){ umbrellas.push(it); continue; }
    const a = scale.x(it.start), b = scale.x(it.end);
    const x0 = Math.max(lo, Math.min(hi, a)), x1 = Math.max(lo, Math.min(hi, b));
    if(x1 - x0 < 6){ left.push(it); continue; }
    const row = rowsIv.findIndex((iv) => !iv.some(([l, r]) => x0 < r + 3 && x1 > l - 3));
    if(row < 0){ left.push(it); continue; }
    rowsIv[row].push([x0, x1]);
    bars.push({ it, x0, x1, row, clipL: a < lo, clipR: b > hi });
  }
  return { bars, left, umbrellas, rows: bars.length ? Math.max(...bars.map((b) => b.row)) + 1 : 0 };
}

/**
 * The whole timeline layout, from the items that pass the filters (`pool`):
 *
 * - periods become bars (eras track), rulers get a reign track;
 * - Everything: every other entry is a card;
 * - Essentials: the essentials are packed first, then the free space is filled
 *   with other entries as small chips, most important first, in rows up to
 *   max(rows the essentials use, `fillRows`). Zooming in leaves more room, so
 *   more of them appear, the way a map adds street names. The scale is the
 *   essentials' own, so filling never moves them.
 *
 * Returns { scale, cards, pos, laneCount, tiers, eras, rulers, minor: Set }.
 */
export function layoutTimeline(pool, { show = 'key', ppy, lookup, eraRows = 3, rulerRows = 2, fillRows = 8 } = {}){
  const ys = pool.map(anchorYear);
  const range = ys.length ? [Math.min(...ys), Math.max(...ys)] : [0, 0];
  // Off-topic periods (the audit's 'off') are not this topic's eras.
  const eraCands = pool.filter((it) => isEraBar(it) && !it.offTopic);
  const eraIds = new Set(eraCands.map((it) => it.id));
  const rest = pool.filter((it) => !eraIds.has(it.id));
  let base = show === 'key' ? rest.filter((it) => it.key) : rest;
  let scale = makeScale(base.length ? base : pool, ppy);
  let E = packBars(eraCands, scale, eraRows, range);
  // A period with no room in the track stays a card (if it would be one).
  const back = E.left.filter((it) => show === 'all' || it.key);
  if(back.length){
    // Rescaled with them, all eras are packed again: on the new scale some of
    // them fit after all, and only what still does not becomes a card.
    const base0 = base;
    scale = makeScale(base0.concat(back), ppy);
    E = packBars(eraCands, scale, eraRows, range);
    base = base0.concat(E.left.filter((it) => show === 'all' || it.key));
  }
  const R = packBars(pool.filter(isReignBar), scale, rulerRows, range);
  let optional = [];
  if(show === 'key'){
    // Only inside the essentials' own segments: one outside would sit on a break.
    const slack = GEO.CARD_W / 2 / Math.max(1e-9, ppy);
    const inSeg = (y) => scale.segments.some((s) => y >= s.y0 - slack && y <= s.y1 + slack);
    const taken = new Set(base.map((it) => it.id));
    // What happened, who and what was made: a place or a group dated by its
    // founding repeats the event next to it ("Potosí" by "Potosí founded").
    optional = rest.filter((it) => !it.key && !it.offTopic && !taken.has(it.id) && inSeg(anchorYear(it)) &&
      (!['place', 'group', 'concept'].includes(it.type) || it.hat));
  }
  const tiers = cardTiers(base, lookup);
  for(const it of optional) tiers.set(it.id, 'chip');
  const line = (it) => lineSpan(it, scale);
  const first = pack(base, scale, { rows: rowsOf(tiers), line });
  const { pos, laneCount, placed } = optional.length
    ? pack(base, scale, { rows: rowsOf(tiers), line, optional, maxRows: Math.max(first.laneCount, fillRows) })
    : first;
  const cards = base.concat(optional.filter((it) => placed.has(it.id)));
  return { scale, cards, pos, laneCount, tiers, eras: E.bars, eraRows: E.rows, rulers: R.bars, rulerRows: R.rows, minor: placed, umbrellas: E.umbrellas };
}

/*
 * Deep time reads as "years ago": 66 million years ago, not 66,000,000 BC.
 * From 100,000 BC back; nearer than that, BC reads fine.
 */
const DEEP = -100000;
const sig3 = (v) => { const r = Number(v.toPrecision(3)); return r >= 100 ? String(Math.round(r)) : String(r); };
function agoUnit(a){
  return a >= 1e9 ? [1e9, 'billion'] : a >= 1e6 ? [1e6, 'million'] : [1e3, 'thousand'];
}

/** "1066", "55 BC", "10,000 BC", "66 million years ago"; `short`: "66 Mya" (for ticks). */
export function fmtYear(y, { short = false } = {}){
  if(y == null) return '';
  if(y <= DEEP){
    const a = Math.abs(y);
    const [d, w] = agoUnit(a);
    return short ? `${sig3(a / d)} ${w === 'billion' ? 'Bya' : w === 'million' ? 'Mya' : 'kya'}` : `${sig3(a / d)} ${w} years ago`;
  }
  const a = Math.abs(Math.round(y));
  const s = a >= 10000 ? a.toLocaleString('en-US') : String(a);
  return y < 0 ? `${s} BC` : s;
}

export function fmtRange(from, to){
  if(from == null) return '';
  if(to == null || to === from) return fmtYear(from);
  if(from <= DEEP && to <= DEEP){
    const [d, w] = agoUnit(Math.abs(from));
    if(Math.abs(to) >= d) return `${sig3(Math.abs(from) / d)}–${sig3(Math.abs(to) / d)} ${w} years ago`;
    return `${fmtYear(from)} – ${fmtYear(to)}`;
  }
  if(from <= DEEP) return `${fmtYear(from)} – ${to >= new Date().getFullYear() ? 'today' : fmtYear(to)}`;
  if(from < 0 && to < 0) return `${fmtYear(from).replace(' BC', '')}–${fmtYear(to)}`;
  return `${fmtYear(from)}–${fmtYear(to)}`;
}

/**
 * The date shown for an entry. The source's own wording when it has one
 * ("c. 2500 BC", "1558–1603"), tidied; deep time and spans without it from
 * the numbers.
 */
export function fmtWhen(it){
  if(it.start == null) return '';
  if(it.start <= DEEP) return it.end != null && it.end !== it.start && !it.openEnded ? fmtRange(it.start, it.end) : fmtYear(it.start);
  const t = tidyYear(it.yearText);
  if(t) return t;
  return it.kind === 'span' && it.end != null && !it.openEnded ? fmtRange(it.start, it.end) : fmtYear(it.start);
}

/** A mined date as the sentence put it ("from 3000 to 1800 BC", "around 2500 BC") → "3000–1800 BC", "c. 2500 BC". */
export function tidyYear(t){
  return String(t || '').trim()
    .replace(/^\((.*)\)$/, '$1')
    .replace(/^(around|about|circa|approximately|roughly|ca\.?)\s+/i, 'c. ')
    .replace(/^(from|between|in|by|since|until)\s+/i, '')
    .replace(/^(\S+(?:\s+(?:BC|BCE|AD|CE))?)\s+(?:to|and|until)\s+/i, '$1–')
    .replace(/^(early|mid|late)\s+/i, (m) => m[0].toUpperCase() + m.slice(1))
    .replace(/(\d|BC|BCE|AD|CE)\s*-\s*(?=\d)/g, '$1–');
}

/** First sentence(s) of an excerpt, up to about `max` characters. */
export function summary(text, max = 260){
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if(s.length <= max) return s;
  const cut = s.slice(0, max);
  const k = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '));
  return k > 80 ? cut.slice(0, k + 1) : cut.replace(/\s+\S*$/, '') + '…';
}
