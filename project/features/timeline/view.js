/*
 * The virtualised canvas renderer.
 *
 * Only nodes intersecting the viewport (plus a margin) exist in the DOM. On
 * every frame we compute the wanted key set, diff it against what is live, and
 * recycle retired nodes through a per-kind pool. Nothing is ever re-parsed from
 * an HTML string unless its content actually changed, and positioning is pure
 * `transform`, so scrolling never triggers layout of the whole tree.
 */

import { esc, truncate } from './util.js';
import { GEO, rowsInWindow, specsInWindow } from './layout.js';

const MARGIN_X = 400;
const MARGIN_Y = 320;
const TAG_W = 120;        // approximate lane-tag width, used to keep it in its lane

function itemHTML(spec, it){
  switch(spec.kind){
    case 'card':
      // Image-led: the picture owns the card and the caption is trimmed to a
      // title and a year. The subtitle still reaches the reader through the
      // hover tooltip and the lightbox, so nothing is actually lost.
      return `<div class="card"><div class="bar"></div>` +
        `<div class="ph"><img src="${esc(it.thumb)}" loading="lazy" decoding="async" alt=""></div>` +
        `<div class="body"><div class="t">${esc(it.label)}</div>` +
        `<div class="y">${esc(it.displayYear)}</div></div></div>`;

    case 'textcard':
      return `<div class="chip"><div class="body">` +
        `<div class="t">${esc(it.label)}</div>` +
        (it.subtitle ? `<div class="y">${esc(truncate(it.subtitle, 26))}</div>` : '') +
        `<div class="y">${esc(it.displayYear)}</div></div></div>`;

    case 'chip':
      return `<div class="chip"><div class="body">` +
        `<div class="t">${esc(it.label)}</div>` +
        `<div class="y">${esc(it.displayYear)}</div></div></div>`;

    case 'detail':
      return `<div class="card detail"><div class="bar"></div>` +
        (it.thumb ? `<div class="ph"><img src="${esc(it.thumb)}" loading="lazy" decoding="async" alt=""></div>` : '') +
        `<div class="body"><div class="t">${esc(it.label)}</div>` +
        (it.subtitle ? `<div class="s">${esc(it.subtitle)}</div>` : '') +
        `<div class="y">${esc(it.displayYear)}</div>` +
        (it.excerptText ? `<div class="x">${esc(truncate(it.excerptText, 260))}</div>` : '') +
        `</div></div>`;

    case 'span':
      return spec.tight ? '' :
        `<span class="sd"></span><span class="t">${esc(it.label)}</span>`;

    case 'cluster':
      return String(spec.n);

    default:
      return '';
  }
}

/** Content signature — when this is unchanged a recycled node keeps its markup. */
function contentKey(spec){
  return spec.kind + ':' + (spec.id != null ? spec.id : (spec.n + '@' + Math.round(spec.x)));
}

