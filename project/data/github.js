import { toast, $, yearValue } from '../utils/helpers.js';
import { applyQuizSettings } from '../features/quiz_engine.js';
import { state } from '../core/state.js';
import { render } from '../app/render.js';
import { DATASETS, FIELD_SCHEMA, OWNER, REPO, BRANCH } from '../core/settings.js';
import { parseCSV, csvOut } from './csv.js';

export async function load(){
  const txt=await fetch(state.active.file+'?t='+Date.now(),{
    cache:'no-store'
  }).then(r=>r.text());

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
  state.data = parseCSV(latestCsv);

  const row={image:$('#nimage').value.trim()};

  FIELD_SCHEMA.forEach(f=>{
    row[f]=$('#n'+f).value.trim();
  });

  state.data.push(row);
  state.data.sort((a, b) => yearValue(a.year) - yearValue(b.year));

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
            encodeURIComponent(csvOut(state.data))
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
