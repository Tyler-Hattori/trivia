import { render } from './render.js';
import { loadQuizCounts } from '../data/github.js';
import * as quiz from '../features/quiz_engine.js';
import { openTimeline } from '../features/timeline_engine.js';
import { state } from '../core/state.js';
import { openGlobalTimeline } from '../features/global_timeline.js';
import { openAtlas } from '../features/atlas/index.js';
import { openQuiz } from '../features/quiz/index.js';
import { route as topicRoute, isTopicRoute, openTopics } from '../features/topic/index.js';

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
window.openAtlas = openAtlas;
window.openQuiz = openQuiz;
window.openTopics = openTopics;

window.toggleTimelineFilters = () => {
  state.filtersOpen = !state.filtersOpen;
  render();
};

// Topics live on hash routes (#/topics, #/topic/<slug>[/read|/quiz]) so reload
// and Back work. Anything else is the home screen.
window.addEventListener('hashchange', () => { topicRoute(); if(!isTopicRoute()) render(); });

document.addEventListener('DOMContentLoaded', () => {
  if(isTopicRoute()) topicRoute();
  try {
    render();
    console.log('RENDER OK');
  } catch (e) {
    console.error('RENDER FAILED:', e);
  }

  // `loadQuizCounts` fetched a row count per CSV over the GitHub API to label the
  // eight dataset tiles. The home screen is two buttons now, so nothing displays
  // those counts and the call is dropped rather than left doing a network round
  // trip for nobody. The function stays for the unlinked per-dataset quiz.
});
