import { render } from './render.js';
import { loadQuizCounts } from '../data/github.js';
import * as quiz from '../features/quiz_engine.js';
import { openTimeline } from '../features/timeline_engine.js';
import { state } from '../core/state.js';
import { openGlobalTimeline } from '../features/global_timeline.js';

window.saveToken = () => {
  const val = document.getElementById('token').value;
  localStorage.setItem('gh_pat', val);
  state.token = val;
};

window.saveToken = () => {
  const val = document.getElementById('token').value;
  localStorage.setItem('gh_pat', val);
  state.token = val;
};
window.start = quiz.start;
window.exitQuiz = quiz.exitQuiz;
window.applyQuizSettings = quiz.applyQuizSettings;
window.restartQuiz = quiz.restartQuiz;
window.openTimeline = openTimeline;
window.openGlobalTimeline = openGlobalTimeline;

window.toggleTimelineFilters = () => {
  state.filtersOpen = !state.filtersOpen;
  render();
};

document.addEventListener('DOMContentLoaded', () => {
  try {
    render();
    console.log('RENDER OK');
  } catch (e) {
    console.error('RENDER FAILED:', e);
  }

  loadQuizCounts();
});
