#!/usr/bin/env node
/**
 * Publish the site to the `gh-pages` branch (GitHub Pages), as ONE commit that
 * replaces the last. Generated data (topics/, atlas/atlas.json, web/) is not
 * tracked on main; it ships here, so main's history never accumulates copies of
 * it (each rebuild rewrote ~300 MB of files).
 *
 *     node datasets/deploy.mjs           # assemble, check, force-push gh-pages
 *     node datasets/deploy.mjs --dry     # assemble into /tmp/trivia-site and stop
 *
 * Repo setting (once): Settings > Pages > Build and deployment > Source: Deploy
 * from a branch > gh-pages / (root).
 *
 * What ships: index.html, project/, datasets/lib/ (the browser imports a few
 * modules from it), datasets/topics/*.json except the whole-store intermediates
 * (all.json, store-lite.json, members-all is kept for the atlas), datasets/atlas/
 * atlas.json, datasets/web/. Not the store, details.json, vectors or site.db.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO_DIR, PATHS } from './lib/store.mjs';

const DRY = process.argv.includes('--dry');
const OUT = '/tmp/trivia-site';
const MAX_FILE = 50e6;   // GitHub warns at 50 MB and refuses 100 MB
const git = (args, cwd = OUT) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const copy = (rel, filter = () => true) => {
  const src = path.join(REPO_DIR, rel);
  if(!fs.existsSync(src)) throw new Error(`missing ${rel}: build first (topic.mjs --all, atlas.mjs, build-web.mjs)`);
  fs.cpSync(src, path.join(OUT, rel), { recursive: true, filter: (p) => !/\/\.|\.tmp$/.test(p.slice(src.length)) && filter(p) });
};

copy('index.html');
copy('project');
copy('datasets/lib');
copy('datasets/topics', (p) => fs.statSync(p).isDirectory() || (/\.json$/.test(p) && !/\/(all|store-lite)\.json$/.test(p)));
fs.mkdirSync(path.join(OUT, 'datasets/atlas'), { recursive: true });
fs.copyFileSync(PATHS.atlas, path.join(OUT, 'datasets/atlas/atlas.json'));
copy('datasets/web');
// Not Jekyll: serve files as they are (and faster to publish).
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

// Checks: sizes, and the files the site fetches at start exist.
let n = 0, total = 0, big = [];
const walk = (d) => { for(const f of fs.readdirSync(d)){ const p = path.join(d, f); const s = fs.statSync(p); if(s.isDirectory()) walk(p); else { n++; total += s.size; if(s.size > MAX_FILE) big.push(`${path.relative(OUT, p)} ${(s.size / 1e6).toFixed(0)} MB`); } } };
walk(OUT);
for(const f of ['datasets/topics/index.json', 'datasets/web/manifest.json', 'datasets/web/trows/manifest.json', 'datasets/atlas/atlas.json']){
  if(!fs.existsSync(path.join(OUT, f))) throw new Error(`site is missing ${f}`);
}
if(big.length) throw new Error(`files over ${MAX_FILE / 1e6} MB: ${big.join(', ')}`);
console.log(`  site: ${n} files, ${(total / 1e6).toFixed(0)} MB in ${OUT}`);
if(DRY){ console.log('  --dry: not pushed'); process.exit(0); }

const remote = git(['remote', 'get-url', 'origin'], REPO_DIR);
const head = git(['rev-parse', '--short', 'HEAD'], REPO_DIR);
git(['init', '-q', '-b', 'gh-pages']);
git(['add', '-A']);
git(['-c', 'user.name=deploy', '-c', 'user.email=deploy@localhost', 'commit', '-q', '-m', `Site from main ${head}, ${new Date().toISOString().slice(0, 16)}`]);
execFileSync('git', ['push', '-q', '--force', remote, 'gh-pages:gh-pages'], { cwd: OUT, stdio: 'inherit' });
console.log(`  pushed gh-pages (${head}). Pages serves it once the repo's Pages source is gh-pages.`);
