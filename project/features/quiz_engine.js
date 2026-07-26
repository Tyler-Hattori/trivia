import { render } from '../app/render.js';
import { updateStats } from '../ui/stats.js';
import { toast, $, nextItem, calcRMSE, yearValue, shuffle } from '../utils/helpers.js';
import { loadBestStats, commitBestIfNeeded } from '../ui/stats.js';
import { DATASETS } from '../core/settings.js';
import { state } from '../core/state.js';
import { load } from '../data/github.js';

export async function start(key){
  state.active = DATASETS.find(q => q.key === key);
  await load();

  state.streak = 0;
  state.answered = 0;

  state.totalFieldsAttempted = 0;
  state.totalFieldsCorrect = 0;

  state.fieldStats = {};

  const fields = state.active.schema.fields;

  state.QUIZ_SETTINGS = {
    count: 0,
    order: 'random'
  };

  state.ACTIVE_FIELDS = [...fields];

  fields.forEach(f=>{
    state.fieldStats[f] = {
      attempts:0,
      correct:0
    };
  });

  state.yearErrors = [];

  loadBestStats();

  /* build first queue using saved settings WITHOUT touching DOM */
  buildQueueFromSettings();

  render();
}

export function exitQuiz(){
  state.active = null;
  render();
}

function buildQueueFromSettings(){
  const settings = state.QUIZ_SETTINGS || {
    count:0,
    order:'random'
  };

  state.ACTIVE_FIELDS = state.ACTIVE_FIELDS || ['default','default','default','default'];

  let rows = [...state.data];
  shuffle(rows);

  if(settings.count > 0){
    rows = rows.slice(0, settings.count);
  }

  if(settings.order === 'chronological'){
    const yearsCol = state.active.map.years;
    rows.sort((a,b)=>yearValue(a[yearsCol])-yearValue(b[yearsCol]));
  }

  state.queue = rows;
  state.current = state.queue.shift() || null;
  state.submitted = false;
}

export function next(){
  if(!state.submitted) return;

  state.current = nextItem();

  if(!state.current){
    showQuizFinished();
    return;
  }

  state.submitted = false;

  document
    .getElementById('quizFields')
    .classList.remove('hidden');

  $('#submit').classList.remove('hidden');
  $('#next').classList.add('hidden');
  $('#next').disabled = true;

  requestAnimationFrame(() => {
    const title = $('#title');
    if (title && !title.disabled) {
      title.focus();
      title.select?.();
    }
  });

  $('#result').innerHTML='';

  const rem = $('#remainingCount');
  if(rem){
    rem.textContent =
      state.queue.length + 1;
  }

  render();
}

export function applyQuizSettings(){
  /* if page not rendered yet */
  if(!$('#quizCount')){
    buildQueueFromSettings();
    render();
    return;
  }

  const count = Number($('#quizCount').value);
  const order = $('#quizOrder').value;

  const checked = [...document.querySelectorAll('.fieldOpt:checked')]
    .map(el => el.value);

  if(!checked.length){
    toast('Select at least one field');
    return;
  }

  state.QUIZ_SETTINGS = {
    count,
    order,
    fields:[...checked]
  };

  state.ACTIVE_FIELDS = [...checked];

  restartQuiz();
}

export function restartQuiz(){
  state.streak = 0;
  state.answered = 0;

  state.totalFieldsAttempted = 0;
  state.totalFieldsCorrect = 0;

  state.yearErrors = [];

  state.fieldStats = {};

  const fields = state.active.schema.fields;
  fields.forEach(f=>{
    state.fieldStats[f] = {
      attempts:0,
      correct:0
    };
  });

  loadBestStats();

  buildQueueFromSettings();
  render();
}

