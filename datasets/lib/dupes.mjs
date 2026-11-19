/*
 * Duplicate mined events. Related-article mining finds the same happening on
 * several pages: "Pizarro reaches Inca territory" twice, "Spain licenses Pizarro
 * to conquer Peru" and "Pizarro receives royal approval to conquer Peru".
 *
 * Candidates are loose (same year ±1, some shared words or names); title words
 * alone cannot tell "Túpac Amaru becomes Inca" (1571) from "Execution of Túpac
 * Amaru" (1572). dedupe-events.mjs asks Claude Haiku about each candidate pair
 * and writes datasets/dupes-auto.json { "idA|idB": true|false }. A pair it has
 * not judged merges only when its titles are nearly the same (Jaccard ≥ 0.6).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DUPES_AUTO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dupes-auto.json');

const STOP = new Set('the and of in at on for with from into his her its their by to a an as is was are were first second after'.split(' '));
const fold = (t) => String(t).normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
// Plurals folded: "Mongol invasions of Japan" and "First Mongol invasion repelled".
export const contentWords = (t) => new Set(fold(t).toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => (w.length > 4 ? w.replace(/(?<!s)s$/, '') : w)));
const names = (t) => new Set((fold(t).match(/\b[A-Z][a-z]{2,}\b/g) || []).filter((w) => !STOP.has(w.toLowerCase()) && !/^(Battle|Death|Birth|Siege|Treaty|War|King|Queen|Emperor|Empire|Execution|Capital)$/.test(w)));
export function jaccard(a, b){
  const A = contentWords(a), B = contentWords(b);
  if(!A.size || !B.size) return 0;
  let n = 0; for(const w of A) if(B.has(w)) n++;
  return n / (A.size + B.size - n);
}
export const pairKey = (a, b) => (a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`);

/** Candidate duplicate pairs among titled mined events: [a, b, jaccard]. */
export function dupCandidates(events){
  const list = [...events].sort((a, b) => a.start - b.start);
  const out = [];
  for(let i = 0; i < list.length; i++){
    for(let j = i + 1; j < list.length && list[j].start - list[i].start <= 1; j++){
      const a = list[i], b = list[j];
      const s = jaccard(a.title, b.title);
      let shared = 0;
      if(s < 0.25){ const B = names(b.title); for(const w of names(a.title)) if(B.has(w)) shared++; }
      if(s >= 0.25 || shared >= 2) out.push([a, b, s]);
    }
  }
  return out;
}

export function readDupes(){
  try { return JSON.parse(fs.readFileSync(DUPES_AUTO, 'utf8')); } catch { return {}; }
}
