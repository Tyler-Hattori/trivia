import { TIMELINE_SETTINGS } from '../core/settings.js';

export function parseMovements(v){
  if(!v) return [];

  return v
    .replace(/\(.*?\)/g,'')
    .split('/')
    .map(s=>s.trim().toLowerCase())
    .filter(Boolean);
}

export function estimateCardWidth(r){
  const ratio =
    Number(r.imgRatio || 1.35); // fallback landscape-ish

  let w = TIMELINE_SETTINGS.IMG_H * ratio;

  // reserve text readability
  w = Math.max(w, TIMELINE_SETTINGS.MIN_CARD_W);

  // avoid absurd panoramas
  w = Math.min(w, TIMELINE_SETTINGS.MAX_CARD_W);

  return Math.round(w);
}