function showQuizFinished(){
  const acc =
    state.totalFieldsAttempted
      ? Math.round(
          100 *
          state.totalFieldsCorrect /
          state.totalFieldsAttempted
        )
      : 0;

  const rmse = calcRMSE(state.yearErrors);

  commitBestIfNeeded({ acc, rmse });

  const fieldRows = state.active.schema.fields.map(f=>{

    if(f === 'year'){
      return `
        <div class='border rounded-xl p-4'>
          <div class='text-lg font-semibold text-zinc-500 mb-3'>Year RMSE</div>
          <div class='text-2xl font-bold'>
            ±${rmse.toFixed(1)}y
          </div>
        </div>
      `;
    }

    const s = state.fieldStats[f];

    const pct = s.attempts
      ? Math.round(100 * s.correct / s.attempts)
      : 0;

    return `
      <div class='border rounded-xl p-4'>
        <div class='text-lg font-semibold text-zinc-500 mb-3 capitalize'>
          ${f}
        </div>
        <div class='text-2xl font-bold'>
          ${pct}%
        </div>
      </div>
    `;
  }).join('');

  $('#app').innerHTML = `
    <div class='max-w-2xl mx-auto'>
      <div class='bg-white rounded-2xl shadow p-8 text-center'>

        <div class='text-4xl font-bold mb-3'>
          Quiz Complete
        </div>

        <div class='text-zinc-500 mb-8'>
          Nice run.
        </div>

        <div class='grid grid-cols-2 md:grid-cols-4 gap-2 mb-8'>
          ${fieldRows}
        </div>

        <div class='flex gap-3 justify-center'>
          <button onclick='restartQuiz()'
            class='bg-blue-600 text-white px-5 py-3 rounded-xl'>
            Play Again
          </button>

          <button onclick='exitQuiz()'
            class='border px-5 py-3 rounded-xl'>
            Home
          </button>
        </div>

      </div>
    </div>
  `;

  updateStats();
}

export function grade(){

  if(state.submitted) return;
  state.submitted = true;

  const fields = state.active.schema.fields;

  let score = 0;
  let nonYearTotal = 0;
  let nonYearCorrect = 0;
  let out = '';

  fields.forEach(f=>{
    const input = $('#'+f);

    const enabled = state.ACTIVE_FIELDS.includes(f);
    if(!enabled) return;

    const vRaw = input.value.trim();
    const v = vRaw.toLowerCase();

    const aRaw = (state.current[f] || '').toString();
    const a = aRaw.toLowerCase();

    let ok = false;

    if(f==='year' && aRaw.includes('-')){

      const p = aRaw.split('-').map(x=>parseInt(x.trim(),10));
      const n = parseInt(vRaw,10);

      if(!isNaN(n) && p.length===2){
        ok = n>=p[0] && n<=p[1];
      }

    } else if(f==='movement' && a.includes(' or ')) {

      const opts = a.split(/\s+or\s+/).map(x=>x.trim());
      ok = opts.includes(v);

    } else {

      ok = v && a && (
        v===a ||
        v.includes(a) ||
        a.includes(v)
      );
    }

    if(ok) score++;

    if(f !== 'year'){
      nonYearTotal++;

      if(ok){
        nonYearCorrect++;
      }
    }

    state.fieldStats[f].attempts++;

    if(ok){
      state.fieldStats[f].correct++;
    }

    if(f === 'year'){
      const actual = yearValue(aRaw);
      const guess = parseInt(vRaw,10);

      if(!isNaN(guess) && actual){
        state.yearErrors.push(guess - actual);
      }
    }

    input.disabled = true;

    out += `
      <div class='mb-1'>
        <span class='font-medium'>${f}:</span>
        <span class='${ok ? 'text-green-600':'text-red-600'}'>
          ${vRaw || '(empty)'}
        </span>
        <span class='text-zinc-500 ml-2'>
          (correct: ${state.current[f]})
        </span>
      </div>
    `;
  });

  state.answered++;
  state.totalFieldsAttempted += nonYearTotal;
  state.totalFieldsCorrect += nonYearCorrect;

  const acc =
    state.totalFieldsAttempted
      ? Math.round(
          100 *
          state.totalFieldsCorrect /
          state.totalFieldsAttempted
        )
      : 0;

  const rmse = calcRMSE(state.yearErrors);

  if(score === fields.length){
    state.perfect++;
    state.streak++;
    if(state.streak > state.bestStreak){
      state.bestStreak = state.streak;
    }
  } else {
    state.streak = 0;
  }

  $('#result').innerHTML =
    "<div class='bg-zinc-50 border border-zinc-200 rounded-2xl p-4'>" +
    "<div class='font-bold text-lg mb-3'>Score " +
    score + "/" + fields.length +
    "</div>" +
    out +
    "</div>";

  document
    .getElementById('quizFields')
    .classList.add('hidden');

  $('#submit').classList.add('hidden');

  const nextBtn = $('#next');

  /* fully reset button state */
  nextBtn.classList.remove('hidden');
  nextBtn.disabled = false;
  nextBtn.style.pointerEvents = 'auto';
  nextBtn.style.opacity = '1';

  /* rebind click every submit */
  nextBtn.onclick = next;

  /* focus for Enter key flow */
  nextBtn.focus();

  updateStats();
}
