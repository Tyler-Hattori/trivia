// Shared helpers for the dataset tooling (enrich.mjs, suggest.mjs).
//
// Zero external deps: Node 18+ global fetch only. CSV parse/serialize is copied
// VERBATIM from project/data/csv.js so round-tripping a dataset through these
// scripts produces byte-compatible output with what the app itself writes.

import fs from 'fs';
import path from 'path';

export const USER_AGENT =
  'trivia-dataset-bot/1.0 (https://github.com/; tylerwhattori@gmail.com)';

// ---------------------------------------------------------------------------
// CSV — mirrors project/data/csv.js exactly (splitCSVRow / esc / csvOut).
// ---------------------------------------------------------------------------

function splitCSVRow(line) {
  const cols = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      cols.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cols.push(cur.trim());
  return cols;
}

/** Parse CSV text -> { headers: string[], rows: object[] } (header-driven). */
export function parseCSV(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter((x) => x.trim());
  if (!lines.length) return { headers: [], rows: [] };

  const headers = splitCSVRow(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCSVRow(lines[i]);
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = cols[idx] ?? '';
    });
    rows.push(row);
  }
  return { headers, rows };
}

export function esc(v) {
  v = String(v ?? '');
  if (/[",\n]/.test(v)) {
    return '"' + v.replace(/"/g, '""') + '"';
  }
  return v;
}

export function csvOut(rows, columns) {
  const header = columns.join(',');
  const body = rows.map((r) => columns.map((c) => esc(r[c])).join(','));
  return header + '\n' + body.join('\n') + '\n';
}

/** Read a dataset CSV -> { headers, rows }. */
export function readDataset(file) {
  return parseCSV(fs.readFileSync(file, 'utf-8'));
}

/** Write rows back, keeping a one-time .bak of the original. */
export function writeDataset(file, rows, headers) {
  const bak = file + '.bak';
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
  fs.writeFileSync(file, csvOut(rows, headers));
}

// ---------------------------------------------------------------------------
// Per-dataset config (used by both scripts). `fill` is the *default* target
// set; enrich only ever writes a field that exists in the header AND is empty.
// ---------------------------------------------------------------------------

export const DATASETS = {
  'art.csv':        { name: 'title',     extra: 'artist',     year: 'year', fill: ['excerpt'] },
  'film.csv':       { name: 'title',     extra: 'director',   year: 'year', film: true, fill: ['excerpt', 'image'] },
  'science.csv':    { name: 'discovery', extra: 'scientist',  year: 'year', fill: ['image'] },
  'people.csv':     { name: 'name',      extra: 'occupation', year: 'years', fill: ['excerpt', 'image'] },
  'leaders.csv':    { name: 'name',      extra: 'country',    year: 'years', fill: ['excerpt', 'image'] },
  'philosophy.csv': { name: 'work',      extra: 'philosopher',year: 'year', fill: ['excerpt', 'image'] },
  'religion.csv':   { name: 'event',     extra: 'tradition',  year: 'year', fill: ['excerpt', 'image'] },
  'us_history.csv': { name: 'event',     extra: 'category',   year: 'year', fill: ['excerpt', 'image'] },
};

export function cfgFor(file) {
  return DATASETS[path.basename(file)] || { name: null, fill: ['excerpt', 'image'] };
}

// ---------------------------------------------------------------------------
// HTTP + concurrency
// ---------------------------------------------------------------------------

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET JSON with the required UA, polite retry on 429/5xx. */
export async function getJSON(url, tries = 4) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT } });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) {
        await sleep(400 * (attempt + 1) + 200 * attempt);
        continue;
      }
      if (!res.ok) return null;
      return await res.json();
    } catch {
      await sleep(400 * (attempt + 1));
    }
  }
  return null;
}

/** Run async `fn` over `items` with bounded concurrency, preserving order. */
export async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------------------
// Wikipedia / Wikidata
// ---------------------------------------------------------------------------

