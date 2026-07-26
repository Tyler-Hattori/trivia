import { state } from '../core/state.js';

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

/**
 * Parse a single year token to a signed integer, BC/BCE -> negative.
 * "27 BC" -> -27, "14 AD" -> 14, "c. 1500" -> 1500, "1305" -> 1305.
 * Returns null when no number is present.
 */
export function parseEraYear(s){
  s = String(s ?? '');
  const bc = /\bB\.?C\.?E?\.?/i.test(s);
  const m = s.match(/-?\d{1,4}/);
  if(!m) return null;
  const n = parseInt(m[0], 10);       // honours an explicit leading minus
  return bc ? -Math.abs(n) : n;
}

export function yearValue(v){
  v = String(v || '');

  if(/[-–—]/.test(v)){
    const { start, end } = parseYears(v);
    if(start != null && end != null) return (start + end) / 2;
  }

  const y = parseEraYear(v);
  return y == null ? 0 : y;
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
 * Rewrite a Wikimedia Commons image URL to request a specific pixel width from
 * their CDN, dramatically cutting bytes for cards/thumbnails. Handles the two
 * URL shapes Wikimedia serves:
 *
 *   thumb form:  .../commons/thumb/a/ab/File.jpg/3840px-File.jpg
 *   bare  form:  .../commons/a/ab/File.jpg
 *
 * Non-Wikimedia URLs (or unparseable ones) pass through unchanged, which is
 * why the local thumbnail pipeline stays useful as a fallback.
 */
export function thumbUrl(url, width = 320){
  if(!url || typeof url !== 'string') return url;

  const w = Math.round(width);

  // Commons Special:FilePath resolves any filename to the current file and
  // natively supports ?width= resizing — ideal for hand-authored datasets.
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

export function parseYears(v){
  v = String(v || '').trim();
  if(!v) return { start: null, end: null };

  // "1990-present" / "incumbent" -> current year
  const cur = new Date().getFullYear();
  v = v.replace(/\b(present|current|now|incumbent)\b/gi, String(cur));

  const eraAll = /\bB\.?C\.?E?\.?/i.test(v);

  // Split on a genuine range separator only — never on a leading minus sign:
  //   " to "  |  " - " (spaced dash)  |  a dash directly between two digits
  const parts = v.split(/\s+to\s+|\s+[-–—]\s+|(?<=\d)[-–—](?=\d)/i);

  if(parts.length >= 2){
    let start = parseEraYear(parts[0]);
    let end   = parseEraYear(parts[1]);

    // "100-44 BC": the era token trails the range, so the first number lacks it.
    if(eraAll && start != null && start > 0 &&
       !/\bAD\b|\bCE\b/i.test(parts[0]) && end != null && end < 0){
      start = -start;
    }

    return { start, end };
  }

  const y = parseEraYear(v);
  return { start: y, end: y };
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
