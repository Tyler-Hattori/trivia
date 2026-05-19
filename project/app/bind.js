import { grade, next } from '../features/quiz_engine.js';
import { state } from '../core/state.js';
import { $ } from '../utils/helpers.js';

function openQuizLightbox(src){
  if(!src) return;

  const overlay = document.createElement('div');

  function close(){
    document.removeEventListener('keydown', esc);
    overlay.remove();
  }

  function esc(e){
    if(e.key === 'Escape') close();
  }

  document.addEventListener('keydown', esc);

  overlay.style.cssText = `
    position:fixed;
    inset:0;
    background:rgba(0,0,0,.88);
    display:flex;
    align-items:center;
    justify-content:center;
    z-index:9999;
    cursor:pointer;
    padding:24px;
  `;

  overlay.innerHTML = `
    <img src="${src}" style="
      max-width:96vw;
      max-height:96vh;
      object-fit:contain;
      border-radius:12px;
      background:white;
    ">
  `;

  overlay.onclick = close;

  document.body.appendChild(overlay);
}

export function bindQuiz(){
  if(state.current){
    $('#img').src = state.current.image;
  }
  $('#img').onclick = () => openQuizLightbox(state.current?.image);

  $('#submit').onclick = () => grade();
  $('#next').onclick = next;

  const nextBtn = $('#next');

  nextBtn.classList.add('hidden');
  nextBtn.disabled = false;
  nextBtn.style.pointerEvents = 'auto';
  nextBtn.blur();

  $('#quizCount').value =
    String(state.QUIZ_SETTINGS.count);

  $('#quizOrder').value =
    state.QUIZ_SETTINGS.order;

  document
    .querySelectorAll('.fieldOpt')
    .forEach(box=>{
      box.checked =
        state.ACTIVE_FIELDS.includes(
          box.value
        );
    });

  document.onkeydown = (e) => {
    if(e.key !== 'Enter') return;

    if(state.submitted){
      e.preventDefault();
      next();
    } else {
      e.preventDefault();
      grade();
    }
  };
}