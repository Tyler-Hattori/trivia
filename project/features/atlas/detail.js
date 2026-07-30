/*
 * The detail panel — what opens when you click an entry.
 *
 * This replaces the old in-place row expansion, which pushed the surrounding
 * layout around as it grew and clipped its own text (the body was
 * `overflow:hidden` and the height was a fixed constant). A panel alongside the
 * canvas has neither problem: it can be any height, it scrolls, and the map
 * behind it does not move — so you keep your place while reading.
 *
 * What it adds beyond the old view:
 *
 *   - the cluster path, so you can see *why* an entry sits where it does
 *   - nearest neighbours in embedding space, which is the atlas's own answer to
 *     "what else is like this" and is precomputed, so it is free
 *   - topic chips that filter the map when clicked
 *
 * Images are `object-fit: contain` here too, and clicking one opens it larger,
 * still uncropped. An artwork must never be cropped to fit a frame.
 */

import { thumbUrl, fullUrl } from '../../utils/helpers.js';
import { fmtYear, fmtRange } from './scales.js';
import { esc } from './cards.js';

export function createDetail(root, hooks = {}){
  const D = root.ownerDocument;          // the popup's document, not the opener's
  const panel = D.createElement('aside');
  panel.className = 'detail';
  panel.setAttribute('aria-live', 'polite');
  root.appendChild(panel);

  const box = D.createElement('div');
  box.className = 'lightbox';
  box.innerHTML = '<div class="lbinner"><img alt=""><button class="lbclose" title="Close (Esc)">✕</button></div>';
  root.appendChild(box);

  let current = -1;
  let A = null;

  // ---- rendering ---------------------------------------------------------

  function render(){
    if(current < 0 || !A){ panel.classList.remove('on'); return; }
    const i = current;
    const d = A.details?.[A.id[i]] || {};

    const path = [...A.chainOf.get(A.leaf[i]) || []].reverse()
      .map((id) => A.nodes[id])
      .filter((nd) => nd && nd.depth > 0);

    const years = A.isSpan[i] ? fmtRange(A.x0[i], A.x1[i]) : fmtYear(A.x0[i]);
    const yearText = A.yearText[i] && A.yearText[i] !== years ? A.yearText[i] : years;

    const neighbours = (A.knn[i] || []).slice(0, 6);

    panel.innerHTML = `
      <header class="dhead">
        <div class="dpath">${path.map((nd) =>
          `<button class="crumb" data-node="${nd.id}" style="--hue:${nd.color}">${esc(nd.label)}</button>`,
        ).join('<span class="sep">›</span>')}</div>
        <button class="dclose" title="Close (Esc)">✕</button>
      </header>

      ${A.image[i] ? `
        <figure class="dpic">
          <img src="${esc(thumbUrl(A.image[i], 500))}" alt="${esc(A.title[i])}" decoding="async">
          <figcaption>Click to enlarge</figcaption>
        </figure>` : ''}

      <div class="dbody">
        <h2>${esc(A.title[i])}</h2>
        ${A.subtitle[i] ? `<div class="dsub">${esc(A.subtitle[i])}</div>` : ''}
        <div class="dyear">${esc(yearText)}${A.circa[i] ? ' <span class="approx">approx.</span>' : ''}</div>

        ${d.excerpt
          ? `<div class="dex">${d.excerpt.split(/\n\n+/).map((p) => `<p>${esc(p)}</p>`).join('')}</div>`
          : '<div class="dex empty">No excerpt yet. <code>node datasets/ingest.mjs</code> can fill it from Wikipedia.</div>'}

        ${(A.topics[i] || []).length ? `
          <div class="dsection">
            <h3>Topics</h3>
            <div class="chips">${(A.topics[i] || [])
              .map((t) => `<button class="chip" data-topic="${esc(t)}">${esc(t)}</button>`).join('')}</div>
          </div>` : ''}

        ${d.facets && Object.keys(d.facets).length ? `
          <div class="dsection">
            <h3>Details</h3>
            <dl class="facets">${Object.entries(d.facets).map(([k, v]) =>
              `<dt>${esc(k)}</dt><dd>${esc(Array.isArray(v) ? v.join(', ') : v)}</dd>`).join('')}</dl>
          </div>` : ''}

        ${neighbours.length ? `
          <div class="dsection">
            <h3>Nearest in embedding space</h3>
            <ul class="near">${neighbours.map((j) => `
              <li><button data-goto="${j}">
                <span class="swatch" style="background:${A.color[j]}"></span>
                <span class="nt">${esc(A.title[j])}</span>
                <span class="ny">${esc(A.yearText[j] || fmtYear(A.x0[j]))}</span>
              </button></li>`).join('')}</ul>
          </div>` : ''}

        <div class="dsection dlinks">
          ${d.origin?.wiki ? `<a href="${esc(d.origin.wiki)}" target="_blank" rel="noopener">Wikipedia ↗</a>` : ''}
          <span class="did">${esc(A.id[i])}</span>
        </div>
      </div>`;

    panel.classList.add('on');
  }

  // ---- interaction -------------------------------------------------------

  panel.addEventListener('click', (e) => {
    const t = e.target;

    if(t.closest('.dclose')){ close(); return; }

    const pic = t.closest('.dpic');
    if(pic && current >= 0){ openBox(A.image[current], A.title[current]); return; }

    const goto = t.closest('[data-goto]');
    if(goto){ hooks.onGoto?.(Number(goto.dataset.goto)); return; }

    const topic = t.closest('[data-topic]');
    if(topic){ hooks.onTopic?.(topic.dataset.topic); return; }

    const node = t.closest('[data-node]');
    if(node){ hooks.onNode?.(Number(node.dataset.node)); return; }
  });

  // ---- the enlarged image ------------------------------------------------

  function openBox(url, alt){
    if(!url) return;
    const img = box.querySelector('img');
    // Full-size form goes through Special:FilePath, which rounds any width up to
    // a size Wikimedia will actually serve and falls back to the original when
    // the request exceeds it. A direct CDN hotlink at a nonstandard width just
    // returns HTTP 400.
    img.src = fullUrl(url, 1280);
    img.alt = alt || '';
    box.classList.add('on');
  }

  box.addEventListener('click', () => box.classList.remove('on'));

  // ---- api ---------------------------------------------------------------

  function open(atlas, i){
    A = atlas;
    current = i;
    // The excerpt may still be in flight on a fast first click.
    if(!A.details) A.detailsPromise?.then(() => { if(current === i) render(); });
    render();
  }

  function close(){
    current = -1;
    panel.classList.remove('on');
    box.classList.remove('on');
    hooks.onClose?.();
  }

  /** Re-render in place, e.g. once excerpts have loaded. */
  function refresh(){ if(current >= 0) render(); }

  return {
    open, close, refresh,
    get current(){ return current; },
    get isOpen(){ return current >= 0; },
    boxOpen: () => box.classList.contains('on'),
    closeBox: () => box.classList.remove('on'),
  };
}
