/*
 * The atlas layout: lanes, as on the topic timeline (topic/layout.js
 * layoutLanes), for the whole store. Pure: no DOM, testable in Node.
 *
 * Vertically: SECTIONS (Europe, Asia, Science…), each a stack of LANES (one
 * per topic, or a category for entries in no topic; datasets/lib/atlas-lanes.mjs
 * decides which). Inside a lane, entries are split by KIND, each in rows of
 * its own, in the timeline's order:
 *   spans   states, dynasties and eras: tinted bars with the name inside
 *   events  a dot and the title; a 3px line under the title if it lasted
 *   people  a life line with the name (and a round portrait) on it
 *   more    works (a small square) and places, groups, ideas (a hollow dot)
 *
 * Detail by zoom: each kind gets a number of rows that grows as you zoom in
 * (`capsFor`); entries are placed most important first (fame, essential in its
 * topic, importance there), each into the first row where it and its label fit.
 * What does not fit waits for more zoom. Packing never looks at where you are
 * scrolled, only at the window of time being laid out, so panning inside the
 * window moves nothing.
 *
 * Horizontally everything is px from the window's left edge (`x0` years).
 */

export const GEO = {
  SEC: 30,        // a section header
  LAB: 16,        // a lane's name line, above its rows
  ROW: 21,        // an entry row (Lanes' LANE.ROW)
  BAR: 18,        // a span row (Lanes' BAR.ROW), bar 15px
  KGAP: 3,        // between kinds inside a lane
  GAP: 8,         // under a lane
  EMPTY: 4,       // a lane with nothing in this window
  CELL: 4,        // packing resolution, px
  PAD: 10,        // between two labels in a row (Lanes' LANE.PAD)
  LABEL_MAX: 300,
};

export const KINDS = ['spans', 'events', 'people', 'more'];

/** Which kind of row an entry goes in. */
export function kindOf(e){
  if(e.ty === 'period' && e.e != null && e.e > e.s && !e.o) return 'spans';
  if(e.ty === 'person') return 'people';
  if(e.ty === 'event') return 'events';
  return 'more';
}

/** Bold: famous (Wikidata sitelinks) or an essential of its topic. Grey: neither, and little else known. */
export const weightOf = (e) => (e.f >= 60 || e.k ? 'key' : e.p < 8 ? 'fill' : '');

/**
 * Rows per kind at a zoom level. `z` is how many doublings in from fitting the
 * whole time range (0 = zoomed all the way out).
 */
export function capsFor(z, more = false){
  const c = {
    spans: Math.min(6, 2 + Math.floor(z / 2)),
    events: Math.min(12, 2 + Math.floor(z)),
    people: Math.min(8, 1 + Math.floor(z * 0.7)),
    more: Math.min(4, 1 + Math.floor(z / 3)),
  };
  if(more) for(const k of KINDS) c[k] *= 3;
  return c;
}

const roughWidth = (t, bold) => String(t).length * (bold ? 6.6 : 6.1);

/**
 * Lay out the lanes.
 *
 * entries   sorted most important first (p desc); already filtered
 * meta      { sections, lanes } (web/atlas/meta.json)
 * x0, ppy   the window's left edge (years) and the zoom
 * width     the window's width in px
 * view      [from, to] years actually on screen (umbrella spans are judged by it)
 * domain    [from, to] the time range (mode); lanes with nothing in it are left out
 * caps      rows per kind (capsFor)
 * folded    Set of section keys folded to their header
 * pinned    Set of lane keys stacked in the frozen header instead
 * more      Set of lane keys given three times the rows
 * order     (sections) -> sections in display order
 * hideEmpty leave out lanes with nothing in the window (search results)
 * measure   (title, bold) -> px
 *
 * Returns { sections, lanes, marks, bars, height, pinHeight, hidden }:
 *   sections [{ key, label, color, y, folded, n }]
 *   lanes    [{ i, key, label, section, depth, y, h, pinned, n, placed, left }]
 *   marks    [{ e, lane, kind, x0, x1, l, r, lw, bar, y, pinned, w }]   (events, people, more)
 *   bars     [{ e, lane, x0, x1, clipL, clipR, y, pinned }]              (spans)
 */
