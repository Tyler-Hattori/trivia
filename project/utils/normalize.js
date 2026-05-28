import { parseMovements } from './layout.js';
import { parseYears, yearValue } from './helpers.js';

function buildFilters(dataset, raw){

  const defs = dataset.timeline?.filterable || [];

  const out = {};

  defs.forEach(def => {

    const rawValue =
      raw[dataset.map?.[def.key]];

    if(rawValue == null) return;

    let values = [];

    if(def.parser === 'movements'){

      values = parseMovements(rawValue);

    }else{

      values = String(rawValue)
        .split('|')
        .map(v => v.trim())
        .filter(Boolean);
    }

    out[def.key] = values;
  });

  return out;
}

export function normalizeTimelineRow(raw, dataset){

  const map = dataset.map || {};

  const get = (key) => {
    const k = map[key];
    return k ? raw[k] : undefined;
  };

  const image = get('image') ?? null;

  const title = get('title') ?? 'Untitled';
  const subtitle = get('subtitle') ?? '';
  const years = get('years') ?? '';
  const misc = get('misc') ?? '';
  const excerpt = get('excerpt') ?? '';

  let year = null;
  let start = null;
  let end = null;

  if(dataset.timeline.type === 'point'){
    year = yearValue(years);
  }

  if(dataset.timeline.type === 'span'){
    const parsed = parseYears(years);
    start = parsed.start;
    end = parsed.end;
  }

  return {
    type: dataset.timeline.type,

    image,                 // may be null safely

    label: title,
    subtitle,

    title,
    years,
    misc,
    excerpt,

    year,
    start,
    end,

    filters: buildFilters(dataset, raw),

    imgRatio: null,

    raw,

    dataset: dataset.key
  };
}