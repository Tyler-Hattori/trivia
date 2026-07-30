/*
 * The DOM layer: image cards and the hover preview.
 *
 * Only entries that won a slot from `packLabels` reach this file, so the node
 * count stays in the low hundreds regardless of corpus size. Nodes are pooled and
 * recycled, positioned with `transform` alone, and updated field by field only
 * when a field actually changed — a card that stays put across a pan does no work.
 *
 * Two of the bugs this rework was asked to fix live here, and both are fixed
 * structurally rather than patched:
 *
 *   Cropped images. Every picture is `object-fit: contain` on a matte, at every
 *   size — card, hover preview and detail view. `cover` was slicing a horizontal
 *   band out of portraits, which is unacceptable for artwork, and no amount of
 *   per-dataset aspect tuning fixes it. Contain wastes some space; that is the
 *   correct trade for a timeline about pictures.
 *
 *   Doubled outlines. A card has exactly one edge: its border. Selection and
 *   hover are expressed as a box-shadow ring *outside* that border, never as a
 *   second border or an outline. See styles.js.
 */

import { thumbUrl, fullUrl } from '../../utils/helpers.js';
import { fmtYear } from './scales.js';

/** Requested image width per tier, snapped by `thumbUrl` to a width Wikimedia serves. */
const IMG_W = { card: 250, detail: 330, tip: 330 };

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A pooled layer of absolutely positioned cards.
 *
 * `sync` is called every frame with the current placements. It walks the pool
 * once, so the cost is proportional to the number of cards on screen, not to the
 * corpus.
 */
export function createCardLayer(root, { onOpen } = {}){
  // The atlas runs in a popup, so nodes must be created by THAT document.
  // `document` here is the opener's, and a node built there is a foreign node:
  // browsers auto-adopt it on append, but its `ownerDocument` stays wrong, which
  // breaks anything that later reaches through it.
  const D = root.ownerDocument;
  const layer = D.createElement('div');
  layer.className = 'cardlayer';
  root.appendChild(layer);

  const pool = [];

  function acquire(k){
    if(pool[k]) return pool[k];
    const el = D.createElement('article');
    el.className = 'c';
    el.innerHTML =
      '<div class="pic"><img alt="" loading="lazy" decoding="async"></div>' +
      '<div class="cap"><div class="t"></div><div class="y"></div></div>' +
      '<p class="ex"></p>';
    layer.appendChild(el);
    pool[k] = el;
    return el;
  }

  function sync(A, placements, { filter, dimMode, selected, hover, details }){
    let k = 0;

    for(const p of placements){
      if(p.tier !== 'card' && p.tier !== 'detail') continue;

      const i = p.i;
      const matched = !filter || filter.flags[i];
      if(!matched && !dimMode) continue;

      const el = acquire(k++);
      const st = el._st || (el._st = {});

      // --- position ---------------------------------------------------------
      // Rounded, because a card on a fractional pixel renders its text blurry.
      const tx = Math.round(p.x), ty = Math.round(p.y);
      if(st.tx !== tx || st.ty !== ty){
        el.style.transform = `translate(${tx}px,${ty}px)`;
        st.tx = tx; st.ty = ty;
      }
      if(st.w !== p.w || st.h !== p.h){
        el.style.width = `${p.w}px`;
        el.style.height = `${p.h}px`;
        st.w = p.w; st.h = p.h;
      }

      // --- content ----------------------------------------------------------
      if(st.i !== i){
        const t = el.querySelector('.t');
        const y = el.querySelector('.y');
        t.textContent = A.title[i];
        y.textContent = A.yearText[i] || fmtYear(A.x0[i]);
        el.title = A.subtitle[i] ? `${A.title[i]} — ${A.subtitle[i]}` : A.title[i];
        el.dataset.i = String(i);

        const img = el.querySelector('img');
        const src = A.image[i] ? thumbUrl(A.image[i], IMG_W[p.tier] || 250) : '';
        if(src){
          img.src = src;
          el.classList.remove('noimg');
        } else {
          img.removeAttribute('src');
          el.classList.add('noimg');
        }

        el.style.setProperty('--hue', A.color[i]);
        st.i = i;
        st.ex = null;
      }

      // Excerpts arrive after first paint, so fill them in whenever they show up.
      const wantEx = p.tier === 'detail';
      const ex = wantEx ? (details?.[A.id[i]]?.excerpt || '') : '';
      if(st.ex !== ex){
        el.querySelector('.ex').textContent = ex;
        st.ex = ex;
      }
      el.classList.toggle('withex', wantEx && !!ex);

      // --- state ------------------------------------------------------------
      const cls = `c${p.tier === 'detail' ? ' big' : ''}` +
                  `${i === selected ? ' sel' : ''}` +
                  `${i === hover ? ' hov' : ''}` +
                  `${matched ? '' : ' dimmed'}` +
                  `${A.image[i] ? '' : ' noimg'}`;
      if(st.cls !== cls){ el.className = cls; st.cls = cls; }

      if(el.style.display === 'none') el.style.display = '';
    }

    // Retire the tail rather than removing nodes — the pool is the point.
    for(let j = k; j < pool.length; j++){
      if(pool[j].style.display !== 'none'){
        pool[j].style.display = 'none';
        pool[j]._st = {};
      }
    }
  }

  // One delegated listener for the whole layer. Per-card handlers were the
  // original engine's bottleneck: every zoom rewired hundreds of nodes.
  layer.addEventListener('click', (e) => {
    const el = e.target.closest('.c');
    if(el && el.dataset.i) onOpen?.(Number(el.dataset.i));
  });

  return { layer, sync, clear: () => { for(const el of pool) el.style.display = 'none'; } };
}

