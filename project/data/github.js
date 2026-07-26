import { toast, $, yearValue } from '../utils/helpers.js';
import { applyQuizSettings } from '../features/quiz_engine.js';
import { state } from '../core/state.js';
import { render } from '../app/render.js';
import { DATASETS, OWNER, REPO, BRANCH } from '../core/settings.js';
import { parseCSV, csvOut } from './csv.js';

export async function load(){
  const txt = await fetch(
    state.active.file + '?t=' + Date.now(),
    { cache:'no-store' }
  ).then(r => r.text());

  // Raw, header-keyed rows. The quiz reads these directly (schema.fields are
  // real column names). The timeline normalizes them when it opens.
  state.data = parseCSV(txt);
}

export async function loadQuizCounts() {
  for (const q of DATASETS) {
    const txt = await fetch(q.file + '?t=' + Date.now(), {
      cache:'no-store'
    }).then(r => r.text());

    q.count = parseCSV(txt).length;
  }

  render();
}

export async function addEntry(){
  if(!state.token) return toast('No token');

  const path=state.active.file;

  const meta=await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`,
    {
      headers:{Authorization:'Bearer '+state.token}
    }
  ).then(r=>r.json());

  const latestCsv=atob(meta.content.replace(/\n/g,''));
  const rows = parseCSV(latestCsv);

  // Preserve the existing header/column order; fall back to config.
  const columns =
    rows.length
      ? Object.keys(rows[0])
      : columnsForDataset(state.active);

  const row = {};
  columns.forEach(c => {
    const el = $('#n' + c);
    row[c] = el ? el.value.trim() : '';
  });
  // image field uses its own input id for backwards compatibility
  const imgEl = $('#nimage');
  if(imgEl && columns.includes(state.active.map.image)){
    row[state.active.map.image] = imgEl.value.trim();
  }

  rows.push(row);

  const yearsCol = state.active.map.years;
  rows.sort((a, b) => yearValue(a[yearsCol]) - yearValue(b[yearsCol]));

  await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`,
    {
      method:'PUT',
      headers:{
        Authorization:'Bearer '+state.token,
        'Content-Type':'application/json'
      },
      body:JSON.stringify({
        message:'update dataset',
        content:btoa(
          unescape(
            encodeURIComponent(csvOut(rows, columns))
          )
        ),
        sha:meta.sha,
        branch:BRANCH
      })
    }
  );

  toast('Saved');

  await load();
  applyQuizSettings();
}

function columnsForDataset(dataset){
  // image column first, then the quizzable fields (deduped)
  const cols = [dataset.map.image];
  dataset.schema.fields.forEach(f => {
    if(!cols.includes(f)) cols.push(f);
  });
  return cols;
}
