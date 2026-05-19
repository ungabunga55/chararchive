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
const readline  = require('node:readline');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const ROOT          = process.cwd();
const INDEX_FILE    = path.join(ROOT, 'w401i2.txt');
const AVATARS_DIR   = path.join(ROOT, 'avatars');
const PROGRESS_FILE = path.join(ROOT, '.png-download-progress');
const FAILURE_FILE  = path.join(ROOT, '.png-download-failures.jsonl');
const AVATAR_BASE   = 'https://avatars.charhub.io/avatars';
const AVATAR_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const CONCURRENCY = Number(process.env.CONCURRENCY || 20);
const BATCH_LOG   = Number(process.env.BATCH_LOG   || 50);
const RETRY       = 3;
const RETRY_DELAY = 2000; // ms
const VERBOSE     = process.env.VERBOSE === '1';

const stats = { done: 0, ok: 0, skipped: 0, failed: 0, diskBytes: 0, savedBytes: 0, startTime: Date.now() };
const failReasons = new Map();

function markFailure(name, reason, retryable = false) {
  stats.failed++;
  const key = String(reason || 'unknown');
  failReasons.set(key, (failReasons.get(key) || 0) + 1);
  if (retryable) {
    fs.appendFileSync(FAILURE_FILE, `${JSON.stringify({ name, reason: key, at: new Date().toISOString() })}\n`);
  }
}

function logVerbose(message) {
  if (VERBOSE) console.log(`\n  ${message}`);
}

// ── pngquant setup ────────────────────────────────────────────────────────────

// detect pngquant at startup; compression is optional — skipped silently if absent
let pngquantBin = null;
async function detectPngquant() {
  for (const bin of ['pngquant']) {
    try {
      await execFileAsync(bin, ['--version']);
      pngquantBin = bin;
      console.log(`  pngquant found — PNGs will be compressed after download`);
      return;
    } catch {}
  }
  console.log('  pngquant not found — skipping compression (install with: sudo apt install pngquant)');
}

async function compressFile(dest) {
  const before = (await fsp.stat(dest)).size;
  if (!pngquantBin) return { finalSize: before, saved: 0 };
  try {
    // Quality 70-80. If pngquant cannot satisfy this, it exits non-zero and we keep the original.
    await execFileAsync(pngquantBin, ['--quality=70-80', '--ext', '.png', '--force', '--strip', dest]);
    const after = (await fsp.stat(dest)).size;
    const saved = Math.max(0, before - after);
    stats.savedBytes += saved;
    return { finalSize: after, saved };
  } catch {
    // compression failed — original file is untouched
    return { finalSize: before, saved: 0 };
  }
}

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

async function readFailureNames() {
  if (!fs.existsSync(FAILURE_FILE)) return [];
  const seen = new Set();
  const names = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(FAILURE_FILE, 'utf8'),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item.name && !seen.has(item.name)) {
        seen.add(item.name);
        names.push(item.name);
      }
    } catch {}
  }
  return names;
}

