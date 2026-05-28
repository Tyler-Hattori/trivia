import { toast, $, yearValue } from '../utils/helpers.js';
import { applyQuizSettings } from '../features/quiz_engine.js';
import { state } from '../core/state.js';
import { render } from '../app/render.js';
import { DATASETS, OWNER, REPO, BRANCH } from '../core/settings.js';
import { parseCSV, csvOut } from './csv.js';
import { normalizeTimelineRow } from '../utils/normalize.js';

export async function load(){
  const txt = await fetch(
    state.active.file + '?t=' + Date.now(),
    { cache:'no-store' }
  ).then(r => r.text());

  const rawRows =
    parseCSV(txt, state.active.schema.fields);

  state.data = rawRows.map(r =>
    normalizeTimelineRow(r, state.active)
  );
}

function denormalizeRow(row, dataset){
  const out = {};
  const map = dataset.map;

  out[map.image] = row.image;
  out[map.title] = row.title;
  out[map.subtitle] = row.subtitle;
  out[map.years] = row.years;
  out[map.misc] = row.misc;

  return out;
}

export async function loadQuizCounts() {
  for (const q of DATASETS) {
    const txt = await fetch(q.file + '?t=' + Date.now(), {
      cache:'no-store'
    }).then(r => r.text());

    q.count = parseCSV(txt, q.schema.fields).length;
  }

  render();
}

export async function addEntry(){
  if(!state.token) return toast('No token');
  
  console.log('LOCALSTORAGE', localStorage.getItem('gh_pat'));
  console.log('STATE TOKEN', state.token);

  const path=state.active.file;

  const meta=await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`,
    {
      headers:{Authorization:'Bearer '+state.token}
    }
  ).then(r=>r.json());

  const latestCsv=atob(meta.content.replace(/\n/g,''));
  state.data = parseCSV(latestCsv, state.active.schema.fields);

  const row={image:$('#nimage').value.trim()};

  const fields = state.active.schema.fields;
  fields.forEach(f=>{
    row[f]=$('#n'+f).value.trim();
  });

  const normalized = normalizeTimelineRow(row, state.active);
  state.data.push(normalized); 
  state.data.sort((a, b) => yearValue(a.year) - yearValue(b.year));

  const csvRows = state.data.map(r =>
    denormalizeRow(r, state.active)
  );

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
            encodeURIComponent(csvOut(rows, state.active.schema.fields))
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
