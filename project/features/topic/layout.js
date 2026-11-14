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
 * Cards are packed first-fit into lanes, in IMPORTANCE order rather than time
 * order, so the top lane is the headline sequence of the topic and you can read
 * it left to right without looking down. That is the "piece several important
 * events together at once" requirement.
 */

export const GEO = {
  CARD_W: 168,
  IMG_H: 104,
  CARD_H: 104 + 6 + 52,   // image + strip + caption
  LANE_GAP: 14,
  CARD_GAP: 12,           // horizontal clearance between cards in one lane
  LEFT: 90,
  RIGHT: 220,
  BREAK_PX: 520,          // an empty stretch wider than this is cut out...
  BREAK_W: 46,            // ...and replaced by a break this wide
  BANDS_H: 64,            // chapter bands + ticks
};

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
  return 1e6;
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
 * Pack cards into lanes. `items` must already be filtered; they are placed in
 * importance order (desc), each into the first lane where it does not collide.
 * Returns Map(id -> {x, lane}) and the lane count.
 */
export function pack(items, scale){
  const order = [...items].sort((a, b) => (b.importance - a.importance) || (a.start - b.start));
  const lanes = [];   // per lane: sorted array of [left, right] intervals
  const pos = new Map();
  const W = GEO.CARD_W + GEO.CARD_GAP;
  for(const it of order){
    const cx = scale.x(anchorYear(it));
    const l = cx - W / 2, r = cx + W / 2;
    let lane = 0;
    for(;; lane++){
      const L = lanes[lane] || (lanes[lane] = []);
      if(!L.some(([a, b]) => l < b && r > a)){ L.push([l, r]); break; }
    }
    pos.set(it.id, { x: cx, lane });
  }
  return { pos, laneCount: lanes.length };
}

/** "1066", "55 BC", "c. 10,000 BC", "1485–1603". */
export function fmtYear(y){
  if(y == null) return '';
  const a = Math.abs(Math.round(y));
  const s = a >= 10000 ? a.toLocaleString('en-US') : String(a);
  return y < 0 ? `${s} BC` : s;
}

export function fmtRange(from, to){
  if(from == null) return '';
  if(to == null || to === from) return fmtYear(from);
  if(from < 0 && to < 0) return `${fmtYear(from).replace(' BC', '')}–${fmtYear(to)}`;
  return `${fmtYear(from)}–${fmtYear(to)}`;
}

/** First sentence(s) of an excerpt, up to about `max` characters. */
export function summary(text, max = 260){
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if(s.length <= max) return s;
  const cut = s.slice(0, max);
  const k = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '));
  return k > 80 ? cut.slice(0, k + 1) : cut.replace(/\s+\S*$/, '') + '…';
}
