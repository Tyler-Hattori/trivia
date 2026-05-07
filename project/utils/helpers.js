import { state } from '../core/state.js';

export const $ = s => document.querySelector(s);

export function toast(msg){
  const el = document.createElement('div');

  el.className = `
    fixed
    top-6
    right-6
    z-[9999]
    bg-white
    border
    border-zinc-200
    shadow-xl
    rounded-2xl
    px-5
    py-3
    text-sm
    font-medium
    text-zinc-800
    transition-all
    duration-300
    opacity-0
    translate-y-2
  `;

  el.textContent = msg;

  document.body.appendChild(el);

  requestAnimationFrame(() => {
    el.classList.remove('opacity-0', 'translate-y-2');
  });

  setTimeout(() => {
    el.classList.add('opacity-0', 'translate-y-2');

    setTimeout(() => {
      el.remove();
    }, 300);

  }, 1800);
}

export function shuffle(a){
  for(let i=a.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

export function yearNumSafe(v){
  const m=String(v||'').match(/\d{3,4}/);
  return m ? parseInt(m[0],10) : 0;
}

export function yearValue(v){
  v = String(v || '');
  
  if(v.includes('-')){
    const p = v.split('-').map(Number);
    if(p.length === 2) return (p[0] + p[1]) / 2;
  }

  return yearNumSafe(v);
}

export function nextItem(){
  if(!state.queue || state.queue.length === 0){
    return null;
  }
  return state.queue.shift();
}

export function calcRMSE(arr){
  if(!arr.length) return 0;

  const mse = arr.reduce((sum,v)=>sum + v*v,0) / arr.length;

  return Math.sqrt(mse);
}

export function thumbUrl(url){
  if(url.includes('upload.wikimedia.org')){
    return url + '?width=320';
  }

  return url;
}
