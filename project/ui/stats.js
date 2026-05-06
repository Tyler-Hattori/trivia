import { $, calcRMSE } from '../utils/helpers.js';
import { state } from '../core/state.js';

export function updateStats(){
  if(!state.active || !$('#statsBar')) return;

  const total =
    state.QUIZ_SETTINGS.count > 0
      ? state.QUIZ_SETTINGS.count
      : state.data.length;

  const remaining = total - state.answered;

  const acc =
    state.totalFieldsAttempted
      ? Math.round(
          100 *
          state.totalFieldsCorrect /
          state.totalFieldsAttempted
        )
      : 0;

  const rmse = calcRMSE(state.yearErrors);

  $('#statsBar').innerHTML = `
    <div class="inline-block text-right leading-snug tracking-tight whitespace-nowrap">

      <div class="text-sm text-zinc-700">
        <span class="font-medium">Acc</span> ${acc}%
        <span class="text-zinc-400">·</span>
        <span class="font-medium">Year</span> ±${rmse.toFixed(1)}y
        <span class="text-zinc-400">·</span>
        <span class="font-medium">Streak</span> ${state.streak}
      </div>

      <div class="text-xs text-zinc-500 mt-0.5">
        Best ${state.bestAcc}%
        <span class="text-zinc-400">·</span>
        Best ±${
          isFinite(state.bestRmse)
            ? state.bestRmse.toFixed(1)
            : '--'
        }y
        <span class="text-zinc-400">·</span>
        Best Streak ${state.bestStreak}
      </div>

    </div>
  `;

  const rem = $('#remainingCount');
  if(rem) rem.textContent = remaining;
}

function currentQuizSizeKey(){
  const count = state.QUIZ_SETTINGS.count;

  if(count === 0) return 'all';

  return String(count);
}

function bestKey(name){
  return `${state.active.key}_${currentQuizSizeKey()}_${name}`;
}

export function loadBestStats(){
  loadBestStreak();

  state.bestAcc = Number(
    localStorage.getItem(
      bestKey('bestAcc')
    ) || 0
  );

  const val =
    localStorage.getItem(
      bestKey('bestRmse')
    );

  state.bestRmse = 
    val === null
      ? Infinity
      : Number(val);
}

function loadBestStreak(){
  state.bestStreak = Number(
    localStorage.getItem(
      bestKey('bestStreak')
    ) || 0
  );
}

function saveBestStats(){
  localStorage.setItem(
    bestKey('bestAcc'),
    String(state.bestAcc)
  );

  if(isFinite(state.bestRmse)){
    localStorage.setItem(
      bestKey('bestRmse'),
      String(state.bestRmse)
    );
  }
}

export function commitBestIfNeeded({ acc, rmse }) {
  let improved = false;

  if (acc > state.bestAcc) {
    state.bestAcc = acc;
    improved = true;
  }

  if (rmse < state.bestRmse) {
    state.bestRmse = rmse;
    improved = true;
  }

  if (improved) {
    saveBestStats();
  }
}