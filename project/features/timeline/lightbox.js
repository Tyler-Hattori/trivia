/*
 * Detail view. Keeps the per-dataset layout hint from settings.js
 * (`portrait` | `wide` | `split`) and adds keyboard navigation through the
 * lane the item was opened from.
 */

import { esc, excerptToHtml } from './util.js';

export function createLightbox(doc, host, dsMeta, onCenter){
  const el = doc.createElement('div');
  el.id = 'lb';
  host.appendChild(el);

  let siblings = [];
  let cursor = -1;
  let open = false;

  function layoutFor(item){
    const cfg = dsMeta[item.ds] || {};
    if(cfg.layout === 'split') return { cls: 'split', width: 1120, imgMax: null };
    if(cfg.layout === 'wide')  return { cls: 'stack', width: 860,  imgMax: 300 };
    return { cls: 'stack', width: 720, imgMax: 440 };
  }

  function paint(){
    const item = siblings[cursor];
    if(!item) return;

    const L = layoutFor(item);
    const meta = [item.subtitle, item.misc].filter(Boolean).join(' · ');
    const img = item.full
      ? `<div class="imgwrap"${L.imgMax ? ` style="max-height:${L.imgMax}px;min-height:180px"` : ''}>` +
        `<img src="${esc(item.full)}" alt=""></div>`
      : '';

    el.innerHTML =
      `<div class="lbcard ${L.cls}" style="width:min(${L.width}px,95vw)">` +
        `<button id="lbClose" title="Close (Esc)">✕</button>` +
        img +
        `<div class="txt">` +
          `<div class="h">${esc(item.label)}</div>` +
          (meta ? `<div class="m">${esc(meta)}</div>` : '') +
          `<div class="y">${esc(item.displayYear)}</div>` +
          `<div class="body">${excerptToHtml(item.excerpt) || '<em style="color:#6b7280">No excerpt yet.</em>'}</div>` +
          `<div class="foot">` +
            `<button class="lbbtn" data-nav="-1"${cursor <= 0 ? ' disabled' : ''}>← Prev</button>` +
            `<button class="lbbtn" data-nav="1"${cursor >= siblings.length - 1 ? ' disabled' : ''}>Next →</button>` +
            `<button class="lbbtn" data-center="1">Center in timeline</button>` +
            `<span class="lbcount">${cursor + 1} / ${siblings.length}</span>` +
          `</div>` +
        `</div>` +
      `</div>`;
  }

  function show(item, laneItems){
    siblings = (laneItems && laneItems.length ? [...laneItems] : [item]).sort((a, b) => a.at - b.at);
    cursor = Math.max(0, siblings.findIndex(s => s.id === item.id));
    open = true;
    el.classList.add('open');
    paint();
  }

  function hide(){
    open = false;
    el.classList.remove('open');
    el.innerHTML = '';
  }

  function step(d){
    const n = cursor + d;
    if(n < 0 || n >= siblings.length) return;
    cursor = n;
    paint();
  }

  el.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if(nav){ e.stopPropagation(); step(Number(nav.dataset.nav)); return; }
    if(e.target.closest('[data-center]')){
      e.stopPropagation();
      const item = siblings[cursor];
      hide();
      if(item) onCenter(item);
      return;
    }
    if(e.target.closest('#lbClose') || e.target === el) hide();
  });

  return {
    show,
    hide,
    step,
    get isOpen(){ return open; },
    get current(){ return siblings[cursor] || null; }
  };
}
