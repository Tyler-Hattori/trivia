import { render } from './render.js';
import { openAtlas } from '../features/atlas/index.js';
import { openQuiz as renderClusterQuiz } from '../features/quiz/index.js';
import { route as topicRoute, isTopicRoute, openTopics } from '../features/topic/index.js';

/*
 * Routes. The topic list is the home page (no hash, or #/topics); topics, the
 * cross-topic quiz and review are all hash routes, so reload and Back work.
 *
 *   #/cluster-quiz   the older quiz over the whole corpus by atlas cluster
 *   #/home           the old three-door page (kept for reference, not linked)
 *
 * The atlas opens in its own window.
 */
window.openAtlas = openAtlas;
window.openQuiz = () => { location.hash = '#/cluster-quiz'; };
window.openTopics = openTopics;

function routeAll(){
  if(isTopicRoute()){ topicRoute(); return; }
  topicRoute();                      // closes the topic overlay
  if(location.hash.startsWith('#/cluster-quiz')) renderClusterQuiz();
  else if(location.hash === '#/home') render();
  else location.replace('#/topics');
}

window.addEventListener('hashchange', routeAll);
document.addEventListener('DOMContentLoaded', () => {
  try { routeAll(); console.log('RENDER OK'); }
  catch(e){ console.error('RENDER FAILED:', e); }
});
