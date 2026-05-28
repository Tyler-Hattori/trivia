import { DATASETS } from '../core/settings.js';
import { parseCSV } from '../data/csv.js';
import { load } from '../data/github.js';
import { state } from '../core/state.js';
import { openTimeline } from './timeline_engine.js';
import { normalizeTimelineRow } from '../utils/normalize.js';

async function loadDatasetRaw(dataset){
  const txt = await fetch(
    dataset.file + '?t=' + Date.now(),
    { cache:'no-store' }
  ).then(r => r.text());

  return parseCSV(txt, dataset.schema.fields)
    .map(r => normalizeTimelineRow(r, dataset));
}

export async function openGlobalTimeline(){
  const filterDefs = [];

  for (const d of DATASETS) {
    const cfg = d.timeline?.filterable || [];

    for (const f of cfg) {
      filterDefs.push({
        key: f.key,
        label: f.label,
        dataset: d.key
      });
    }
  }

  state.timeline = {
    filterable: filterDefs
  };

  const all = [];

  for (const d of DATASETS){
    const rows = await loadDatasetRaw(d);
    all.push(...rows);
  }

  openTimeline({
    rows: all,
    title: 'Global Timeline'
  });
}
