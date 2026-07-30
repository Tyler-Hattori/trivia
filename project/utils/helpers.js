import { state } from '../core/state.js';

/**
 * Year parsing lives in `datasets/lib/years.mjs` and is re-exported here rather
 * than duplicated. Two copies drifting apart mis-places entries silently: a span
 * read as a point lands at the wrong x and nothing errors.
 */
export { parseEraYear, parseYears, yearValue, yearLabel, isCirca } from '../../datasets/lib/years.mjs';
import { parseYears, yearValue } from '../../datasets/lib/years.mjs';

export const $ = (s, root = document) => {
  if (typeof s !== 'string') return null;

  if (s.startsWith('#')) {
    return document.getElementById(s.slice(1));
  }

  return root.querySelector(s);
};

export function toast(msg){

  const overlay = document.createElement('div');

  overlay.className = `
    fixed
    inset-0
    z-[9999]
    bg-black/30
    backdrop-blur-sm
    flex
    items-center
    justify-center
    opacity-0
    transition-opacity
    duration-200
  `;

  const modal = document.createElement('div');

  modal.className = `
    bg-white
    border
    border-zinc-200
    shadow-2xl
    rounded-3xl
    px-8
    py-6
    text-lg
    font-semibold
    text-zinc-800
    scale-95
    transition-transform
    duration-200
  `;

  modal.textContent = msg;

  overlay.appendChild(modal);

  document.body.appendChild(overlay);

  requestAnimationFrame(() => {
    overlay.classList.remove('opacity-0');
    modal.classList.remove('scale-95');
  });

  setTimeout(() => {

    overlay.classList.add('opacity-0');
    modal.classList.add('scale-95');

    setTimeout(() => {
      overlay.remove();
    }, 200);

  }, 1200);
}

export function shuffle(a){
  for(let i=a.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

export function yearNumSafe(v){
  const m=String(v||'').match(/\d{3,4}/);
  return m ? parseInt(m[0],10) : 0;
}

export function nextItem(){
  if(!state.queue || state.queue.length === 0){
    return null;
  }
  return state.queue.shift();
}

export function calcRMSE(arr){
  if(!arr.length) return 0;

  const mse = arr.reduce((sum,v)=>sum + v*v,0) / arr.length;

  return Math.sqrt(mse);
}

/**
 * The only thumbnail widths Wikimedia's CDN will generate. Since 2025 (phabricator
 * T360589) a direct hotlink at any other width is rejected with HTTP 400 rather
 * than being rounded — asking for the old 320px returned an error page for every
 * single file, which is why the timeline rendered almost everything as a text card.
 * https://www.mediawiki.org/wiki/Common_thumbnail_sizes
 */
export const WM_STD_WIDTHS = [20, 40, 60, 120, 250, 330, 500, 960, 1280, 1920, 3840];

/** Smallest standard width that is still at least `w`, so we never upscale-blur. */
export function snapWikimediaWidth(w){
  for(const s of WM_STD_WIDTHS) if(s >= w) return s;
  return WM_STD_WIDTHS[WM_STD_WIDTHS.length - 1];
}

/** Commons filename + the wiki that hosts it, from any upload.wikimedia.org URL. */
function wikimediaFile(url){
  const m = url.match(/^https?:\/\/upload\.wikimedia\.org\/wikipedia\/([^/]+)\//);
  if(!m) return null;
  const project = m[1];
  // thumb form ends "/File.jpg/<n>px-File.jpg"; bare form just "/File.jpg".
  const parts = url.split('#')[0].split('?')[0].split('/');
  const file = url.includes('/thumb/') ? parts[parts.length - 2] : parts[parts.length - 1];
  if(!file) return null;
  const host = project === 'commons' ? 'commons.wikimedia.org' : `${project}.wikipedia.org`;
  return { host, file };
}

/**
 * Rewrite a Wikimedia Commons image URL to request a specific pixel width from
 * their CDN, dramatically cutting bytes for cards/thumbnails. Handles the two
 * URL shapes Wikimedia serves:
 *
 *   thumb form:  .../commons/thumb/a/ab/File.jpg/3840px-File.jpg
 *   bare  form:  .../commons/a/ab/File.jpg
 *
 * The requested width is snapped to a standard size — see WM_STD_WIDTHS. Direct
 * CDN thumbs are used (rather than Special:FilePath) because they are served
 * without a redirect hop, which matters when a viewport holds dozens of cards.
 *
 * Non-Wikimedia URLs (or unparseable ones) pass through unchanged, which is
 * why the local thumbnail pipeline stays useful as a fallback.
 */
export function thumbUrl(url, width = 330){
  if(!url || typeof url !== 'string') return url;

  const w = snapWikimediaWidth(Math.round(width));

  // Commons Special:FilePath resolves any filename to the current file and
  // natively supports ?width= resizing — ideal for hand-authored datasets.
  // It runs through PHP, which rounds up on its own, but snapping here keeps
  // every request for the same image on one CDN cache key.
  if(url.includes('Special:FilePath')){
    const [pathPart, q] = url.split('#')[0].split('?');
    const params = new URLSearchParams(q || '');
    params.set('width', String(w));
    return pathPart + '?' + params.toString();
  }

  if(!url.includes('upload.wikimedia.org')) return url;

  // Already a thumb URL: replace the trailing "<n>px-" width token.
  if(url.includes('/thumb/')){
    return url.replace(/\/(\d+)px-([^/]+)$/, `/${w}px-$2`);
  }

  // Bare file URL: convert to thumb form.
  // .../commons/a/ab/File.jpg  ->  .../commons/thumb/a/ab/File.jpg/<w>px-File.jpg
  const m = url.match(/^(https?:\/\/upload\.wikimedia\.org\/wikipedia\/[^/]+)\/([0-9a-f])\/([0-9a-f]{2})\/(.+)$/);
  if(m){
    const [, base, d1, d2, file] = m;
    return `${base}/thumb/${d1}/${d2}/${file}/${w}px-${file}`;
  }

  return url;
}

/**
 * Full-size form for the lightbox, where one big image loads at a time.
 *
 * Prefers Special:FilePath: it is resolved by PHP, so it rounds any width up to
 * a standard size *and* falls back to the original when the request is larger
 * than the source. A direct CDN hotlink does neither — it just 400s. The extra
 * redirect costs nothing when only one image is in flight.
 */
export function fullUrl(url, width = 1280){
  if(!url || typeof url !== 'string') return url;
  if(url.includes('Special:FilePath')) return thumbUrl(url, width);

  const f = wikimediaFile(url);
  if(!f) return url;

  return `https://${f.host}/wiki/Special:FilePath/${f.file}` +
         `?width=${snapWikimediaWidth(Math.round(width))}`;
}

export function normalizeRow(row, dataset){

  if(dataset.key === 'art'){
    return {
      type: 'point',
      start: yearValue(row.year),
      label: row.title,
      image: row.image,
      meta: row.artist,
      dataset: dataset.key
    };
  }

  if(dataset.key === 'people'){
    const { start, end } = parseYears(row.years);

    if(!start || !end) return null;

    return {
      type: 'range',
      start,
      end,
      label: row.name,
      image: row.image,
      meta: row.occupation,
      dataset: dataset.key
    };
  }

  return null;
}