// ---------------------------------------------------------------------------
// Hover preview
// ---------------------------------------------------------------------------

/**
 * The floating preview.
 *
 * The user asked for the card to appear on hover "even at zoom out", so this is
 * available at every tier — at dot zoom it is the only way to read an entry, and
 * it means the zoomed-out map is browsable rather than just decorative.
 *
 * Positioned to stay fully on screen, flipping to the other side of the cursor
 * near an edge instead of being clipped.
 */
export function createTip(root){
  const D = root.ownerDocument;
  const win = D.defaultView;
  const tip = D.createElement('div');
  tip.className = 'tip';
  tip.innerHTML =
    '<div class="tpic"><img alt="" decoding="async"></div>' +
    '<div class="tbody">' +
      '<div class="tt"></div><div class="ts"></div><div class="ty"></div>' +
      '<p class="tex"></p><div class="ttopics"></div>' +
    '</div>';
  root.appendChild(tip);

  let shown = -1;

  function show(A, i, mx, my, { details, cluster } = {}){
    if(i < 0){ hide(); return; }

    if(shown !== i){
      shown = i;
      tip.querySelector('.tt').textContent = A.title[i];
      tip.querySelector('.ts').textContent = A.subtitle[i] || '';
      tip.querySelector('.ty').textContent =
        (A.yearText[i] || fmtYear(A.x0[i])) + (cluster ? `  ·  ${cluster}` : '');

      const img = tip.querySelector('img');
      const pic = tip.querySelector('.tpic');
      if(A.image[i]){
        img.src = thumbUrl(A.image[i], IMG_W.tip);
        pic.style.display = '';
      } else {
        img.removeAttribute('src');
        pic.style.display = 'none';
      }

      const ex = details?.[A.id[i]]?.excerpt || '';
      tip.querySelector('.tex').textContent = ex.length > 320 ? ex.slice(0, 320).trim() + '…' : ex;

      tip.querySelector('.ttopics').innerHTML =
        (A.topics[i] || []).slice(0, 5).map((t) => `<span>${esc(t)}</span>`).join('');

      tip.style.setProperty('--hue', A.color[i]);
      tip.classList.add('on');
    }

    // Measure after content is set, so the flip decision uses the real height.
    const w = tip.offsetWidth || 300;
    const h = tip.offsetHeight || 200;
    const pad = 14;
    let x = mx + pad;
    let y = my + pad;
    if(x + w > win.innerWidth - 6) x = mx - w - pad;
    if(y + h > win.innerHeight - 6) y = Math.max(6, my - h - pad);
    tip.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
  }

  function hide(){
    if(shown !== -1){ shown = -1; tip.classList.remove('on'); }
  }

  return { show, hide, el: tip };
}

export { esc, fullUrl, thumbUrl };
