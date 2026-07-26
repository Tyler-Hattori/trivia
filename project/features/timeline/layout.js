/*
 * Layout: pure geometry. Takes the item array + current view state and produces
 * placed specs with absolute x/y. No DOM, no strings, no side effects.
 *
 * The one invariant everything else depends on: lane geometry is computed over
 * the FULL time extent, never over the visible window. Scrolling horizontally
 * therefore can never move anything vertically.
 */

import { laneColor, lowerBound } from './util.js';
import { laneValueOf } from './model.js';
import { PAD } from './scales.js';

export const GEO = {
  SECTION_H: 32,
  SECTION_GAP: 12,
  LANE_GAP: 6,
  LANE_PAD: 10,
  ROW_GAP: 8,
  ITEM_GAP: 8,
  STUB_H: 10,

  HEAT_H: 26,
  HEAT_BIN_PX: 6,

  DOT_H: 18,
  DOT_W: 10,
  CLUSTER_W: 22,
  CLUSTER_PITCH: 26,      // >= CLUSTER_W + gap, so clusters stay on one row

  CHIP_H: 48,
  CHIP_MIN_W: 86,
  CHIP_MAX_W: 200,

  CARD_W: 152,
  CARD_H: 170,
  TEXTCARD_W: 140,
  TEXTCARD_H: 64,

  DETAIL_W: 212,
  DETAIL_H: 262,
  DETAIL_TEXT_H: 150,

  SPAN_H: 24,
  TAG_INSET: 17,        // room reserved for the sticky lane tag
  SPAN_H_TIGHT: 12,
  SPAN_MIN_W: 6
};

/** Greedy first-fit into sub-rows. `specs` must already be sorted by x. */
function pack(specs, gap){
  const ends = [];
  for(const s of specs){
    let placed = false;
    for(let i = 0; i < ends.length; i++){
      if(s.x >= ends[i] + gap){
        s.row = i;
        ends[i] = s.x + s.w;
        placed = true;
        break;
      }
    }
    if(!placed){
      s.row = ends.length;
      ends.push(s.x + s.w);
    }
  }
  return Math.max(1, ends.length);
}

function chipWidth(label){
  const len = (label || '').length;
  return Math.round(Math.max(GEO.CHIP_MIN_W, Math.min(GEO.CHIP_MAX_W, len * 6.3 + 26)));
}

/* ---------- per-tier spec builders ---------- */

function spansOf(items, scale, tight, colors, dimOf){
  const h = tight ? GEO.SPAN_H_TIGHT : GEO.SPAN_H;
  return items.map(it => ({
    k: 'i' + it.id,
    kind: 'span',
    id: it.id,
    x: scale.x(it.start),
    w: Math.max(GEO.SPAN_MIN_W, (it.end - it.start) * scale.ppy),
    h,
    tight,
    col: colors,
    dim: dimOf(it)
  }));
}

function heatBins(items, scale, colors){
  const binYears = Math.max(1, Math.round(GEO.HEAT_BIN_PX / scale.ppy));
  const map = new Map();
  for(const it of items){
    const b = Math.floor(it.at / binYears);
    let e = map.get(b);
    if(!e){ e = { n: 0, lo: Infinity, hi: -Infinity }; map.set(b, e); }
    e.n++;
    if(it.at < e.lo) e.lo = it.at;
    if(it.at > e.hi) e.hi = it.at;
  }

  let peak = 1;
  for(const e of map.values()) if(e.n > peak) peak = e.n;

  const specs = [];
  for(const [b, e] of map){
    const y0 = b * binYears, y1 = y0 + binYears;
    specs.push({
      k: 'b' + b,
      kind: 'bin',
      id: null,
      x: scale.x(y0),
      w: Math.max(2, binYears * scale.ppy - 1),
      h: GEO.HEAT_H - 8,
      n: e.n,
      r0: y0, r1: y1,
      intensity: 0.22 + 0.78 * (e.n / peak),
      col: colors
    });
  }
  specs.sort((a, b) => a.x - b.x);
  return specs;
}