const WP = 'https://en.wikipedia.org';
const WD = 'https://www.wikidata.org';

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Crude 0..1 token-overlap similarity between two titles. */
export function titleSim(a, b) {
  const A = new Set(norm(a).split(' ').filter(Boolean));
  const B = new Set(norm(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / Math.max(A.size, B.size);
}

/** Full-text search -> best matching page title, or null. */
export async function wpSearch(query, limit = 1) {
  const u = `${WP}/w/api.php?format=json&action=query&list=search&srlimit=${limit}&srsearch=${encodeURIComponent(query)}`;
  const d = await getJSON(u);
  const hits = d?.query?.search || [];
  return limit === 1 ? (hits[0]?.title ?? null) : hits.map((h) => h.title);
}

/** "More like this" via CirrusSearch morelike:, with category fallback. */
export async function wpMoreLike(title, limit = 8) {
  const u = `${WP}/w/api.php?format=json&action=query&list=search&srlimit=${limit}&srsearch=${encodeURIComponent('morelike:' + title)}`;
  const d = await getJSON(u);
  let hits = (d?.query?.search || []).map((h) => h.title);
  if (hits.length) return hits;

  // Fallback: siblings sharing this page's first non-hidden category.
  const cu = `${WP}/w/api.php?format=json&action=query&prop=categories&clshow=!hidden&cllimit=3&titles=${encodeURIComponent(title)}`;
  const cd = await getJSON(cu);
  const page = cd?.query?.pages ? Object.values(cd.query.pages)[0] : null;
  const cat = page?.categories?.[0]?.title;
  if (!cat) return [];
  const mu = `${WP}/w/api.php?format=json&action=query&list=categorymembers&cmtype=page&cmlimit=${limit}&cmtitle=${encodeURIComponent(cat)}`;
  const md = await getJSON(mu);
  return (md?.query?.categorymembers || []).map((m) => m.title);
}

/** REST summary -> { title, extract, image, qid } or null. */
export async function wpSummary(title) {
  const u = `${WP}/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`;
  const d = await getJSON(u);
  if (!d || d.type === 'https://mediawiki.org/wiki/HyperSwitch/errors/not_found') return null;
  const image = d.originalimage?.source || d.thumbnail?.source || '';
  const extract = String(d.extract || '').replace(/\s+/g, ' ').trim(); // never emit real newlines
  return { title: d.title || title, extract, image, qid: d.wikibase_item || null };
}

/** Batch Wikidata claims (P31 + a representative date) for up to 50 QIDs. */
export async function wdBatch(qids) {
  const result = {};
  for (let i = 0; i < qids.length; i += 50) {
    const chunk = qids.slice(i, i + 50);
    const u = `${WD}/w/api.php?format=json&action=wbgetentities&props=claims&ids=${chunk.join('|')}`;
    const d = await getJSON(u);
    const ents = d?.entities || {};
    for (const [qid, e] of Object.entries(ents)) {
      const c = e.claims || {};
      const p31 = (c.P31 || [])
        .map((x) => x.mainsnak?.datavalue?.value?.id)
        .filter(Boolean);
      const dateClaim = c.P585 || c.P571 || c.P577 || c.P569; // point/inception/pub/birth
      let year = null;
      const t = dateClaim?.[0]?.mainsnak?.datavalue?.value?.time; // e.g. +1926-00-00T...
      if (t) {
        const m = t.match(/^([+-])(\d+)/);
        if (m) year = (m[1] === '-' ? -1 : 1) * parseInt(m[2], 10);
      }
      result[qid] = { p31, year };
    }
  }
  return result;
}

/** Resolve Wikidata QIDs -> English labels (batched). */
export async function wdLabels(qids) {
  const out = {};
  const uniq = [...new Set(qids)].filter(Boolean);
  for (let i = 0; i < uniq.length; i += 50) {
    const chunk = uniq.slice(i, i + 50);
    const u = `${WD}/w/api.php?format=json&action=wbgetentities&props=labels&languages=en&ids=${chunk.join('|')}`;
    const d = await getJSON(u);
    for (const [qid, e] of Object.entries(d?.entities || {})) {
      out[qid] = e.labels?.en?.value || qid;
    }
  }
  return out;
}

export { norm };
