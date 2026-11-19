import { $ } from '../utils/helpers.js';
import { accountBoxHtml } from '../app/sync.js';

export function renderHeader(){
  $('#siteHeader').innerHTML = `
    <div>
      <h1 class="text-6xl font-bold tracking-tight">
        Trivia Hub
      </h1>
      <div class="mt-2 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <p class="text-zinc-500 text-lg">boredom and curiosity</p>
        ${accountBoxHtml()}
      </div>
    </div>
  `;
}