function dotClusters(items, scale, colors, dimOf){
  const sorted = [...items].sort((a, b) => a.at - b.at);
  const specs = [];
  let i = 0;
  while(i < sorted.length){
    const startX = scale.x(sorted[i].at);
    const group = [sorted[i]];
    let j = i + 1;
    while(j < sorted.length && scale.x(sorted[j].at) - startX < GEO.CLUSTER_PITCH){
      group.push(sorted[j]);
      j++;
    }
    const many = group.length > 1;
    const w = many ? GEO.CLUSTER_W : GEO.DOT_W;
    specs.push({
      k: many ? ('c' + group[0].id) : ('i' + group[0].id),
      kind: many ? 'cluster' : 'dot',
      id: many ? null : group[0].id,
      ids: many ? group.map(g => g.id) : null,
      x: startX - w / 2,
      w,
      h: GEO.DOT_H,
      n: group.length,
      r0: group[0].at,
      r1: group[group.length - 1].at,
      col: colors,
      dim: many ? false : dimOf(group[0])
    });
    i = j;
  }
  return specs;
}

function pointSpecs(items, scale, tier, colors, dimOf){
  const specs = [];
  for(const it of items){
    let w, h, kind;
    if(tier === 'chip'){
      kind = 'chip';
      w = chipWidth(it.label);
      h = GEO.CHIP_H;
    } else if(tier === 'card'){
      if(it.thumb){ kind = 'card'; w = GEO.CARD_W; h = GEO.CARD_H; }
      else { kind = 'textcard'; w = GEO.TEXTCARD_W; h = GEO.TEXTCARD_H; }
    } else {
      kind = 'detail';
      w = GEO.DETAIL_W;
      h = it.thumb ? GEO.DETAIL_H : GEO.DETAIL_TEXT_H;
    }
    const cx = scale.x(it.at);
    specs.push({
      k: 'i' + it.id,
      kind,
      id: it.id,
      x: cx - w / 2,
      w, h,
      col: colors,
      dim: dimOf(it)
    });
  }
  specs.sort((a, b) => a.x - b.x);
  return specs;
}

/* ---------- lane building ---------- */

function buildLane(laneItems, scale, tier, colors, dimOf, tagInset){
  const points = [];
  const spans = [];
  for(const it of laneItems){
    (it.kind === 'span' ? spans : points).push(it);
  }

  const tight = tier === 'heat' || tier === 'dot';
  let specs = [];

  if(points.length){
    if(tier === 'heat')      specs = specs.concat(heatBins(points, scale, colors));
    else if(tier === 'dot')  specs = specs.concat(dotClusters(points, scale, colors, dimOf));
    else                     specs = specs.concat(pointSpecs(points, scale, tier, colors, dimOf));
  }
  if(spans.length){
    specs = specs.concat(spansOf(spans, scale, tight, colors, dimOf));
  }

  specs.sort((a, b) => a.x - b.x);

  // Heat bins tile the axis edge to edge — they are one continuous strip, so
  // they must never be packed into sub-rows. Dots/clusters are pitched wider
  // than they are drawn, so they only need a hairline gap.
  const bins = [];
  const rest = [];
  for(const s of specs) (s.kind === 'bin' ? bins : rest).push(s);

  for(const s of bins) s.row = 0;
  const tightGap = tier === 'heat' || tier === 'dot';
  const restRows = rest.length ? pack(rest, tightGap ? 2 : GEO.ITEM_GAP) : 0;
  if(bins.length) for(const s of rest) s.row += 1;
  const rowCount = Math.max(1, (bins.length ? 1 : 0) + restRows);

  // Each sub-row is as tall as its tallest occupant, so mixed card/chip lanes
  // stay compact without clipping.
  const rowH = new Array(rowCount).fill(0);
  for(const s of specs) rowH[s.row] = Math.max(rowH[s.row], s.h);

  const rowTop = new Array(rowCount);
  let acc = 0;
  for(let i = 0; i < rowCount; i++){ rowTop[i] = acc; acc += rowH[i] + GEO.ROW_GAP; }

  let maxW = 0;
  for(const s of specs){
    s.yLocal = tagInset + GEO.LANE_PAD / 2 + rowTop[s.row];
    if(s.w > maxW) maxW = s.w;
  }

  return {
    specs,
    height: Math.max(GEO.HEAT_H + tagInset, tagInset + acc - GEO.ROW_GAP + GEO.LANE_PAD),
    maxW
  };
}