async function downloadOne(name) {
  const dest = path.join(AVATARS_DIR, name, 'chara_card_v2.png');

  // skip if already downloaded
  try {
    const existing = await fsp.stat(dest);
    stats.diskBytes += existing.size;
    stats.skipped++;
    logVerbose(`skip existing: ${name}`);
    return;
  } catch {}

  await fsp.mkdir(path.dirname(dest), { recursive: true });

  const url = `${AVATAR_BASE}/${encodeURI(name)}/chara_card_v2.png`;

  for (let attempt = 0; attempt < RETRY; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: AVATAR_HEADERS });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        await fsp.writeFile(dest, buf);
        const compressed = await compressFile(dest);
        stats.diskBytes += compressed.finalSize;
        stats.ok++;
        logVerbose(`ok: ${name}`);
        return;
      }
      if (res.status === 404 || res.status === 410) {
        markFailure(name, res.status, false); // gone, don't retry
        logVerbose(`gone ${res.status}: ${name}`);
        return;
      }
      if (attempt === RETRY - 1) {
        markFailure(name, res.status, true);
        logVerbose(`failed HTTP ${res.status}: ${name}`);
        return;
      }
    } catch (error) {
      if (attempt === RETRY - 1) {
        markFailure(name, error?.name || error?.message || 'fetch-error', true);
        logVerbose(`failed ${error?.name || error?.message || 'fetch-error'}: ${name}`);
        return;
      }
    }
    if (attempt < RETRY - 1) await sleep(RETRY_DELAY * (attempt + 1));
  }
  markFailure(name, 'failed', true);
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
  const diskSize = formatBytes(stats.diskBytes);
  const compSaved = formatBytes(stats.savedBytes);
  const line = `${stats.done.toLocaleString()}/${total.toLocaleString()} ` +
    `ok:${stats.ok.toLocaleString()} skip:${stats.skipped.toLocaleString()} fail:${stats.failed.toLocaleString()} ` +
    `disk:${diskSize} compSaved:${compSaved} ${rate.toFixed(1)}/s ETA:${formatDuration(eta)}`;

  if (process.stdout.isTTY) {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    const width = Math.max(20, (process.stdout.columns || 120) - 1);
    process.stdout.write(line.length > width ? line.slice(0, width - 1) : line);
  } else {
    process.stdout.write(`\r${line}`);
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(0)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

function formatDuration(seconds) {
  if (seconds === '?') return '?';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  await fsp.mkdir(AVATARS_DIR, { recursive: true });
  await detectPngquant();

  console.log('Reading name index…');
  const retryFailures = process.env.RETRY_FAILURES === '1';
  const names = retryFailures ? await readFailureNames() : await readNames();
  if (retryFailures) await fsp.rm(FAILURE_FILE, { force: true }); // rewrite with anything that still fails
  console.log(`  ${names.length.toLocaleString()} names found`);
  console.log(`  output: ${AVATARS_DIR}`);
  console.log(`  progress file: ${PROGRESS_FILE}`);
  console.log(`  retryable failures file: ${FAILURE_FILE}`);
  console.log(`  concurrency=${CONCURRENCY}, retries=${RETRY}, progress every ${BATCH_LOG} files + every 2s`);
  console.log(`  verbose per-file logs: ${VERBOSE ? 'on' : 'off'} (enable with VERBOSE=1)`);

  const startFrom = retryFailures ? 0 : loadProgress();
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
  const progressTick = setInterval(() => printProgress(tasks.length), 2000);
  await runPool(tasks, CONCURRENCY);

  clearInterval(saveTick);
  clearInterval(progressTick);
  if (!retryFailures) saveProgress(names.length); // mark fully done

  console.log('\n');
  console.log(`Done.`);
  console.log(`  ok:      ${stats.ok.toLocaleString()}`);
  console.log(`  skipped: ${stats.skipped.toLocaleString()}`);
  console.log(`  failed:  ${stats.failed.toLocaleString()}`);
  if (failReasons.size) {
    console.log('  failure breakdown:');
    for (const [reason, count] of [...failReasons.entries()].sort()) {
      console.log(`    ${reason}: ${count.toLocaleString()}`);
    }
    if (fs.existsSync(FAILURE_FILE)) {
      console.log(`  retryable failures saved to: ${FAILURE_FILE}`);
      console.log('  retry them later with: RETRY_FAILURES=1 node download-pngs.cjs');
    }
  }
  console.log(`  disk:    ${formatBytes(stats.diskBytes)} (actual PNG bytes processed this run)`);
  console.log(`  saved:   ${formatBytes(stats.savedBytes)} by compression`);
  console.log(`  time:    ${((Date.now() - stats.startTime) / 1000).toFixed(0)}s`);
  console.log(`  stored:  ${AVATARS_DIR}`);
}

main().catch(err => { console.error(err); process.exitCode = 1; });
