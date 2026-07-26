/*
 * Timeline furniture: the ruler, the era context band, and the minimap.
 * All three are cheap enough to rebuild from a string each frame because each
 * only ever covers the visible window (ruler/era) or a fixed pixel budget (minimap).
 */

import { tickStep, majorStep } from './scales.js';
import { esc, fmtYear, fmtRange, laneColor } from './util.js';
import { GEO } from './layout.js';

/* ---------- ruler ---------- */

export function rulerHTML(scale, minYear, maxYear, xMin, xMax){
  const step = tickStep(scale.ppy);
  const maj = majorStep(step);

  const from = Math.max(minYear, scale.year(xMin));
  const to = Math.min(maxYear, scale.year(xMax));

  let html = '';

  const firstTick = Math.ceil(from / step) * step;
  for(let y = firstTick; y <= to; y += step){
    const x = scale.x(y);
    const isMaj = (((y % maj) + maj) % maj) === 0;
    html += `<div class="tick${isMaj ? ' maj' : ''}" style="left:${x.toFixed(1)}px"></div>`;
    html += `<div class="ticklab" style="left:${x.toFixed(1)}px">${fmtYear(y)}</div>`;
  }

  const firstMaj = Math.floor(from / maj) * maj;
  for(let y = firstMaj; y <= to; y += maj){
    // Clamp to the data's own extent — an era label reading "0 – 5000" on a
    // dataset that stops in 2030 is worse than no label.
    const a = Math.max(y, minYear);
    const bnd = Math.min(y + maj, maxYear);
    if(bnd - a < maj * 0.15) continue;
    const mid = scale.x((a + bnd) / 2);
    if(mid < xMin - 200 || mid > xMax + 200) continue;
    if((bnd - a) * scale.ppy < 80) continue;         // no room for the label
    html += `<div class="eralab" style="left:${mid.toFixed(1)}px">${esc(fmtRange(a, bnd))}</div>`;
  }

  return html;
}

/* ---------- era context band ---------- */

/**
 * Long spans from one dataset, packed into a short sticky band so you always
 * know which era the events below belong to. Only spans wide enough to read at
 * the current zoom are included; the count of the rest is reported so nothing
 * is silently dropped.
 */
export function buildEraLanes(items, ds, scale, dsColor, maxRows = 3){
  const minPx = 26;
  const eligible = [];
  let omitted = 0;

  for(const it of items){
    if(it.ds !== ds || it.kind !== 'span') continue;
    const w = (it.end - it.start) * scale.ppy;
    if(w < minPx){ omitted++; continue; }
    eligible.push(it);
  }

  eligible.sort((a, b) => a.start - b.start);

  const ends = [];
  const rows = [];
  for(const it of eligible){
    const x = scale.x(it.start);
    const w = Math.max(minPx, (it.end - it.start) * scale.ppy);
    let row = -1;
    for(let i = 0; i < ends.length; i++){
      if(x >= ends[i] + 4){ row = i; ends[i] = x + w; break; }
    }
    if(row === -1){
      if(ends.length >= maxRows){ omitted++; continue; }
      row = ends.length;
      ends.push(x + w);
    }
    rows.push({ it, x, w, row });
  }

  const rowCount = Math.max(1, ends.length);
  const H = GEO.SPAN_H;
  const specs = rows.map(({ it, x, w, row }) => ({
    k: 'i' + it.id,
    kind: 'span',
    id: it.id,
    x, w,
    h: H,
    yLocal: 4 + row * (H + 4),
    tight: false
  })).sort((a, b) => a.x - b.x);

  let maxW = 0;
  for(const s of specs) if(s.w > maxW) maxW = s.w;

  const lane = {
    id: 'era::' + ds,
    ds,
    value: ds,
    y: 0,
    h: rowCount * (H + 4) + 6,
    specs,
    maxW,
    stub: false,
    colors: laneColor(dsColor, ds)
  };

  return { lanes: [lane], height: lane.h, omitted, shown: specs.length };
}

/* ---------- minimap ---------- */

/**
 * Stacked density over the full extent, one column per device pixel bucket.
 * Redrawn only when the filter set or the dataset selection changes.
 */
export function drawMinimap(canvasEl, items, dsMeta, order, dsOff, matched, minYear, maxYear){
  const cssW = canvasEl.clientWidth || 1;
  const cssH = canvasEl.clientHeight || 1;
  const dpr = Math.min(2, canvasEl.ownerDocument.defaultView.devicePixelRatio || 1);

  canvasEl.width = Math.max(1, Math.round(cssW * dpr));
  canvasEl.height = Math.max(1, Math.round(cssH * dpr));

  const ctx = canvasEl.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const bins = Math.max(1, Math.floor(cssW));
  const span = Math.max(1, maxYear - minYear);
  const visible = order.filter(k => !dsOff.has(k));
  if(!visible.length) return;

  const idx = new Map(visible.map((k, i) => [k, i]));
  const all = new Float32Array(bins * visible.length);
  const hit = new Float32Array(bins * visible.length);

  for(const it of items){
    const di = idx.get(it.ds);
    if(di === undefined) continue;
    const b0 = Math.max(0, Math.min(bins - 1, Math.floor(((it.lo - minYear) / span) * bins)));
    const b1 = Math.max(0, Math.min(bins - 1, Math.floor(((it.hi - minYear) / span) * bins)));
    const isHit = !matched || matched.has(it.id);
    for(let b = b0; b <= b1; b++){
      all[b * visible.length + di] += 1;
      if(isHit) hit[b * visible.length + di] += 1;
    }
  }

  let peak = 1;
  for(let b = 0; b < bins; b++){
    let t = 0;
    for(let d = 0; d < visible.length; d++) t += all[b * visible.length + d];
    if(t > peak) peak = t;
  }

  const usable = cssH - 14;

  const paintPass = (arr, alpha) => {
    ctx.globalAlpha = alpha;
    for(let b = 0; b < bins; b++){
      let y = cssH - 14;
      for(let d = 0; d < visible.length; d++){
        const n = arr[b * visible.length + d];
        if(!n) continue;
        const h = (n / peak) * usable;
        ctx.fillStyle = dsMeta[visible[d]]?.color || '#94a3b8';
        ctx.fillRect(b, y - h, 1, h);
        y -= h;
      }
    }
    ctx.globalAlpha = 1;
  };

  paintPass(all, matched ? 0.16 : 0.85);
  if(matched) paintPass(hit, 0.95);
}

export function minimapTicks(minYear, maxYear, width){
  const span = Math.max(1, maxYear - minYear);
  const step = tickStep(width / span, 130);
  const first = Math.ceil(minYear / step) * step;
  let html = '';
  for(let y = first; y <= maxYear; y += step){
    const pct = ((y - minYear) / span) * 100;
    if(pct < 2 || pct > 98) continue;
    html += `<span style="left:${pct.toFixed(3)}%">${fmtYear(y)}</span>`;
  }
  return html;
}
