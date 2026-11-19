/*
 * The content audit (audit-entries.mjs), read by the builders.
 *
 * datasets/audit-auto.json
 *   { entries: { id: { d: 'ok'|'wrong', t: type, y?: suggested year } },
 *     topics:  { slug: { id: 'core'|'context'|'off' } } }
 * datasets/audit.json (by hand, same shape) wins over the model.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const AUDIT_AUTO = path.join(HERE, 'audit-auto.json');
export const AUDIT_HAND = path.join(HERE, 'audit.json');
export const AUDIT_TYPES = ['person', 'event', 'period', 'work', 'place', 'group', 'concept'];

let cache = null;
export function readAudit(){
  if(cache) return cache;
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
  const a = read(AUDIT_AUTO), h = read(AUDIT_HAND);
  const entries = { ...(a.entries || {}) };
  for(const [id, v] of Object.entries(h.entries || {})) entries[id] = { ...(entries[id] || {}), ...v };
  const topics = {};
  for(const src of [a.topics || {}, h.topics || {}]) for(const [s, m] of Object.entries(src)) topics[s] = { ...(topics[s] || {}), ...m };
  cache = { entries, topics };
  return cache;
}

// The audited type of a store entry, or null when unaudited.
export const auditType = (id) => {
  const t = readAudit().entries[id]?.t;
  return AUDIT_TYPES.includes(t) ? t : null;
};