export function layoutAtlas(entries, meta, { x0, ppy, width, view, domain, caps, folded = new Set(), pinned = new Set(), more = new Set(), hideEmpty = false, order = null, measure = roughWidth, deep = null }){
  /*
   * deep = { from, key, min } in the Humans and Earth ranges: while the view is
   * much wider than the narrower range (from = its left edge), entries newer than
   * `from` (a sliver at the right edge) are left out, and so are lanes with fewer
   * than `min` entries older than it (meta lane .dh / .de). Zoomed in near the
   * present, everything comes back.
   */
  const wide = !!deep && (view[1] - view[0]) > 3 * Math.max(1, (domain?.[1] ?? 2026) - deep.from);
  const nL = meta.lanes.length;
  const X = (y) => (y - x0) * ppy;
  const cells = Math.ceil(width / GEO.CELL) + 2;
  // rows[lane][kind] = [Uint8Array(cells)…]
  const rows = Array.from({ length: nL }, () => ({ spans: [], events: [], people: [], more: [] }));
  const marks = [], bars = [];
  const placed = new Int32Array(nL), left = new Int32Array(nL);
  const vSpan = Math.max(1e-9, view[1] - view[0]);
  const laneVisible = meta.lanes.map((l) => !folded.has(l.section) || pinned.has(l.key));

  const xEnd = domain ? X(domain[1]) : null;
  const fits = (row, a, b) => { for(let c = a; c <= b; c++) if(row[c]) return false; return true; };
  const take = (row, a, b) => { for(let c = a; c <= b; c++) row[c] = 1; };
  const cellOf = (px) => Math.max(0, Math.min(cells - 1, Math.floor(px / GEO.CELL)));

  for(const e of entries){
    const li = e.ln;
    if(li == null || li < 0 || li >= nL || !laneVisible[li]) continue;
    if(wide && e.s >= deep.from) continue;
    const kind = e.kind || (e.kind = kindOf(e));
    const end = e.o ? (domain?.[1] ?? e.e) : (e.e ?? e.s);
    let l, r, g;
    if(kind === 'spans'){
      // The context of the whole view, not a part of it (packBars' umbrellas).
      if(e.s <= view[0] && end >= view[1] && end - e.s > 2 * vSpan) continue;
      // Zoomed out over deep time, a bar across most of the view is context (Cenozoic in Humans).
      if(wide && Math.min(end, view[1]) - Math.max(e.s, view[0]) > 0.8 * vSpan) continue;
      const a = X(e.s), b = X(end);
      let s0 = Math.max(0, Math.min(width, a));
      let s1 = Math.max(0, Math.min(width, b));
      if(b < 0 || a > width) continue;
      if(s1 - s0 < 6) s1 = s0 + 6;
      l = s0 - 3; r = s1 + 3;
      g = { x0: s0, x1: s1, clipL: a < 0, clipR: b > width };
    } else {
      // Only events and lives get a duration line: a place, a group or a
      // species "lasting" to the present says nothing a line could show.
      const lasted = e.e != null && e.e > e.s && (kind === 'events' || kind === 'people') && !(e.o && kind !== 'people');
      const a = X(e.s);
      let b = lasted ? X(end) : a;
      if(b - a < 8) b = a;
      const bold = weightOf(e) === 'key';
      const av = kind === 'people' && e.im ? 19 : 0;
      const lw = Math.min(GEO.LABEL_MAX, measure(e.t, bold)) + av;
      const bar = b > a;
      l = bar ? a : a - 5;
      r = bar ? Math.max(b, a + 2 + lw) : a + 9 + lw;
      // Against the present (the right end of time) a label has nowhere to go
      // but left of its dot, or it runs off the map.
      let flip = false;
      if(!bar && xEnd != null && r > xEnd + 12){ flip = true; l = a - 9 - lw; r = a + 5; }
      if(r < 0 || l > width) continue;
      g = { x0: a, x1: b, l, r, lw, bar, flip };
    }
    const cap = (more.has(meta.lanes[li].key) ? 3 : 1) * caps[kind];
    const R = rows[li][kind];
    const ca = cellOf(l - (kind === 'spans' ? 0 : GEO.PAD / 2)), cb = cellOf(r + (kind === 'spans' ? 0 : GEO.PAD / 2));
    let row = -1;
    for(let k = 0; k < cap; k++){
      if(!R[k]) R[k] = new Uint8Array(cells);
      if(fits(R[k], ca, cb)){ row = k; break; }
    }
    if(row < 0){ left[li]++; continue; }
    take(R[row], ca, cb);
    placed[li]++;
    if(kind === 'spans') bars.push({ e, lane: li, row, ...g });
    else marks.push({ e, lane: li, kind, row, ...g });
  }

  // Stack: sections, their lanes, each lane's kinds. Pinned lanes stack in their own group.
  const usedRows = (li, kind) => { const R = rows[li][kind]; let n = 0; for(let k = 0; k < R.length; k++) if(R[k] && R[k].some((v) => v)) n = k + 1; return n; };
  const outSecs = [], outLanes = [];
  const kindTop = Array.from({ length: nL }, () => ({}));
  let y = 0, py = 0;
  const inDomain = (l) => (!domain || l.lo == null || (l.hi >= domain[0] && l.lo <= domain[1])) && (!wide || (l[deep.key] || 0) >= deep.min || pinned.has(l.key));
  // Deep time last when the range is human history, first otherwise.
  const secs = order ? order(meta.sections) : meta.sections;
  for(const s of secs){
    const lanesHere = meta.lanes.map((l, i) => [l, i]).filter(([l, i]) => l.section === s.key && inDomain(l) && (!hideEmpty || placed[i] + left[i] > 0));
    if(!lanesHere.length) continue;
    const isFolded = folded.has(s.key);
    const n = lanesHere.reduce((a, [l]) => a + l.n, 0);
    outSecs.push({ key: s.key, label: s.label, color: s.color, y, folded: isFolded, n });
    y += GEO.SEC;
    for(const [l, i] of lanesHere){
      const pin = pinned.has(l.key);
      if(isFolded && !pin) continue;
      let h = GEO.LAB;
      const tops = kindTop[i];
      let any = false;
      for(const kind of KINDS){
        const n = usedRows(i, kind);
        if(!n) continue;
        if(any) h += GEO.KGAP;
        tops[kind] = h;
        h += n * (kind === 'spans' ? GEO.BAR : GEO.ROW);
        any = true;
      }
      if(!any) h += GEO.EMPTY;
      h += GEO.GAP;
      const top = pin ? py : y;
      outLanes.push({ i, key: l.key, label: l.label, section: l.section, color: s.color, depth: l.depth, y: top, h, pinned: pin, n: l.n, placed: placed[i], left: left[i], topic: l.topic || null });
      if(pin) py += h; else y += h;
    }
  }
  const laneTop = new Map(outLanes.map((L) => [L.i, L]));
  const keepM = [], keepB = [];
  for(const m of marks){
    const L = laneTop.get(m.lane);
    if(!L) continue;
    m.y = L.y + kindTop[m.lane][m.kind] + m.row * GEO.ROW; m.pinned = L.pinned; m.color = L.color;
    keepM.push(m);
  }
  for(const b of bars){
    const L = laneTop.get(b.lane);
    if(!L) continue;
    b.y = L.y + kindTop[b.lane].spans + b.row * GEO.BAR; b.pinned = L.pinned; b.color = L.color;
    keepB.push(b);
  }
  return { sections: outSecs, lanes: outLanes, marks: keepM, bars: keepB, height: y, pinHeight: py };
}
