#!/usr/bin/env node
/**
 * The dev server. Use this instead of `python3 -m http.server 8777`.
 *
 *   node datasets/serve.mjs            # http://localhost:8777
 *   node datasets/serve.mjs --port 9000
 *
 * Why this exists: `python3 -m http.server` sends `Last-Modified` and no
 * `Cache-Control`, so Chrome applies a *heuristic* freshness lifetime and serves
 * from disk cache without revalidating. That cache survives in the profile, so an
 * ordinary reload can hand you a module graph from before your edits — `index.html`
 * revalidates while the cached `home.js` does not, and the page renders the old UI
 * with no error anywhere. It cost a session: a newly added button was "not there"
 * while the bytes on the wire were correct the whole time.
 *
 * It also made `qa-atlas.mjs` report 50/50 against an `atlas.json` two builds old.
 *
 * Everything here is served `no-store`. This is a dev server for a static site on
 * localhost; there is nothing to gain from caching and a whole class of phantom bugs
 * to lose.
 */

import { createServer } from 'node:http';
import { stat, readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureUp, embed } from './lib/ollama.mjs';
import { truncateNormalize, DIM } from './lib/store.mjs';
import { reclusterSubset } from './lib/reclusterApi.mjs';

const ROOT = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const argv = process.argv.slice(2);
const arg = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const PORT = Number(arg('--port') || process.env.PORT || 8777);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.bin': 'application/octet-stream',
  '.woff2': 'font/woff2',
};

/** Resolve a URL path to a file inside ROOT, or null if it escapes. */
function resolve(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const full = normalize(join(ROOT, decoded));
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return null; // ../ traversal
  return full;
}

const server = createServer(async (req, res) => {
  const send = (code, body, type) => {
    res.writeHead(code, {
      'content-type': type || 'text/plain; charset=utf-8',
      // The entire point of this file.
      'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
      pragma: 'no-cache',
      expires: '0',
    });
    res.end(body);
  };

  /*
   * Semantic search's only server-side piece: embed the query text with the
   * same local model every entry was embedded with, so the browser can score
   * cosine similarity against the vectors it already fetches statically
   * (vectors.bin + vectors.json, served like any other file below). Kept
   * short-timeout and fail-soft — this is an enhancement over plain substring
   * search, and the frontend treats anything but 200 as "unavailable" and
   * carries on without it.
   */
  if (req.method === 'GET' && (req.url || '').startsWith('/api/embed-query')) {
    const q = new URL(req.url, 'http://x').searchParams.get('q') || '';
    if (!q.trim()) return send(400, JSON.stringify({ error: 'missing q' }), 'application/json; charset=utf-8');
    try {
      const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), ms));
      await Promise.race([ensureUp(), timeout(3000)]);
      const [vec] = await Promise.race([embed([q]), timeout(8000)]);
      const norm = truncateNormalize(vec, DIM);
      return send(200, JSON.stringify(Array.from(norm)), 'application/json; charset=utf-8');
    } catch (e) {
      return send(503, JSON.stringify({ error: String(e.message || e) }), 'application/json; charset=utf-8');
    }
  }

  /*
   * "Focus mode"'s only server-side piece: re-cluster a search's matched
   * entries into their own small hierarchy (see reclusterApi.mjs), so the
   * browser can lay them out by their own mutual similarity instead of their
   * position in the corpus-wide one. Unlike /api/embed-query above, this has no
   * external dependency (no Ollama call — labelling falls back to c-TF-IDF), so
   * fail-soft here just means "malformed input" or "too many ids," not
   * "a model server is down."
   */
  if (req.method === 'POST' && (req.url || '').startsWith('/api/recluster')) {
    const MAX_BODY = 512 * 1024;   // 2000 ids at ~40 chars each is well under this
    let body = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) return send(413, JSON.stringify({ error: 'request too large' }), 'application/json; charset=utf-8');
      try {
        const { ids } = JSON.parse(body || '{}');
        const result = reclusterSubset(ids);
        return send(200, JSON.stringify(result), 'application/json; charset=utf-8');
      } catch (e) {
        return send(400, JSON.stringify({ error: String(e.message || e) }), 'application/json; charset=utf-8');
      }
    });
    return;
  }

  let path = resolve(req.url || '/');
  if (!path) return send(403, 'forbidden');

  try {
    let s = await stat(path);
    if (s.isDirectory()) {
      path = join(path, 'index.html');
      s = await stat(path);
    }
    const body = await readFile(path);
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'content-type': TYPES[extname(path).toLowerCase()] || 'application/octet-stream',
        'content-length': String(s.size),
        'cache-control': 'no-store',
      });
      return res.end();
    }
    send(200, body, TYPES[extname(path).toLowerCase()] || 'application/octet-stream');
  } catch (e) {
    send(e.code === 'ENOENT' ? 404 : 500, `${e.code || 'error'}: ${req.url}`);
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`  port ${PORT} is already in use. Something else is serving it:`);
    console.error(`    lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
    console.error(`  Kill it first — a stale python http.server on this port is the`);
    console.error(`  usual reason edits appear to have no effect.`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, () => {
  console.log(`  serving ${ROOT}`);
  console.log(`  http://localhost:${PORT}/   (no-store, nothing is cached)`);
});
