import { $ } from '../utils/helpers.js';

export function renderHeader(){
  $('#siteHeader').innerHTML = `
    <div class="mb-10">
      <h1 class="text-6xl font-bold tracking-tight">
        Trivia Hub
      </h1>
      <p class="text-zinc-500 text-lg mt-2">
        boredom and curiosity
      </p>
    </div>
  `;
}
