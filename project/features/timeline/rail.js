/*
 * The left rail: a lane index that is also the filter surface.
 *
 * It shares the CSS grid rows with the stage, and its inner container is
 * translated by the same scrollTop as the canvas — so a rail row is always at
 * exactly the vertical position of the lane it names.
 */

import { esc } from './util.js';
import { rowsInWindow } from './layout.js';

export function paintRail(innerEl, layout, dsMeta, selected, pinned, matched, scrollTop, vh){
  const yMin = scrollTop - 200;
  const yMax = scrollTop + vh + 200;
  const [from, to] = rowsInWindow(layout.rows, yMin, yMax);

  // A band can be thousands of pixels tall, so a label pinned to its top edge is
  // off-screen for most of the band's height — the rail just looks empty. Slide
  // the label down to follow the viewport instead, staying inside its own row.
  // This positions chrome only; lane geometry is untouched, so invariant 1 holds.
  const stick = (row, labelH) =>
    Math.max(0, Math.min(scrollTop + 4 - row.y, row.h - labelH));

  let html = '';

  for(let i = from; i < to; i++){
    const row = layout.rows[i];

    if(row.type === 'section'){
      const cfg = dsMeta[row.ds] || {};
      html += `<div class="rrow section" data-sec="${esc(row.ds)}" ` +
        `style="top:${row.y}px;height:${row.h}px">` +
        `<span class="caret">${row.collapsed ? '▸' : '▾'}</span>` +
        `<span class="sw" style="width:9px;height:9px;border-radius:50%;background:${esc(cfg.color || '#94a3b8')}"></span>` +
        `<span class="nm">${esc(cfg.title || row.ds)}</span>` +
        `<span class="n">${row.totalLanes > row.laneCount ? row.totalLanes + '↓' : row.laneCount} · ${row.count}</span>` +
        `</div>`;
      continue;
    }

    const band = row.lanes;

    // Packed band: list its lanes as chips, each its own filter target.
    if(band.length > 1){
      html += `<div class="rrow band" style="top:${row.y}px;height:${row.h}px;` +
        `padding-top:${stick(row, 26)}px">` +
        band.map(l => {
          const s = selected.get(`${l.ds}:${l.facetKey}`);
          const on = !!(s && s.has(l.value));
          const none = matched && l.matchCount === 0;
          const attr = l.rolled
            ? `data-expand="${esc(l.ds)}"`
            : `data-lane="${esc(l.id)}"`;
          return `<span class="lchip${on ? ' sel' : ''}${none ? ' nomatch' : ''}` +
            `${l.rolled ? ' rollup' : ''}" ${attr} title="${esc(l.value)}" ` +
            `style="border-left-color:${l.colors.solid}">` +
            `<span class="sw" style="background:${l.colors.solid}"></span>` +
            `<span class="nm">${esc(l.value)}</span>` +
            `<span class="n">${matched ? l.matchCount + '/' : ''}${l.count}</span>` +
            `</span>`;
        }).join('') +
        `</div>`;
      continue;
    }

    const lane = band[0];
    const sel = selected.get(`${lane.ds}:${lane.facetKey}`);
    const isSel = !!(sel && sel.has(lane.value));
    const isPinned = pinned.has(lane.id);
    const noMatch = matched && lane.matchCount === 0;

    if(lane.rolled){
      html += `<div class="rrow lane rollup" data-expand="${esc(lane.ds)}" ` +
        `title="${lane.rolled} smaller lanes folded together — click to show them all" ` +
        `style="top:${row.y}px;height:${row.h}px;padding-top:${stick(row, 22)}px;` +
        `border-left-color:${lane.colors.solid};border-left-style:dashed">` +
        `<span class="sw" style="background:${lane.colors.solid};opacity:.5"></span>` +
        `<span class="nm">${esc(lane.value)}</span>` +
        `<span class="n">${matched ? lane.matchCount + '/' : ''}${lane.count} ▸</span>` +
        `</div>`;
      continue;
    }

    html += `<div class="rrow lane${isSel ? ' sel' : ''}${noMatch ? ' nomatch' : ''}" ` +
      `data-lane="${esc(lane.id)}" title="${esc(lane.value)}" ` +
      `style="top:${row.y}px;height:${row.h}px;padding-top:${stick(row, 22)}px;` +
      `border-left-color:${lane.colors.solid};` +
      `background:${isSel ? lane.colors.soft : 'transparent'}">` +
      `<span class="sw" style="background:${lane.colors.solid}"></span>` +
      `<span class="nm">${esc(lane.value)}</span>` +
      `<span class="n">${matched ? lane.matchCount + '/' : ''}${lane.count}</span>` +
      `<button class="pin${isPinned ? ' on' : ''}" data-pin="${esc(lane.id)}" ` +
      `title="${isPinned ? 'Unpin lane' : 'Pin lane to the top'}">◆</button>` +
      `</div>`;
  }

  innerEl.innerHTML = html;
}

/** Rail rows for the pinned band, aligned to the pinned lanes' own y offsets. */
export function paintPinRail(innerEl, pinLanes){
  let html = '';
  for(const lane of pinLanes){
    html += `<div class="rrow lane sel" data-pin="${esc(lane.id)}" ` +
      `style="top:${lane.y}px;height:${lane.h}px;border-left-color:${lane.colors.solid}">` +
      `<span class="sw" style="background:${lane.colors.solid}"></span>` +
      `<span class="nm">${esc(lane.value)}</span>` +
      `<span class="pin on">◆</span>` +
      `</div>`;
  }
  innerEl.innerHTML = html;
}
