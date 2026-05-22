import { DATASETS } from '../core/settings.js';
import { parseCSV } from '../data/csv.js';
import { normalizeRow, parseYears, yearValue } from '../utils/helpers.js';
import { load } from '../data/github.js';
import { state } from '../core/state.js';
import { openTimeline } from './timeline_engine.js';
import { parseMovements } from '../utils/layout.js';

function normalizeCSVRow(r, dataset) {
  if (dataset.key === "leaders") {
    const { start, end } = parseYears(r.years || "");

    return {
      image: r.image,
      title: r.name,
      artist: r.occupation,
      year: null,
      start: Number.isFinite(start) ? start : null,
      end: Number.isFinite(end) ? end : null,
      movement: r.country,
    };
  }

  // art / default
  const year = yearValue(r.year);

  return {
    image: r.image,
    title: r.title,
    artist: r.artist,
    year: Number.isFinite(year) ? year : null,
    start: null,
    end: null,
    movement: r.movement || "",
  };
}

async function loadDatasetRaw(dataset){
  const txt = await fetch(dataset.file + '?t=' + Date.now(), {
    cache: 'no-store'
  }).then(r => r.text());

  return parseCSV(txt, dataset.schema.fields)
    .map(r => normalizeCSVRow(r, dataset));
}

export function normalizeTimelineRow(row, datasetKey) {
  const rawMovement = row.movement || "";

  const baseTags =
    datasetKey === "people"
      ? [row.occupation, row.country]
      : parseMovements(rawMovement);

  const tags = baseTags.filter(Boolean);

  return {
    type: datasetKey === "people" ? "range" : "point",

    year: Number(yearValue(row.year)) || null,
    start: row.start ?? null,
    end: row.end ?? null,

    title: row.title || row.name || "",
    subtitle: row.artist || row.movement || "",
    image: row.image,

    meta: {
      primary: row.artist || row.occupation || "",
      secondary: row.movement || row.country || "",
      tags: tags.length ? tags : ["uncategorized"]
    },

    raw: row
  };
}

export async function openGlobalTimeline(){

  const all = [];

  for (const d of DATASETS){
    const rows = await loadDatasetRaw(d);

    all.push(
      ...rows.map(r => normalizeTimelineRow(r, d.key))
    );
  }

  openTimeline(all, 'global');
}
