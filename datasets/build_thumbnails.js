import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import sharp from 'sharp';
import csv from 'csv-parser';

const DATASET = process.argv[2];
if (!DATASET) {
  console.error("Usage: node build_thumbnails.js dataset.csv");
  process.exit(1);
}

const INPUT = path.resolve(DATASET);
const OUT_DIR = path.resolve('../thumbnails');
const META_PATH = path.join(OUT_DIR, 'meta.json');

const IMG_HEIGHT = 200;
const QUALITY = 80;

if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR);
}

// load existing meta if exists
let meta = {};
if (fs.existsSync(META_PATH)) {
  meta = JSON.parse(fs.readFileSync(META_PATH, 'utf-8'));
}

function slugify(str = "") {
  return str
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function buildName(row) {
  const keys = Object.keys(row);

  const title  = row[keys[1]] || "untitled";
  const artist = row[keys[2]] || "unknown";
  const year   = row[keys[3]] || "unknown";

  const base = `${slugify(artist)}_${slugify(title)}_${year}`;
  return `${base}.jpg`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

let lastRequest = 0;

async function throttle() {
  const minGap = 900; // critical
  const now = Date.now();
  const wait = Math.max(0, minGap - (now - lastRequest));
  await new Promise(r => setTimeout(r, wait + Math.random() * 200));
  lastRequest = Date.now();
}

async function fetchWithRetry(url, attempts = 1) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          "Accept": "image/*,*/*;q=0.8"
        }
      });

      if (res.ok) return res;

      if ([429, 500, 502, 503, 504].includes(res.status)) {
        if (i < attempts - 1) {
          const delay =
            Math.pow(2, i) * 600 +
            Math.random() * 300;

          // console.warn(
          //   `Retrying (${i + 1}/${attempts}) after ${res.status}`
          // );

          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }

      console.warn(`✗ ${res.status} ${url}`);
      return null;

    } catch (err) {

      if (i < attempts - 1) {
        const delay =
          Math.pow(2, i) * 600 +
          Math.random() * 300;

        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      console.warn(`✗ fetch failed ${url}`, err);
      return null;
    }
  }

  return null;
}

function shouldSkip(row) {
  const filename = buildName(row);
  const outPath = path.join(OUT_DIR, filename);

  return meta[filename] && fs.existsSync(outPath);
}

async function processRow(row) {
  const rawUrl = row[Object.keys(row)[0]];
  const url = rawUrl;

  if (!url) return;

  const filename = buildName(row);
  const outPath = path.join(OUT_DIR, filename);

  try {
    const res = await fetchWithRetry(url);
    if (!res) return;

    if (!res.ok) {
      console.log(`✗ Failed to fetch: ${filename}`);
      return;
    }

    const buffer = Buffer.from(await res.arrayBuffer());

    const img = sharp(buffer);
    const { width, height } = await img.metadata();

    if (!width || !height) return;

    const ratio = width / height;

    // resize + save
    await img
      .resize({ height: IMG_HEIGHT })
      .jpeg({ quality: QUALITY })
      .toFile(outPath);

    meta[filename] = ratio;

    console.log(`✓ ${filename} (${ratio.toFixed(2)})`);

  } catch (e) {
    console.log(`✗ Failed: ${filename}`);
  }
}

async function run() {
  const rows = [];

  // 1. fully read CSV (awaited properly)
  await new Promise((resolve, reject) => {
    fs.createReadStream(INPUT)
      .pipe(csv())
      .on('data', row => rows.push(row))
      .on('end', resolve)
      .on('error', reject);
  });

  // 2. process rows
  for (const row of rows) {
    if (shouldSkip(row)) {
      console.log(`→ Skipping existing: ${buildName(row)}`);
      continue;
    }

    await throttle();
    await processRow(row);
  }

  // 3. save meta
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2));
  console.log('Meta saved.');
}

run();