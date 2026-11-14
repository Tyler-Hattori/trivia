import { render } from './render.js';
import { openAtlas } from '../features/atlas/index.js';
import { openQuiz } from '../features/quiz/index.js';
import { route as topicRoute, isTopicRoute, openTopics } from '../features/topic/index.js';

// The home page's three doors call these from inline onclick handlers.
window.openAtlas = openAtlas;
window.openQuiz = openQuiz;
window.openTopics = openTopics;

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
});
