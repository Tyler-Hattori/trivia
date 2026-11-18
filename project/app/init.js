import { render } from './render.js';
import { openAtlas } from '../features/atlas/index.js';
import { openQuiz as renderClusterQuiz } from '../features/quiz/index.js';
import { initAccounts } from './sync.js';
import { route as topicRoute, isTopicRoute, openTopics } from '../features/topic/index.js';

/*
 * Routes, all hash-based so reload and Back work:
 *
 *   (none), #/home   the home page: search box + three doors
 *   #/topics         the topic list;  #/topic/<slug>[/timeline|/quiz]
 *   #/quiz           the quiz over every topic (settings: length, kinds, focus)
 *   #/review         what is due for review
 *   #/search/<q>     a page built from the whole store for a year, span or query
 *   #/cluster-quiz   the older quiz over the corpus by atlas cluster
 *
 * The atlas opens in its own window.
 */
window.openAtlas = openAtlas;
window.openQuiz = () => { location.hash = '#/quiz'; };
window.openClusterQuiz = () => { location.hash = '#/cluster-quiz'; };
window.openTopics = openTopics;

function routeAll(){
  if(isTopicRoute()){ topicRoute(); return; }
  topicRoute();                      // closes the topic overlay
  if(location.hash.startsWith('#/cluster-quiz')) renderClusterQuiz();
  else render();
}

window.addEventListener('hashchange', routeAll);
document.addEventListener('DOMContentLoaded', () => {
  initAccounts().catch((e) => console.warn('accounts:', e));
  try { routeAll(); console.log('RENDER OK'); }
  catch(e){ console.error('RENDER FAILED:', e); }
});
