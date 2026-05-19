#!/usr/bin/env node
'use strict';

/**
 * fetch-metadata.cjs
 * Fetches extra metadata (stars, chats, ratings, tagline, dates, etc.)
 * from the Chub API for every card in the local index, and caches it to
 * .chub-viewer-cache/meta.jsonl so the viewer can sort and filter by it.
 *
 * Usage (from the chub dump directory):
 *   node fetch-metadata.cjs
 *
 * Options (env vars):
 *   CONCURRENCY   parallel requests (default: 20)
 *
 * Already-fetched cards are skipped automatically — safe to re-run/resume.
 * Restart viewer-server.cjs after this finishes to load the new metadata.
 */

const fs      = require('node:fs');
const fsp     = require('node:fs/promises');
const path    = require('node:path');
const readline = require('node:readline');

const ROOT       = process.cwd();
const CACHE_DIR  = path.join(ROOT, '.chub-viewer-cache');
const CARDS_PATH = path.join(CACHE_DIR, 'cards.jsonl');
const META_PATH  = path.join(CACHE_DIR, 'meta.jsonl');
const GATEWAY_PRIMARY  = 'https://gateway.chub.ai/api/characters';
const GATEWAY_FALLBACK = 'https://ro.chub.ai/api/characters';
const CONCURRENCY = Number(process.env.CONCURRENCY || 20);

const stats = {
  done: 0, ok: 0, skipped: 0,
  gone: 0,       // 404/410 — card deleted from chub, expected
  failed: 0,     // network errors, timeouts, unexpected statuses
  startTime: Date.now(),
};
const errorSamples = []; // keep a few non-404 error examples to show at the end

// Global rate-limit gate — when any worker hits 429, all workers wait
let rateLimitGate = null;
function pauseAllForRateLimit(ms) {
  if (rateLimitGate) return; // already paused
  process.stdout.write(`\n  [rate limit] pausing all workers for ${ms / 1000}s…\n`);
  rateLimitGate = new Promise(r => setTimeout(() => { rateLimitGate = null; r(); }, ms));
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function readLines(file, onLine) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, 'utf8'),
    crlfDelay: Infinity,
  });
  for await (const line of rl) if (line.trim()) onLine(line);
}

async function readFullPaths() {
  const paths = [];
  await readLines(CARDS_PATH, line => {
    try { const c = JSON.parse(line); if (c.fullPath) paths.push(c.fullPath); } catch {}
  });
  return paths;
}

async function readDoneSet() {
  const done = new Set();
  if (!fs.existsSync(META_PATH)) return done;
  await readLines(META_PATH, line => {
    try { const m = JSON.parse(line); if (m.fullPath) done.add(m.fullPath); } catch {}
  });
  return done;
}

function extractMeta(fullPath, node) {
  const ratingScore = (node.rating && node.ratingCount)
    ? Math.round(node.rating * Math.log1p(node.ratingCount) * 100) / 100
    : 0;
  return {
    fullPath,
    tagline:        node.tagline          || '',
    starCount:      node.starCount        || 0,
    nFavorites:     node.n_favorites      || 0,
    nChats:         node.nChats           || 0,
    nMessages:      node.nMessages        || 0,
    rating:         node.rating           || 0,
    ratingCount:    node.ratingCount      || 0,
    ratingScore,
    forksCount:     node.forksCount       || 0,
    nTokens:        node.nTokens          || 0,
    lastActivityAt: node.lastActivityAt   || null,
    createdAt:      node.createdAt        || null,
    isUnlisted:     node.is_unlisted      || false,
    isPublic:       node.is_public        !== false,
    primaryFormat:  node.primaryFormat    || '',
    nsfwImage:      node.nsfw_image       || false,
  };
}

