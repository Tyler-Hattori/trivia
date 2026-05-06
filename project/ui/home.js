import { DATASETS } from '../core/settings.js';
import { state } from '../core/state.js';
import { $ } from '../utils/helpers.js';

export function renderHome(){
  return `
    <div class="grid md:grid-cols-2 gap-4">
      ${DATASETS.map(q=>`
        <button
          class="bg-white p-7 rounded-3xl shadow-sm border border-zinc-200 text-left hover:shadow-lg transition"
          onclick="start('${q.key}')">
          <div class="text-xl font-bold">${q.title}</div>
          <div class="text-lg font-semibold text-zinc-500 mb-3">${q.count || '...'} entries</div>
        </button>
      `).join('')}
    </div>

    <div class="mt-8 bg-white p-7 rounded-3xl shadow-sm border border-zinc-200">
      <div class="font-semibold mb-2">GitHub Token</div>
      <input id="token" class="border p-2 w-full rounded" value="${state.token}">
      <button onclick="saveToken()"
        class="mt-2 px-4 py-2 bg-black text-white rounded">
        Save
      </button>
    </div>
  `;
}