/*
 * Model layer: normalised rows -> flat, layout-ready items, plus the search
 * index and query engine. Nothing here touches the DOM.
 */

import { thumbUrl } from '../../utils/helpers.js';
import { DATASETS } from '../../core/settings.js';
import { excerptToText, truncate } from './util.js';

export const CARD_IMG_W = 320;   // px requested from Wikimedia for card thumbs

function slugify(str = ''){
  return String(str)
    .toLowerCase().trim()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Local pre-built thumbnail cache (datasets/build_thumbnails.js), if present. */
export async function loadThumbMeta(){
  try {
    const res = await fetch('./thumbnails/meta.json', { cache: 'force-cache' });
    if(!res.ok) return {};
    return await res.json();
  } catch {
    return {};   // Wikimedia URL resizing covers us
  }
}

function resolveImage(meta, r){
  if(!r.image) return { thumb: null, full: null };
  const local = `${slugify(r.subtitle)}_${slugify(r.title)}_${r.year ?? r.start ?? ''}.jpg`;
  if(meta[local]) return { thumb: `./thumbnails/${local}`, full: r.image };
  return { thumb: thumbUrl(r.image, CARD_IMG_W), full: r.image };
}

/**
 * Build the immutable item array. Called once per timeline open; everything
 * downstream (layout, search, minimap) reads from this and never re-derives it.
 */
export function buildItems(rows, meta, fallbackDataset){
  const items = [];

  for(let i = 0; i < rows.length; i++){
    const r = rows[i];
    const ds = r.dataset || fallbackDataset || 'global';
    const kind = r.type === 'span' ? 'span' : 'point';

    const year  = Number.isFinite(r.year)  ? r.year  : null;
    const start = Number.isFinite(r.start) ? r.start : null;
    const end   = Number.isFinite(r.end)   ? r.end   : null;

    // Drop rows we cannot place — they would otherwise silently pile up at year 0.
    if(kind === 'point' ? year == null : (start == null || end == null)) continue;

    const img = resolveImage(meta, r);
    const excerpt = r.excerpt || '';
    const excerptText = excerptToText(excerpt);

    const displayYear =
      r.displayYear ||
      r.years ||
      (kind === 'span' ? `${start} – ${end}` : String(year ?? ''));

    const it = {
      id: items.length,
      ds,
      kind,
      year, start, end,
      // A single number every item can be sorted / bucketed by.
      at: kind === 'point' ? year : (start + end) / 2,
      lo: kind === 'point' ? year : start,
      hi: kind === 'point' ? year : end,

      label: r.label || r.title || 'Untitled',
      subtitle: r.subtitle || '',
      misc: r.misc || '',
      excerpt,
      excerptText,
      snippet: truncate(excerptText, 150),
      displayYear,

      image: r.image || null,
      thumb: img.thumb,
      full: img.full,

      filters: r.filters || {},
      raw: r.raw || r
    };

    // Search haystack. Capped so a keystroke never scans megabytes of prose.
    it.hay = (
      it.label + ' ' + it.subtitle + ' ' + it.misc + ' ' +
      it.displayYear + ' ' + ds + ' ' +
      truncate(excerptText, 280)
    ).toLowerCase();

    items.push(it);
  }

  return items;
}

/** Year bounds, snapped outward to a round decade. */
export function yearBounds(items, minYear, maxYear){
  if(!items.length) return { minYear: minYear ?? 0, maxYear: maxYear ?? 100 };
  let lo = Infinity, hi = -Infinity;
  for(const it of items){
    if(it.lo < lo) lo = it.lo;
    if(it.hi > hi) hi = it.hi;
  }
  return {
    minYear: minYear ?? Math.floor(lo / 10) * 10,
    maxYear: maxYear ?? Math.ceil(hi / 10) * 10
  };
}

/** Dataset keys actually represented, in the canonical settings.js order. */
export function datasetsPresent(items){
  const seen = new Set(items.map(i => i.ds));
  const ordered = DATASETS.map(d => d.key).filter(k => seen.has(k));
  for(const k of seen) if(!ordered.includes(k)) ordered.push(k);
  return ordered;
}

/** Distinct values for one facet of one dataset, with counts. */
export function facetValues(items, ds, facetKey){
  const counts = new Map();
  for(const it of items){
    if(it.ds !== ds) continue;
    const v = laneValueOf(it, facetKey);
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  return counts;
}

/**
 * An item belongs to exactly one lane per facet — the first value. Multi-value
 * cells ("a|b") would otherwise duplicate the item across lanes and make the
 * vertical registers depend on the data rather than on the facet.
 */
export function laneValueOf(it, facetKey){
  if(!facetKey) return 'All';
  const vals = it.filters?.[facetKey];
  const v = Array.isArray(vals) ? vals[0] : vals;
  return (v == null || v === '') ? 'Other' : String(v);
}

/* ---------- search ---------- */

const RANGE_RE = /^(-?\d{1,4})\s*(?:\.\.|–|—|-|to)\s*(-?\d{1,4})$/i;
const KV_RE = /^([a-z_]+):(.+)$/i;

/**
 * Parse the search box into structured constraints.
 * Supported: free text, `1750-1800`, `1969`, `ds:science`, `field:optics`.
 */
export function parseQuery(q, facetDefs){
  const out = { terms: [], lo: null, hi: null, ds: null, kv: [] };
  const raw = String(q || '').trim();
  if(!raw) return out;

  for(const tok of raw.split(/\s+/)){
    const range = RANGE_RE.exec(tok);
    if(range){
      const a = parseInt(range[1], 10), b = parseInt(range[2], 10);
      out.lo = Math.min(a, b);
      out.hi = Math.max(a, b);
      continue;
    }

    const kv = KV_RE.exec(tok);
    if(kv){
      const k = kv[1].toLowerCase(), v = kv[2].toLowerCase();
      if(k === 'ds' || k === 'dataset'){
        out.ds = (out.ds || new Set()).add(v);
        continue;
      }
      // Match a facet by its configured key or its human label.
      const def = facetDefs.find(d =>
        d.key.toLowerCase() === k || d.label.toLowerCase().replace(/[^a-z]/g, '') === k
      );
      if(def){ out.kv.push({ key: def.key, val: v }); continue; }
    }

    out.terms.push(tok.toLowerCase());
  }

  return out;
}

export function queryIsEmpty(p){
  return !p.terms.length && p.lo == null && !p.ds && !p.kv.length;
}

/**
 * Returns a Set of matching item ids, or null when the query is empty.
 * Linear substring scan over capped haystacks — ~1ms at 3k items, and it stays
 * comfortable well past 100k, so no index maintenance is needed.
 */
export function runSearch(items, p){
  if(queryIsEmpty(p)) return null;

  const out = new Set();
  for(const it of items){
    if(p.ds && !p.ds.has(it.ds)) continue;
    if(p.lo != null && (it.hi < p.lo || it.lo > p.hi)) continue;

    let ok = true;
    for(const { key, val } of p.kv){
      const vals = it.filters?.[key];
      const arr = Array.isArray(vals) ? vals : (vals == null ? [] : [vals]);
      if(!arr.some(v => String(v).toLowerCase().includes(val))){ ok = false; break; }
    }
    if(!ok) continue;

    for(const t of p.terms){
      if(!it.hay.includes(t)){ ok = false; break; }
    }
    if(ok) out.add(it.id);
  }
  return out;
}

/** Ranked hits for the ⌘K palette — title matches first, then chronological. */
export function rankHits(items, p, matched, limit = 40){
  if(!matched) return [];
  const terms = p.terms;
  const hits = [];
  for(const it of items){
    if(!matched.has(it.id)) continue;
    const label = it.label.toLowerCase();
    let score = 0;
    for(const t of terms){
      if(label.startsWith(t)) score += 6;
      else if(label.includes(t)) score += 3;
      if(it.subtitle.toLowerCase().includes(t)) score += 1;
    }
    hits.push({ it, score });
  }
  hits.sort((a, b) => (b.score - a.score) || (a.it.at - b.it.at));
  return hits.slice(0, limit).map(h => h.it);
}
