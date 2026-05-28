import { state } from "../core/state.js";
import { $ } from '../utils/helpers.js';

export function renderQuiz(){
  return `

    <div class='grid xl:grid-cols-[320px_1fr] gap-8 items-start'>

      <!-- LEFT SIDEBAR -->
      <div class='space-y-6'>

        <!-- QUIZ SETTINGS -->
        <div class='bg-white p-5 rounded-2xl shadow-sm border border-zinc-200'>
          <div class='font-semibold text-lg mb-4'>Quiz Settings</div>

          <div class='space-y-4'>

            <div>
              <label class='block text-sm font-medium mb-1'>
                Number of Paintings
              </label>

              <select id='quizCount'
                class='border rounded w-full p-2'>
                <option value='10'>10</option>
                <option value='25'>25</option>
                <option value='50'>50</option>
                <option value='100'>100</option>
                <option value='0' selected>All Available</option>
              </select>
            </div>

            <div>
              <label class='block text-sm font-medium mb-1'>
                Fields to Quiz
              </label>

              <div class='space-y-2 text-sm'>

                ${state.active.schema.fields.map(f=>`
                  <label class='flex items-center gap-2'>
                    <input
                      type='checkbox'
                      class='fieldOpt'
                      value='${f}'
                      checked>
                    <span class='capitalize'>${f}</span>
                  </label>
                `).join('')}

              </div>
            </div>

            <div>
              <label class='block text-sm font-medium mb-1'>
                Order
              </label>

              <select id='quizOrder'
                class='border rounded w-full p-2'>
                <option value='random'>Random</option>
                <option value='chronological'>Chronological</option>
              </select>
            </div>

            <button onclick='applyQuizSettings()'
              class='w-full bg-black text-white rounded px-4 py-2 hover:bg-zinc-800'>
              Apply Settings
            </button>

            <button onclick='restartQuiz()'
              class='w-full border rounded px-4 py-2 hover:bg-zinc-50'>
              Start Over
            </button>

          </div>
        </div>

        <!-- TIMELINE -->
        ${
          state.active.key==='art' || state.active.key==='leaders'
          ? `
          <div class='bg-white p-5 rounded-2xl shadow-sm border border-zinc-200'>
            <div class='font-semibold mb-3'>Explore</div>

            <button onclick='openTimeline()'
              class='w-full bg-blue-600 text-white rounded px-4 py-2 hover:bg-blue-700'>
              Open Timeline
            </button>
          </div>
          `
          : ''
        }

      </div>

      <!-- MAIN QUIZ PANEL -->
      <div>
        <div class='bg-white p-5 rounded-2xl shadow-sm border border-zinc-200 h-[calc(100vh-200px)] flex flex-col'>
          <div class="text-lg font-semibold text-zinc-500 mb-3 mb-2 font-medium">
            Remaining: <span id="remainingCount">0</span>
          </div>

          <img id='img'
            class='w-full flex-1 min-h-0 object-contain bg-zinc-50 rounded-xl mb-3 cursor-zoom-in'>

          <div id='result' class='mb-5'></div>

          <div id='quizFields'
            class='grid md:grid-cols-2 gap-4'>
            ${state.active.schema.fields.map(f=> {
              const active = state.ACTIVE_FIELDS.includes(f);
              const value = state.current ? state.current[f] : '';

              if (active) {
                return `
                  <input id='${f}'
                    class='border border-zinc-200 bg-white px-4 py-3 w-full rounded-2xl text-lg'
                    placeholder='${f}'>
                `;
              } else {
                return `
                  <div class="px-4 py-3 bg-zinc-50 border border-dashed rounded-2xl text-zinc-500">
                    ${value}
                  </div>
                `;
              }
            }).join('')}
          </div>

          <div class='flex gap-2 mt-2'>
            <button id='submit'
              class='bg-blue-600 text-white px-5 py-2 rounded-xl hover:bg-blue-700 font-medium'>
              Submit
            </button>

            <button id='next'
              class='hidden border px-5 py-2 rounded-xl hover:bg-zinc-50 font-medium ml-auto'>
              Next →
            </button>
          </div>

        </div>

        <!-- ADD ENTRY -->
        <div class='mt-6 bg-white p-5 rounded-2xl shadow-sm border border-zinc-200'>
          <div class='font-semibold mb-3'>Add Entry</div>

          <input id='nimage'
            placeholder='image url'
            class='border border-zinc-200 bg-white px-4 py-3 w-full rounded-xl text-lg mb-3 focus:outline-none focus:ring-2 focus:ring-zinc-300'>

          <div class='grid md:grid-cols-2 gap-3'>
            ${state.active.schema.fields.map(f=>`
              <input id='n${f}'
                placeholder='${f}'
                class='border border-zinc-200 bg-white px-4 py-3 w-full rounded-xl text-lg focus:outline-none focus:ring-2 focus:ring-zinc-300'>
            `).join('')}
          </div>

          <button id='add'
            class='mt-4 w-full bg-black text-white px-4 py-3 rounded-xl hover:bg-zinc-800 font-medium'>
            Commit
          </button>
        </div>

      </div>
    </div>
  `;
}