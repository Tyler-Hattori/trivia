export const $ = (s, root = document) => {
  if (typeof s !== 'string') return null;

  if (s.startsWith('#')) {
    return document.getElementById(s.slice(1));
  }

  return root.querySelector(s);
};

export function shuffle(a){
  for(let i=a.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
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

  // The Wikipedia API appends "?utm_source=…" to image URLs. Left in, it lands
  // in the middle of the thumb path and the CDN answers 400 (107 of 396 England
  // images were broken this way).
  url = url.split('#')[0].split('?')[0];

  // Already a thumb URL: replace the trailing "<n>px-" width token.
  if(url.includes('/thumb/')){
    return url.replace(/\/(\d+)px-([^/]+)$/, `/${w}px-$2`);
  }

  // Bare file URL: convert to thumb form.
  // .../commons/a/ab/File.jpg  ->  .../commons/thumb/a/ab/File.jpg/<w>px-File.jpg
  // Vector and multi-page sources are rasterised, and the CDN only answers the
  // name with the raster extension appended: File.svg -> <w>px-File.svg.png.
  const m = url.match(/^(https?:\/\/upload\.wikimedia\.org\/wikipedia\/[^/]+)\/([0-9a-f])\/([0-9a-f]{2})\/(.+)$/);
  if(m){
    const [, base, d1, d2, file] = m;
    const ext = /\.svg$/i.test(file) ? '.png' : /\.(tiff?|pdf|djvu)$/i.test(file) ? '.jpg' : '';
    const name = ext === '.jpg' ? `lossy-page1-${w}px-${file}.jpg` : `${w}px-${file}${ext}`;
    return `${base}/thumb/${d1}/${d2}/${file}/${name}`;
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

/**
 * `onerror` fallback for a thumbnail: retry once through Special:FilePath, which
 * serves the original when the source is narrower than the width asked for (the
 * CDN answers that with a 400). If that fails too: 'card' shows the next
 * sibling (a text fallback), 'hide' keeps the space, anything else removes it.
 *
 * Wire it with an attribute that carries no text, e.g.
 *   onerror="imgRetry(this)"
 * Never put item text inside an inline handler: an apostrophe once broke one.
 */
export function imgRetry(img, giveUp){
  const src = img.src;
  if(!img.dataset.retried){
    img.dataset.retried = '1';
    const alt = fullUrl(src.replace(/\/thumb\/(.+)\/[^/]+$/, '/$1'), img.width > 400 ? 960 : 500);
    if(alt && alt !== src){ img.src = alt; return; }
  }
  img.onerror = null;
  if(giveUp === 'card'){            // swap to the text fallback that follows the image
    img.style.display = 'none';
    if(img.nextElementSibling) img.nextElementSibling.style.display = '-webkit-box';
  } else if(giveUp === 'hide') img.style.visibility = 'hidden';
  else img.remove();
}
if(typeof window !== 'undefined') window.imgRetry = imgRetry;
