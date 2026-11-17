#!/usr/bin/env node
/**
 * Wikipedia series (sidebars / navboxes) for articles, topics and categories.
 *
 *   node datasets/series.mjs "History of England"            the series an article carries
 *   node datasets/series.mjs --members "History of England"  a template's members by heading
 *   node datasets/series.mjs --topics                        every built topic: own series + parents
 *   node datasets/series.mjs --category "History sidebar templates by country"   biggest first
 *
 * See lib/series.mjs and docs/TOPICS.md ("Series and the topic tree").
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seriesOf, seriesMembers, seriesInCategory } from './lib/series.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const fmt = (s) => `${s.name}${s.title && s.title !== s.name ? ` ("${s.title}")` : ''} · ${s.kind} · ${s.size ?? '?'} articles · on ${s.on ?? '?'} pages`;

if(arg('--members')){
  const s = await seriesMembers(arg('--members'));
  console.log(`\n  ${s.title} (${s.kind}, on ${s.on ?? '?'} pages)`);
  for(const g of s.groups) console.log(`\n  ${g.heading || '(top)'}\n    ${g.titles.join(' · ')}`);
} else if(arg('--category')){
  for(const s of await seriesInCategory(arg('--category'))) console.log(`  ${fmt(s)}`);
} else if(argv.includes('--topics')){
  const idx = JSON.parse(fs.readFileSync(path.join(HERE, 'topics', 'index.json'), 'utf8'));
  for(const t of idx.topics){
    if(t.source?.kind === 'site') continue;
    const { series } = await seriesOf(t.source.page, { name: t.title });
    const own = series.filter((s) => s.role === 'own'), par = series.filter((s) => s.role === 'parent');
    console.log(`${t.slug.padEnd(28)} own: ${own.map((s) => `${s.name} [${s.size}]`).join('; ') || '—'}${par.length ? `   | listed by: ${par.map((s) => `${s.name} [${s.size}]`).join('; ')}` : ''}`);
  }
} else if(argv[0]){
  const { title, series } = await seriesOf(argv[0], { name: arg('--name') || '' });
  console.log(`\n  ${title}`);
  for(const s of series) console.log(`  ${s.role.padEnd(6)} ${fmt(s)}`);
  if(!series.length) console.log('  no series sidebar or navbox');
} else {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 10).join('\n'));
}
