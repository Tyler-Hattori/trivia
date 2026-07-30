/*
 * imgcheck.mjs — HEAD-check every image URL a dataset references, using the
 * exact URL the browser will request (i.e. after thumbUrl() rewriting).
 *
 *   node imgcheck.mjs            # all datasets
 *   node imgcheck.mjs art.csv    # one dataset
 *
 * Writes <name>.deadimg.json per dataset and prints a summary. Read-only:
 * it never edits a CSV.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const WIDTH = 330;           // must match CARD_IMG_W in timeline/model.js
// Wikimedia throttles aggressively; above ~8 in flight it answers 429 and the
// run reports healthy images as dead.
const CONCURRENCY = 6;

const WM_STD_WIDTHS = [20, 40, 60, 120, 250, 330, 500, 960, 1280, 1920, 3840];
function snapWikimediaWidth(w){
  for(const s of WM_STD_WIDTHS) if(s >= w) return s;
  return WM_STD_WIDTHS[WM_STD_WIDTHS.length - 1];
}

/* --- mirror of utils/helpers.js thumbUrl(), kept in sync by hand --- */
function thumbUrl(url, width = WIDTH){
  if(!url || typeof url !== 'string') return url;
  const w = snapWikimediaWidth(Math.round(width));
  if(url.includes('Special:FilePath')){
    const [pathPart, q] = url.split('#')[0].split('?');
    const params = new URLSearchParams(q || '');
    params.set('width', String(w));
    return pathPart + '?' + params.toString();
  }
  if(!url.includes('upload.wikimedia.org')) return url;
  if(url.includes('/thumb/')) return url.replace(/\/(\d+)px-([^/]+)$/, `/${w}px-$2`);
  const m = url.match(/^(https?:\/\/upload\.wikimedia\.org\/wikipedia\/[^/]+)\/([0-9a-f])\/([0-9a-f]{2})\/(.+)$/);
  if(m){
    const [, base, d1, d2, file] = m;
    return `${base}/thumb/${d1}/${d2}/${file}/${w}px-${file}`;
  }
  return url;
}

/* --- minimal CSV reader: one record per line, quoted fields may hold commas --- */
function splitLine(line){
  const out = [];
  let cur = '', q = false;
  for(let i = 0; i < line.length; i++){
    const c = line[i];
    if(q){
      if(c === '"'){ if(line[i+1] === '"'){ cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if(c === '"') q = true;
    else if(c === ','){ out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function rowsOf(file){
  const text = await readFile(file, 'utf8');
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const head = splitLine(lines[0]);
  return lines.slice(1).map((l, i) => {
    const cells = splitLine(l);
    const o = { __line: i + 2 };
    head.forEach((h, j) => { o[h.trim()] = (cells[j] ?? '').trim(); });
    return o;
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function head(url, attempt = 0){
  try {
    let r = await fetch(url, {
      method: 'HEAD', headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(20000), redirect: 'follow'
    });
    // Some CDNs reject HEAD but serve GET fine — confirm before calling it dead.
    if(r.status === 405 || r.status === 501){
      r = await fetch(url, {
        method: 'GET', headers: { 'User-Agent': UA, Range: 'bytes=0-0' },
        signal: AbortSignal.timeout(20000)
      });
    }
    // A 429 says nothing about the image; back off and ask again rather than
    // recording throttling as breakage.
    if(r.status === 429 && attempt < 5){
      await sleep(1500 * Math.pow(2, attempt));
      return head(url, attempt + 1);
    }
    return { status: r.status, type: r.headers.get('content-type') || '' };
  } catch (e) {
    if(attempt < 3){
      await sleep(1000 * Math.pow(2, attempt));
      return head(url, attempt + 1);
    }
    return { status: 0, type: '', err: String(e.message || e).slice(0, 80) };
  }
}

async function pool(jobs, n){
  const out = new Array(jobs.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => {
    while(i < jobs.length){
      const k = i++;
      out[k] = await jobs[k]();
    }
  }));
  return out;
}

const argv = process.argv.slice(2);
// --sample=N checks an evenly spaced N per dataset. A full run of ~2,500 URLs
// takes the better part of an hour once Wikimedia starts throttling, so sample
// first and only go full when you actually intend to fix every row.
const sampleArg = argv.find(a => a.startsWith('--sample='));
const SAMPLE = sampleArg ? parseInt(sampleArg.split('=')[1], 10) : 0;
const args = argv.filter(a => !a.startsWith('--'));
const files = args.length ? args
  : (await readdir('.')).filter(f => f.endsWith('.csv')).sort();

let grandTotal = 0, grandDead = 0;

for(const file of files){
  const rows = await rowsOf(file);
  let withImg = rows.filter(r => r.image);
  const population = withImg.length;
  if(SAMPLE && population > SAMPLE){
    const step = population / SAMPLE;
    withImg = Array.from({ length: SAMPLE }, (_, i) => withImg[Math.floor(i * step)]);
  }
  if(!withImg.length){
    console.log(`${file.padEnd(16)} 0 images`);
    continue;
  }

  const results = await pool(
    withImg.map(r => async () => ({ row: r, url: thumbUrl(r.image), res: await head(thumbUrl(r.image)) })),
    CONCURRENCY
  );

  const dead = results.filter(x => x.res.status !== 200 || !x.res.type.startsWith('image/'));
  grandTotal += withImg.length;
  grandDead += dead.length;

  const byStatus = {};
  for(const d of dead) byStatus[d.res.status || d.res.err] = (byStatus[d.res.status || d.res.err] || 0) + 1;

  console.log(
    `${file.padEnd(16)} ${String(withImg.length).padStart(4)}` +
    (SAMPLE && population > SAMPLE ? `/${String(population).padEnd(5)}` : ' of  ' + String(population).padEnd(4)) +
    ` checked  ${String(dead.length).padStart(4)} dead  ` +
    (dead.length ? JSON.stringify(byStatus) : '')
  );

  const name = file.replace(/\.csv$/, '');
  // A sampled run must not overwrite a full inventory with partial results.
  if(dead.length && !SAMPLE){
    await writeFile(`${name}.deadimg.json`, JSON.stringify(
      dead.map(d => ({
        line: d.row.__line,
        title: d.row.title || d.row.name || d.row.event || '',
        status: d.res.status, err: d.res.err,
        requested: d.url,
        original: d.row.image
      })), null, 2));
  }
}

console.log(`\nTOTAL ${grandTotal} images, ${grandDead} dead (${(100 * grandDead / Math.max(1, grandTotal)).toFixed(1)}%)`);