export function createCanvasView(doc, canvasEl){
  const live = new Map();     // key -> { el, spec }
  const pool = new Map();     // kind -> el[]

  // Some dataset image URLs are dead. `error` does not bubble, so listen in the
  // capture phase and let the card fall back to its text-only form. The holder
  // is marked too, otherwise an empty matte is left where the picture was.
  canvasEl.addEventListener('error', (e) => {
    const t = e.target;
    if(!t || t.tagName !== 'IMG') return;
    t.classList.add('failed');
    const ph = t.closest('.ph');
    if(ph) ph.classList.add('failed');
  }, true);

  function take(kind){
    const p = pool.get(kind);
    if(p && p.length) return p.pop();
    const el = doc.createElement('div');
    return el;
  }

  function give(kind, el){
    let p = pool.get(kind);
    if(!p){ p = []; pool.set(kind, p); }
    if(p.length < 160){                 // bounded pool; beyond this let GC have them
      el.style.display = 'none';
      p.push(el);
    } else {
      el.remove();
    }
  }

  function clear(){
    for(const { el } of live.values()) el.remove();
    // Pooled nodes are still attached (hidden) — detach them too, or they
    // accumulate in the canvas every time the tier changes.
    for(const list of pool.values()) for(const el of list) el.remove();
    live.clear();
    pool.clear();
  }

  /**
   * @param {object} p
   *   layout, itemsById, dsMeta, scrollLeft, scrollTop, vw, vh, contentW, laneTags
   */
  function paint(p){
    const { layout, itemsById, dsMeta, scrollLeft, scrollTop, vw, vh, contentW } = p;

    const yMin = scrollTop - MARGIN_Y;
    const yMax = scrollTop + vh + MARGIN_Y;
    const xMin = scrollLeft - MARGIN_X;
    const xMax = scrollLeft + vw + MARGIN_X;

    const want = new Map();
    const bandW = Math.min(contentW, vw + 2);
    const scratch = [];

    const [from, to] = rowsInWindow(layout.rows, yMin, yMax);

    for(let i = from; i < to; i++){
      const row = layout.rows[i];

      if(row.type === 'section'){
        want.set('S:' + row.ds, {
          kind: 'secband',
          cls: 'secband',
          x: scrollLeft, y: row.y, w: bandW, h: row.h,
          ck: 'sec:' + row.ds,
          html: '',
          row
        });
        continue;
      }

      // A row is a band: one lane when packing is off, several that never
      // overlap in time when it is on.
      const band = row.lanes;

      want.set('L:' + band[0].id, {
        kind: 'laneband',
        cls: 'laneband' + (band[0].alt ? ' alt' : ''),
        x: scrollLeft, y: row.y, w: bandW, h: row.h,
        ck: 'lb',
        html: ''
      });

      for(const lane of band){
        const ext = lane.ext;
        if(ext && (ext.x1 < xMin || ext.x0 > xMax)) continue;   // lane offscreen

        if(p.laneTags && !lane.stub){
          // Sticky to the viewport's left edge, but clamped inside the lane's
          // own span — so in a shared band the tag always names the lane you
          // are actually looking at rather than whichever one sorted first.
          const tagX = ext
            ? Math.min(Math.max(scrollLeft, ext.x0), Math.max(ext.x0, ext.x1 - TAG_W))
            : scrollLeft;
          // Same idea vertically: a tall band would otherwise keep its tag above
          // the viewport for most of the band's height.
          const tagY = Math.max(lane.y + 2, Math.min(scrollTop + 4, lane.y + row.h - 20));
          want.set('T:' + lane.id, {
            kind: 'lanetag',
            cls: 'lanetag',
            x: tagX, y: tagY, w: null, h: null,
            borderColor: lane.colors.solid,
            ck: 'tag:' + lane.id,
            html: esc(lane.value)
          });
        }

        if(lane.stub) continue;

        scratch.length = 0;
        specsInWindow(lane, xMin, xMax, scratch);

        for(const spec of scratch){
          const it = spec.id != null ? itemsById[spec.id] : null;
          want.set(lane.id + '|' + spec.k, { kind: 'item', spec, it, lane });
        }
      }
    }

    /* retire */
    for(const [key, rec] of live){
      if(!want.has(key)){
        give(rec.kindTag, rec.el);
        live.delete(key);
      }
    }

    /* enter / update */
    for(const [key, w] of want){
      let rec = live.get(key);

      if(w.kind === 'item'){
        const { spec, it, lane } = w;
        const kindTag = spec.kind;
        const ck = contentKey(spec);

        if(!rec){
          const el = take(kindTag);
          el.style.display = '';
          rec = { el, kindTag, ck: null, cls: null };
          live.set(key, rec);
          canvasEl.appendChild(el);
        }

        // Hover and click handlers resolve back to these through data-k.
        rec.spec = spec;
        rec.lane = lane;
        rec.item = it;

        const cls = 'it ' + spec.kind + (spec.dim ? ' dim' : '') + (spec.tight ? ' tight' : '');
        if(rec.cls !== cls){ rec.el.className = cls; rec.cls = cls; }

        if(rec.ck !== ck){
          rec.el.innerHTML = itemHTML(spec, it);
          rec.ck = ck;
        }

        const s = rec.el.style;
        s.setProperty('--c', lane.colors.solid);
        s.setProperty('--bd', lane.colors.line);
        s.setProperty('--soft', lane.colors.soft);
        s.setProperty('--line2', lane.colors.line);

        let y = lane.y + spec.yLocal;
        let h = spec.h;
        if(spec.kind === 'bin'){
          const barH = Math.max(3, Math.round(spec.intensity * spec.h));
          y += spec.h - barH;
          h = barH;
          s.opacity = (0.35 + 0.65 * spec.intensity).toFixed(2);
        } else if(s.opacity){
          s.opacity = '';
        }

        s.width = spec.w + 'px';
        s.height = h + 'px';
        s.transform = `translate3d(${Math.round(spec.x)}px,${Math.round(y)}px,0)`;

        if(spec.id != null) rec.el.dataset.id = String(spec.id);
        else if(rec.el.dataset.id) delete rec.el.dataset.id;
        rec.el.dataset.k = key;

      } else {
        const kindTag = w.kind;
        if(!rec){
          const el = take(kindTag);
          el.style.display = '';
          rec = { el, kindTag, ck: null, cls: null };
          live.set(key, rec);
          canvasEl.appendChild(el);
        }
        if(rec.cls !== w.cls){ rec.el.className = w.cls; rec.cls = w.cls; }
        if(rec.ck !== w.ck){
          rec.el.innerHTML = w.html;
          rec.ck = w.ck;
        }
        const s = rec.el.style;
        if(w.w != null) s.width = w.w + 'px';
        if(w.h != null) s.height = w.h + 'px';
        if(w.borderColor) s.borderLeftColor = w.borderColor;
        s.transform = `translate3d(${Math.round(w.x)}px,${Math.round(w.y)}px,0)`;
        rec.el.dataset.k = key;
      }
    }

    return live.size;
  }

  /** Momentary highlight after a search jump. */
  function flash(itemId){
    for(const rec of live.values()){
      if(rec.el.dataset.id === String(itemId)){
        rec.el.classList.remove('flash');
        void rec.el.offsetWidth;          // restart the animation
        rec.el.classList.add('flash');
        return true;
      }
    }
    return false;
  }

  function specForKey(key){
    return live.get(key) || null;
  }

  return { paint, clear, flash, specForKey, get size(){ return live.size; } };
}