async function fetchOne(fullPath) {
  const headers = {
    'Origin':      'https://chub.ai',
    'Referer':     'https://chub.ai/',
    'User-Agent':  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    'ch-api-key':  'your account key - get it via network api (open your chub profile, f12, network, refresh, inspect for this parameter',
    'samwise':     'your account key - get it via network api (open your chub profile, f12, network, inspect for this parameter',
    'Accept':      '*/*',
  };

  // Try primary first, fall back to ro. on 404/403/429
  const endpoints = [GATEWAY_PRIMARY, GATEWAY_FALLBACK];
  let lastError;

  for (const base of endpoints) {
    const url = `${base}/${encodeURI(fullPath)}?full=true`;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (rateLimitGate) await rateLimitGate;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers });

        if (res.status === 404 || res.status === 410) {
          lastError = res.status;
          break; // try next endpoint
        }
        if (res.status === 403) {
          lastError = 403;
          break; // try next endpoint
        }
        if (res.status === 429) {
          const wait = (Number(res.headers.get('retry-after') || 0) || 30) * 1000 * (attempt + 1);
          pauseAllForRateLimit(wait);
          await rateLimitGate;
          lastError = 429;
          break; // try next endpoint after rate limit
        }
        if (res.status >= 500) {
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        if (!res.ok) {
          if (errorSamples.length < 10) errorSamples.push(`HTTP ${res.status} for ${fullPath} (${base})`);
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }

        const data = await res.json();
        if (!data.node) {
          if (errorSamples.length < 10) errorSamples.push(`no node in response for ${fullPath} (${base})`);
          lastError = 'no node';
          break; // try next endpoint
        }
        return extractMeta(fullPath, data.node);

      } catch (err) {
        lastError = err?.message || String(err);
        if (attempt === 4 && errorSamples.length < 10) errorSamples.push(`${lastError} — ${fullPath} (${base})`);
        if (attempt < 4) await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
  }

  // both endpoints exhausted
  return { fullPath, error: lastError ?? 'fetch failed' };
}

function printProgress(total) {
  const elapsed = (Date.now() - stats.startTime) / 1000;
  const rate    = stats.done / Math.max(elapsed, 1);
  const eta     = rate > 0 ? Math.round((total - stats.done) / rate) : '?';
  process.stdout.write(
    `\r  ${stats.done.toLocaleString()}/${total.toLocaleString()}  ` +
    `ok:${stats.ok} gone:${stats.gone} failed:${stats.failed}  ` +
    `${rate.toFixed(1)}/s  ETA:${eta}s   `
  );
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(CARDS_PATH)) {
    console.error('cards.jsonl not found — run viewer-server.cjs first to build the index.');
    process.exitCode = 1;
    return;
  }

  console.log('Reading cards index…');
  const allPaths = await readFullPaths();
  console.log(`  ${allPaths.length.toLocaleString()} cards`);

  console.log('Reading already-fetched metadata…');
  const done = await readDoneSet();
  console.log(`  ${done.size.toLocaleString()} already done`);

  const remaining = allPaths.filter(p => !done.has(p));
  console.log(`  ${remaining.length.toLocaleString()} to fetch\n`);

  if (!remaining.length) { console.log('Nothing to do. Restart viewer-server.cjs to reload.'); return; }

  const out = fs.createWriteStream(META_PATH, { flags: 'a', encoding: 'utf8' });

  let index = 0;
  stats.startTime = Date.now();

  async function worker() {
    while (index < remaining.length) {
      const fp = remaining[index++];
      const meta = await fetchOne(fp);
      out.write(JSON.stringify(meta) + '\n');
      if (meta.error === 404 || meta.error === 410 || meta.error === 403) stats.gone++;
      else if (meta.error) stats.failed++;
      else stats.ok++;
      stats.done++;
      if (stats.done % 200 === 0) printProgress(remaining.length);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await new Promise(r => out.end(r));

  console.log(`\nDone.`);
  console.log(`  ok:     ${stats.ok.toLocaleString()}  (metadata saved)`);
  console.log(`  gone:   ${stats.gone.toLocaleString()}  (404/410/403 — deleted or private, expected)`);
  console.log(`  failed: ${stats.failed.toLocaleString()}  (network/timeout errors)`);
  if (errorSamples.length) {
    console.log(`\nSample of real errors (non-404):`);
    errorSamples.forEach(s => console.log(`  ${s}`));
  }
  console.log('\nRestart viewer-server.cjs to load the new metadata.');
}

main().catch(err => { console.error(err); process.exitCode = 1; });
