import { state } from '../core/state.js';

export const $ = s => document.querySelector(s);

export function toast(msg){

  const overlay = document.createElement('div');

  overlay.className = `
    fixed
    inset-0
    z-[9999]
    bg-black/30
    backdrop-blur-sm
    flex
    items-center
    justify-center
    opacity-0
    transition-opacity
    duration-200
  `;

  const modal = document.createElement('div');

  modal.className = `
    bg-white
    border
    border-zinc-200
    shadow-2xl
    rounded-3xl
    px-8
    py-6
    text-lg
    font-semibold
    text-zinc-800
    scale-95
    transition-transform
    duration-200
  `;

  modal.textContent = msg;

  overlay.appendChild(modal);

  document.body.appendChild(overlay);

  requestAnimationFrame(() => {
    overlay.classList.remove('opacity-0');
    modal.classList.remove('scale-95');
  });

  setTimeout(() => {

    overlay.classList.add('opacity-0');
    modal.classList.add('scale-95');

    setTimeout(() => {
      overlay.remove();
    }, 200);

  }, 1200);
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

export function parseYears(v){
  const [start,end] = v.split('-').map(Number);
  return { start, end };
}

export function normalizeRow(row, dataset){

  if(dataset.key === 'art'){
    return {
      type: 'point',
      start: yearValue(row.year),
      label: row.title,
      image: row.image,
      meta: row.artist,
      dataset: dataset.key
    };
  }

  if(dataset.key === 'people'){
    const { start, end } = parseYears(row.years);

    if(!start || !end) return null;

    return {
      type: 'range',
      start,
      end,
      label: row.name,
      image: row.image,
      meta: row.occupation,
      dataset: dataset.key
    };
  }

  return null;
}
