import { $ } from '../utils/helpers.js';
import { state } from '../core/state.js';
import { exitQuiz } from '../features/quiz_engine.js';

export function renderHeader(){
  const el = $('#siteHeader');

  if(!state.active){
    el.innerHTML = `
      <div class="mb-10">
        <h1 class="text-6xl font-bold tracking-tight">
          Trivia Hub
        </h1>
        <p class="text-zinc-500 text-lg mt-2">
          boredom and curiosity
        </p>
      </div>
    `;
    return;
  }

  el.innerHTML = `
    <div class="flex items-start justify-between gap-10 mb-4">

      <div class="flex items-start gap-5">

        <button
          onclick="exitQuiz()"
          class="mt-1 border border-zinc-200 bg-white hover:bg-zinc-50
                 px-4 py-2 rounded-2xl shadow-sm text-lg">
          ← Home
        </button>

        <div>
          <div class="text-6xl font-bold tracking-tight leading-none">
            ${state.active.title}
          </div>
        </div>

      </div>

      <div
        id="statsBar"
        class="bg-white px-5 py-4 rounded-2xl shadow-sm border border-zinc-200 w-fit shrink-0">
      </div>

    </div>
  `;
}