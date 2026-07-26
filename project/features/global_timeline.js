import { DATASETS } from '../core/settings.js';
import { parseCSV } from '../data/csv.js';
import { state } from '../core/state.js';
import { openTimeline } from './timeline/index.js';
import { normalizeTimelineRow } from '../utils/normalize.js';

/*
 * Datasets are static files. The previous loader fetched them one after another
 * with `?t=Date.now()` and `cache:'no-store'`, which guaranteed a cold network
 * round trip for every dataset on every open. Now they load in parallel, the
 * HTTP cache is allowed to do its job, and a module-level cache makes a second
 * open within the session instant.
 */

let CACHE = null;
let INFLIGHT = null;

async function loadDataset(dataset){
  const res = await fetch(dataset.file);
  if(!res.ok) throw new Error(`${dataset.file}: HTTP ${res.status}`);
  const txt = await res.text();
  return parseCSV(txt).map(r => normalizeTimelineRow(r, dataset));
}

async function loadAll(){
  const settled = await Promise.allSettled(DATASETS.map(loadDataset));

  const rows = [];
  const failed = [];
  settled.forEach((r, i) => {
    if(r.status === 'fulfilled') rows.push(...r.value);
    else failed.push(`${DATASETS[i].key}: ${r.reason?.message || r.reason}`);
  });

  if(failed.length) console.warn('Global timeline: some datasets failed to load —\n' + failed.join('\n'));
  if(!rows.length) throw new Error('No datasets could be loaded.\n' + failed.join('\n'));

  return rows;
}

/** Drop the cache so the next open re-reads the CSVs (useful after editing them). */
export function invalidateGlobalTimeline(){
  CACHE = null;
  INFLIGHT = null;
}

export async function openGlobalTimeline(){
  const filterDefs = [];
  for(const d of DATASETS){
    for(const f of (d.timeline?.filterable || [])){
      filterDefs.push({ key: f.key, label: f.label, dataset: d.key });
    }
  }
  state.timeline = { filterable: filterDefs };

  if(!CACHE){
    INFLIGHT = INFLIGHT || loadAll();
    try {
      CACHE = await INFLIGHT;
    } catch (e){
      INFLIGHT = null;
      console.error(e);
      alert('Could not load the datasets for the global timeline.\n' + e.message);
      return;
    }
    INFLIGHT = null;
  }

  await openTimeline({ rows: CACHE, title: 'Global Timeline' });
}