/* ---------- the pinned-lane band (horizontal virtualisation only) ---------- */

export function paintBand(doc, innerEl, lanes, itemsById, xMin, xMax){
  let html = '';
  const scratch = [];
  for(const lane of lanes){
    if(lane.stub) continue;
    scratch.length = 0;
    specsInWindow(lane, xMin, xMax, scratch);
    for(const spec of scratch){
      const it = spec.id != null ? itemsById[spec.id] : null;
      const y = lane.y + spec.yLocal;
      let h = spec.h;
      let extra = '';
      if(spec.kind === 'bin'){
        const barH = Math.max(3, Math.round(spec.intensity * spec.h));
        extra = `opacity:${(0.35 + 0.65 * spec.intensity).toFixed(2)};`;
        html += `<div class="it bin" style="--c:${lane.colors.solid};width:${spec.w}px;` +
          `height:${barH}px;${extra}transform:translate3d(${Math.round(spec.x)}px,` +
          `${Math.round(y + spec.h - barH)}px,0)"></div>`;
        continue;
      }
      const cls = 'it ' + spec.kind + (spec.dim ? ' dim' : '') + (spec.tight ? ' tight' : '');
      html += `<div class="${cls}"${spec.id != null ? ` data-id="${spec.id}"` : ''} style="` +
        `--c:${lane.colors.solid};--bd:${lane.colors.line};--soft:${lane.colors.soft};` +
        `--line2:${lane.colors.line};width:${spec.w}px;height:${h}px;` +
        `transform:translate3d(${Math.round(spec.x)}px,${Math.round(y)}px,0)">` +
        itemHTML(spec, it) + `</div>`;
    }
  }
  innerEl.innerHTML = html;
}

export { GEO };
