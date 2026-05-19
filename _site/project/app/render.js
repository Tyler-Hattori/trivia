import { renderHeader } from '../ui/header.js';
import { renderHome } from '../ui/home.js';
import { renderQuiz } from '../ui/quiz.js';
import { bindQuiz } from './bind.js';
import { updateStats } from '../ui/stats.js';
import { addEntry } from '../data/github.js';
import { state } from '../core/state.js';
import { $ } from '../utils/helpers.js';

export function render(){
  renderHeader();

  const app = $('#app');
  app.innerHTML = state.active ? renderQuiz() : renderHome();

  if(state.active){
    bindQuiz();
  }

  updateStats();

  if (state.active) {
    const addBtn = $('#add');
    if (addBtn) addBtn.onclick = addEntry;
  }
}