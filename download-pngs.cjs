#!/usr/bin/env node
'use strict';

/**
 * download-pngs.cjs
 * Downloads all character card PNGs from avatars.charhub.io into ./avatars/
 *
 * Usage (from the chub dump directory):
 *   node download-pngs.cjs
 *
 * Options (env vars):
 *   CONCURRENCY   parallel downloads (default: 20)
 *   BATCH_LOG     print progress every N files (default: 500)
 *
 * Progress is saved to .png-download-progress so you can Ctrl-C and resume.
 * Already-existing files are skipped automatically.
 */

const fs   = require('node:fs');
const fsp  = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');

const ROOT          = process.cwd();
const INDEX_FILE    = path.join(ROOT, 'w401i2.txt');
const AVATARS_DIR   = path.join(ROOT, 'avatars');
const PROGRESS_FILE = path.join(ROOT, '.png-download-progress');
const AVATAR_BASE   = 'https://avatars.charhub.io/avatars';

const CONCURRENCY = Number(process.env.CONCURRENCY || 20);
const BATCH_LOG   = Number(process.env.BATCH_LOG   || 500);
const RETRY       = 3;
const RETRY_DELAY = 2000; // ms

const stats = { done: 0, ok: 0, skipped: 0, failed: 0, startTime: Date.now() };

// ── helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadProgress() {
  try { return Number(fs.readFileSync(PROGRESS_FILE, 'utf8').trim()) || 0; }
  catch { return 0; }
}

function saveProgress(n) {
  fs.writeFileSync(PROGRESS_FILE, String(n));
}

async function readNames() {
  const names = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(INDEX_FILE, 'utf8'),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const name = line.trim();
    if (name) names.push(name);
  }
  return names;
}

async function downloadOne(name) {
  const dest = path.join(AVATARS_DIR, name, 'chara_card_v2.png');

  // skip if already downloaded
  try { await fsp.access(dest); stats.skipped++; return; } catch {}

  await fsp.mkdir(path.dirname(dest), { recursive: true });

  const url = `${AVATAR_BASE}/${encodeURI(name)}/chara_card_v2.png`;

  for (let attempt = 0; attempt < RETRY; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        await fsp.writeFile(dest, buf);
        stats.ok++;
        return;
      }
      if (res.status === 404 || res.status === 410) {
        stats.failed++; // gone, don't retry
        return;
      }
    } catch { /* network error, retry below */ }
    if (attempt < RETRY - 1) await sleep(RETRY_DELAY * (attempt + 1));
  }
  stats.failed++;
}

// simple semaphore-based concurrency pool
async function runPool(tasks, concurrency) {
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      await tasks[i]();
      stats.done++;
      if (stats.done % BATCH_LOG === 0) printProgress(tasks.length);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

function printProgress(total) {
  const elapsed = (Date.now() - stats.startTime) / 1000;
  const rate    = stats.done / Math.max(elapsed, 1);
  const eta     = rate > 0 ? Math.round((total - stats.done) / rate) : '?';
  process.stdout.write(
    `\r  ${stats.done.toLocaleString()}/${total.toLocaleString()} ` +
    `| ok:${stats.ok.toLocaleString()} ` +
    `skipped:${stats.skipped.toLocaleString()} ` +
    `failed:${stats.failed.toLocaleString()} ` +
    `| ${rate.toFixed(1)}/s  ETA:${eta}s   `
  );
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  await fsp.mkdir(AVATARS_DIR, { recursive: true });

  console.log('Reading name index…');
  const names = await readNames();
  console.log(`  ${names.length.toLocaleString()} names found`);

  const startFrom = loadProgress();
  if (startFrom > 0) {
    console.log(`  Resuming from position ${startFrom.toLocaleString()}`);
  }

  const slice = names.slice(startFrom);
  stats.startTime = Date.now();

  // Save progress every 1000 completions
  let lastSaved = startFrom;
  const saveTick = setInterval(() => {
    const current = startFrom + stats.done;
    if (current !== lastSaved) {
      saveProgress(current);
      lastSaved = current;
    }
  }, 5000);

  console.log(`  Downloading with concurrency=${CONCURRENCY}…`);
  const tasks = slice.map(name => () => downloadOne(name));
  await runPool(tasks, CONCURRENCY);

  clearInterval(saveTick);
  saveProgress(names.length); // mark fully done

  console.log('\n');
  console.log(`Done.`);
  console.log(`  ok:      ${stats.ok.toLocaleString()}`);
  console.log(`  skipped: ${stats.skipped.toLocaleString()}`);
  console.log(`  failed:  ${stats.failed.toLocaleString()}`);
  console.log(`  time:    ${((Date.now() - stats.startTime) / 1000).toFixed(0)}s`);
  console.log(`  stored:  ${AVATARS_DIR}`);
}

main().catch(err => { console.error(err); process.exitCode = 1; });
