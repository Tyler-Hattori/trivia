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
  const seed = r.label?.length || 10; // deterministic per row
  const pseudo = 1 + ((seed * 9301 + 49297) % 233280) / 233280; // 1 → 2

  const ratio = r.imgRatio || (0.8 + pseudo * 0.8); // ~0.8 → 2.4
  let w = TIMELINE_SETTINGS.IMG_H * ratio;

  // reserve text readability
  w = Math.max(w, TIMELINE_SETTINGS.MIN_CARD_W);

  // avoid absurd panoramas
  w = Math.min(w, TIMELINE_SETTINGS.MAX_CARD_W);

  return Math.round(w);
}