/**
 * @param {object} v  view state:
 *   items, order (dataset keys), dsMeta (key -> settings entry),
 *   activeFacet, dsOff (Set), collapsed (Set), selected (Map compound->Set),
 *   matched (Set|null), hideNonMatches (bool), pinned (Set), laneSort,
 *   scale, tier
 */
export function computeLayout(v){
  const { items, order, dsMeta, activeFacet, dsOff, collapsed, selected,
          matched, hideNonMatches, pinned, laneSort, scale, tier } = v;
  const maxLanes = v.maxLanes ?? Infinity;
  // Pinned lanes are a comparison strip, not a reading surface — they stay
  // compact so the sticky band never swallows the viewport.
  const pinTier = v.pinTier ?? tier;
  // Sticky lane tags sit inside the lane, so reserve their strip rather than
  // letting them cover the leftmost entry.
  const tagInset = v.laneTags ? GEO.TAG_INSET : 0;

  const dimOf = matched
    ? (it) => !matched.has(it.id)
    : () => false;

  // 1. Filter by dataset visibility, facet-value selection and (hide mode) search.
  const byDs = new Map();
  for(const it of items){
    if(dsOff.has(it.ds)) continue;
    if(hideNonMatches && matched && !matched.has(it.id)) continue;

    const facetKey = activeFacet[it.ds];
    const sel = selected.get(`${it.ds}:${facetKey}`);
    if(sel && sel.size && !sel.has(laneValueOf(it, facetKey))) continue;

    let arr = byDs.get(it.ds);
    if(!arr){ arr = []; byDs.set(it.ds, arr); }
    arr.push(it);
  }

  // 2. Group into lanes, in a stable order that does not depend on the viewport.
  const draft = [];
  for(const ds of order){
    const dsItems = byDs.get(ds);
    if(!dsItems || !dsItems.length) continue;

    const facetKey = activeFacet[ds];
    const laneMap = new Map();
    for(const it of dsItems){
      const val = laneValueOf(it, facetKey);
      let l = laneMap.get(val);
      if(!l){ l = []; laneMap.set(val, l); }
      l.push(it);
    }

    const dsColor = dsMeta[ds]?.color || '#64748b';
    const lanes = [...laneMap.entries()].map(([value, laneItems]) => {
      let first = Infinity, matchCount = 0;
      for(const it of laneItems){
        if(it.at < first) first = it.at;
        if(!matched || matched.has(it.id)) matchCount++;
      }
      return {
        id: `${ds}::${facetKey || '_'}::${value}`,
        ds, facetKey, value,
        items: laneItems,
        count: laneItems.length,
        matchCount,
        first,
        colors: laneColor(dsColor, value)
      };
    });

    // High-cardinality facets (film -> director, art -> artist) would otherwise
    // produce hundreds of one-item lanes and a canvas tens of thousands of
    // pixels tall. Keep the biggest lanes and roll the tail into one, labelled
    // with exactly what it absorbed — clicking it expands to the full set.
    let kept = lanes;
    if(Number.isFinite(maxLanes) && lanes.length > maxLanes){
      const byCount = [...lanes].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
      kept = byCount.slice(0, Math.max(1, maxLanes - 1));
      const tail = byCount.slice(Math.max(1, maxLanes - 1));

      const tailItems = [];
      let first = Infinity, matchCount = 0;
      for(const l of tail){
        tailItems.push(...l.items);
        if(l.first < first) first = l.first;
        matchCount += l.matchCount;
      }
      kept.push({
        id: `${ds}::${facetKey || '_'}::__rollup`,
        ds, facetKey,
        value: `${tail.length} smaller lanes`,
        items: tailItems,
        count: tailItems.length,
        matchCount,
        first,
        rolled: tail.length,
        colors: laneColor(dsColor, '__rollup')
      });
    }

    if(laneSort === 'time')       kept.sort((a, b) => a.first - b.first || a.value.localeCompare(b.value));
    else if(laneSort === 'count') kept.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    else                          kept.sort((a, b) => a.value.localeCompare(b.value, undefined, { numeric: true }));

    draft.push({ ds, lanes: kept, totalLanes: lanes.length });
  }

  // 3. Place. Pinned lanes get their own band above the scroller.
  const rows = [];        // section headers + lanes, ordered by y (rail + canvas read this)
  const lanes = [];       // visible, unpinned lanes only — the paint list
  const sections = [];
  const pinLanes = [];
  let y = 0;
  let pinY = 0;

  for(const group of draft){
    const isCollapsed = collapsed.has(group.ds);
    const secTop = y;
    const sectionRow = {
      type: 'section',
      ds: group.ds,
      y: secTop,
      h: GEO.SECTION_H,
      collapsed: isCollapsed,
      laneCount: group.lanes.length,
      totalLanes: group.totalLanes,
      count: group.lanes.reduce((n, l) => n + l.count, 0)
    };
    rows.push(sectionRow);
    sections.push(sectionRow);
    y += GEO.SECTION_H;

    let alt = false;
    for(const lane of group.lanes){
      lane.alt = (alt = !alt);
      const isPinned = pinned.has(lane.id);
      const isStub = hideNonMatches && lane.count === 0;

      if(isCollapsed && !isPinned) continue;

      if(isStub){
        lane.specs = [];
        lane.maxW = 0;
        lane.h = GEO.STUB_H;
        lane.stub = true;
      } else {
        const built = buildLane(
          lane.items, scale, isPinned ? pinTier : tier, lane.colors, dimOf,
          isPinned ? 0 : tagInset
        );
        lane.specs = built.specs;
        lane.maxW = built.maxW;
        lane.h = built.height;
        lane.stub = false;
      }

      if(isPinned){
        lane.y = pinY;
        lane.pinned = true;
        pinY += lane.h + GEO.LANE_GAP;
        pinLanes.push(lane);
      } else {
        lane.y = y;
        lane.pinned = false;
        y += lane.h + GEO.LANE_GAP;
        lanes.push(lane);
        rows.push({ type: 'lane', lane, y: lane.y, h: lane.h });
      }
    }

    y += GEO.SECTION_GAP;
    sectionRow.groupBottom = y;
  }

  return {
    rows,
    lanes,
    sections,
    pinLanes,
    pinH: pinLanes.length ? pinY : 0,
    contentH: Math.max(y + 24, 1)
  };
}

/* ---------- window queries used by the virtualiser ---------- */

/** Indices [from,to) of `rows` intersecting the vertical window. */
export function rowsInWindow(rows, yMin, yMax){
  let from = lowerBound(rows, yMin, r => r.y + r.h);
  let to = from;
  while(to < rows.length && rows[to].y < yMax) to++;
  return [from, to];
}

/** Specs of one lane intersecting the horizontal window. */
export function specsInWindow(lane, xMin, xMax, out){
  const specs = lane.specs;
  if(!specs.length) return out;
  // Start far enough left that the widest possible item still overlaps.
  let i = lowerBound(specs, xMin - lane.maxW, s => s.x);
  for(; i < specs.length; i++){
    const s = specs[i];
    if(s.x > xMax) break;
    if(s.x + s.w >= xMin) out.push(s);
  }
  return out;
}

/** Total pixel width of the laid-out canvas. */
export function contentWidthOf(minYear, maxYear, ppy){
  return PAD * 2 + Math.max(1, maxYear - minYear) * ppy;
}
