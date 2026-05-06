import { render } from './render.js';
import { loadQuizCounts } from '../data/github.js';
import * as quiz from '../features/quiz_engine.js';
import { openTimeline } from '../features/timeline_engine.js';

window.start = quiz.start;
window.exitQuiz = quiz.exitQuiz;
window.applyQuizSettings = quiz.applyQuizSettings;
window.restartQuiz = quiz.restartQuiz;
window.openTimeline = openTimeline;

document.addEventListener('DOMContentLoaded', () => {
  console.log('INIT LOADED');

  try {
    render();
    console.log('RENDER OK');
  } catch (e) {
    console.error('RENDER FAILED:', e);
  }

  loadQuizCounts();
});