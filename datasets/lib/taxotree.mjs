/**
 * The atlas hierarchy with KNOWN upper layers.
 *
 *   depth 0   root
 *   depth 1   subject group   History & Society · Culture · Science & Technology · Geography
 *   depth 2   subject         Visual arts · Films · Military and warfare · Physics …
 *   depth 3+  clusters        from embeddings, inside one subject only
 *
 * The top two layers come from Wikimedia's articletopic taxonomy (see
 * classify.mjs). Before this, every level was inferred from vectors, and the top
 * levels were where it failed: "Politician · President" x5 sibling rows, a
 * "Rococo" band over the year 1400. Embeddings are good at "which of these
 * paintings are closest" and bad at "what are the broad subjects", so now each
 * does only the job it is good at.
 *
 * The taxonomy is used STRUCTURALLY, never put into the embedded text. Putting
 * a broad label into the text was tried once with `domains` and it made the map
 * re-derive its own source files (docs/PIPELINE.md, "domains vs topics").
 */

import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './store.mjs';
import { buildTree, centroid, cosine } from './cluster.mjs';

export const TOP_ORDER = ['History & Society', 'Culture', 'Science & Technology', 'Geography', 'Other'];

/** A subject with fewer members than this is folded into "<group>: other". */
const MIN_SUBJECT = 25;   // Music (8), Food and drink (6)… one "Other culture" row, not six near-empty ones

export const taxoKey = (t) => `${t.top}|${t.mid}`;

export function loadTaxonomy(){
  const p = PATHS.taxonomy;
  if(!fs.existsSync(p)) return null;
  const t = JSON.parse(fs.readFileSync(p, 'utf8'));
  return t.entries && Object.keys(t.entries).length ? t : null;
}

/**
 * Build the tree. `rows[i].taxo` is {top, mid} or null. Returns { nodes } in
 * the same shape `buildTree` does (global row indices, centroids, children).
 */
export function buildTaxonomyTree(m, dim, rows, opts){
  const n = rows.length;
  // group -> subject -> row indices
  const groups = new Map();
  rows.forEach((e, i) => {
    const top = e.taxo?.top || 'Other';
    const mid = e.taxo?.mid || 'Unclassified';
    if(!groups.has(top)) groups.set(top, new Map());
    const g = groups.get(top);
    if(!g.has(mid)) g.set(mid, []);
    g.get(mid).push(i);
  });
  // Fold tiny subjects into one "other" per group, so the rail is not a list of
  // one-entry bands.
  for(const [top, g] of groups){
    const small = [...g].filter(([, r]) => r.length < MIN_SUBJECT);
    if(small.length >= 1 && g.size > 1){
      const merged = small.flatMap(([, r]) => r);
      for(const [mid] of small) g.delete(mid);
      g.set(`Other ${top.toLowerCase()}`, merged);
    }
  }

  const nodes = [];
  const add = (node) => { node.id = nodes.length; nodes.push(node); return node; };
  const root = add({ parent: -1, depth: 0, rows: [...Array(n).keys()], children: [] });
  root.centroid = centroid(m, dim, root.rows);

  const tops = [...groups.keys()].sort((a, b) => idx(a) - idx(b));
  for(const top of tops){
    const g = groups.get(top);
    const topRows = [...g.values()].flat();
    const tn = add({ parent: root.id, depth: 1, rows: topRows, children: [], fixedLabel: top, taxo: `${top}|*` });
    tn.centroid = centroid(m, dim, topRows);
    root.children.push(tn.id);

    // Subjects inside a group: biggest first, "Other …" last. Predictable beats
    // clever here — chain-ordering by centroid put Transportation (10 entries)
    // at the top of History & Society.
    const mids = [...g.keys()];
    const cents = mids.map((mid) => centroid(m, dim, g.get(mid)));
    const order = mids.map((_, i) => i).sort((a, b) =>
      (mids[a].startsWith('Other ') - mids[b].startsWith('Other ')) || (g.get(mids[b]).length - g.get(mids[a]).length));

    for(const k of order){
      const mid = mids[k];
      const midRows = g.get(mid);
      const mn = add({ parent: tn.id, depth: 2, rows: midRows, children: [], fixedLabel: mid, taxo: `${top}|${mid}` });
      mn.centroid = cents[k];
      tn.children.push(mn.id);
      graftClusters(mn, midRows);
    }
  }

  for(const nd of nodes) nd.n = nd.rows.length;
  return { nodes };

  /** Cluster one subject's members with the existing embedding tree, and hang it under `parent`. */
  function graftClusters(parent, gRows){
    if(gRows.length <= opts.leafTarget * 1.6) return;
    const sub = new Float32Array(gRows.length * dim);
    gRows.forEach((r, i) => sub.set(m.subarray(r * dim, r * dim + dim), i * dim));
    const { nodes: local } = buildTree(sub, dim, gRows.length, {
      ...opts, maxDepth: Math.max(1, (opts.maxDepth ?? 5) - 2),
    });
    // local[0] IS the subject node; its descendants get global ids.
    const map = new Map([[0, parent.id]]);
    for(const ln of local.slice(1)){
      const g = add({
        parent: null, depth: parent.depth + ln.depth, rows: ln.rows.map((r) => gRows[r]),
        children: [], centroid: ln.centroid,
      });
      map.set(ln.id, g.id);
    }
    for(const ln of local){
      const gid = map.get(ln.id);
      nodes[gid].children = ln.children.map((c) => map.get(c));
      for(const c of nodes[gid].children) nodes[c].parent = gid;
    }
  }
}

const idx = (top) => { const i = TOP_ORDER.indexOf(top); return i < 0 ? TOP_ORDER.length : i; };

/** Descend from `id` to the leaf whose centroid is nearest at each level. */
export function descendFrom(id, vec, nodes){
  while(nodes[id].children?.length){
    let best = nodes[id].children[0], bestS = -Infinity;
    for(const c of nodes[id].children){
      const s = cosine(vec, nodes[c].centroid);
      if(s > bestS){ bestS = s; best = c; }
    }
    id = best;
  }
  return id;
}

/**
 * Siblings sharing a label ("Byzantine" x5 under one parent) cannot be told
 * apart in the rail. Give each duplicate its next term that no sibling uses.
 */
export function disambiguateSiblings(nodes){
  const tc = (s) => String(s).replace(/\b\w/g, (c) => c.toUpperCase());
  for(const p of nodes){
    if(!p.children?.length) continue;
    const kids = p.children.map((c) => nodes[c]);
    const byLabel = new Map();
    for(const k of kids) (byLabel.get(k.label) || byLabel.set(k.label, []).get(k.label)).push(k);
    for(const [label, dup] of byLabel){
      if(dup.length < 2 || dup.some((d) => d.fixedLabel)) continue;
      const used = new Set(kids.map((k) => String(k.label).toLowerCase()));
      for(const d of dup){
        const parts = String(label).toLowerCase().split(' · ');
        const cands = [...(d.semanticTerms || []), ...(d.terms || []), ...((d.topTopics || []).map((t) => t[0]))]
          .map((t) => String(t).toLowerCase())
          .filter((t) => !parts.includes(t));
        const pick = cands.find((t) => !kids.some((k) => k !== d && String(k.label).toLowerCase().includes(t)));
        if(pick){ d.label = `${parts[0] ? tc(parts[0]) : label} · ${tc(pick)}`; used.add(d.label.toLowerCase()); }
      }
    }
  }
}
