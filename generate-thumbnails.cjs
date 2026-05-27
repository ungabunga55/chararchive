#!/usr/bin/env node
'use strict';

/**
 * generate-thumbnails.cjs
 * Creates local lightweight webp thumbnails from downloaded full PNG cards.
 *
 * Input:  avatars/{creator}/{character}/chara_card_v2.png
 * Output: thumbs/{creator}/{character}/avatar.webp
 *
 * Usage:
 *   node generate-thumbnails.cjs
 *
 * Env vars:
 *   CONCURRENCY=8       parallel cwebp processes
 *   QUALITY=72          webp quality
 *   SIZE=240            max width/height in pixels
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const ROOT = process.cwd();
const INDEX_FILE = path.join(ROOT, 'w401i2.txt');
const AVATARS_DIR = path.join(ROOT, 'avatars');
const THUMBS_DIR = path.join(ROOT, 'thumbs');
const PROGRESS_FILE = path.join(ROOT, '.thumb-progress');
const CONCURRENCY = Number(process.env.CONCURRENCY || 8);
const QUALITY = Number(process.env.QUALITY || 72);
const SIZE = Number(process.env.SIZE || 240);
const BATCH_LOG = Number(process.env.BATCH_LOG || 100);

const stats = { done: 0, ok: 0, skipped: 0, missing: 0, failed: 0, bytes: 0, startTime: Date.now() };

function loadProgress() {
  try { return Number(fs.readFileSync(PROGRESS_FILE, 'utf8').trim()) || 0; }
  catch { return 0; }
}

function saveProgress(n) {
  fs.writeFileSync(PROGRESS_FILE, String(n));
}

async function readNames() {
  const names = [];
  const rl = readline.createInterface({ input: fs.createReadStream(INDEX_FILE, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    const name = line.trim();
    if (name) names.push(name);
  }
  return names;
}

async function makeOne(name) {
  const src = path.join(AVATARS_DIR, name, 'chara_card_v2.png');
  const dst = path.join(THUMBS_DIR, name, 'avatar.webp');

  try {
    await fsp.access(dst);
    stats.skipped++;
    return;
  } catch {}

  try {
    await fsp.access(src);
  } catch {
    stats.missing++;
    return;
  }

  await fsp.mkdir(path.dirname(dst), { recursive: true });

  try {
    await execFileAsync('cwebp', [
      '-quiet',
      '-q', String(QUALITY),
      '-resize', String(SIZE), String(SIZE),
      src,
      '-o', dst,
    ]);
    const stat = await fsp.stat(dst);
    stats.bytes += stat.size;
    stats.ok++;
  } catch {
    stats.failed++;
    await fsp.rm(dst, { force: true });
  }
}

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

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(0)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '?';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function printProgress(total) {
  const elapsed = (Date.now() - stats.startTime) / 1000;
  const rate = stats.done / Math.max(elapsed, 1);
  const eta = rate > 0 ? (total - stats.done) / rate : Infinity;
  const line = `${stats.done.toLocaleString()}/${total.toLocaleString()} ` +
    `ok:${stats.ok.toLocaleString()} skip:${stats.skipped.toLocaleString()} ` +
    `missing:${stats.missing.toLocaleString()} fail:${stats.failed.toLocaleString()} ` +
    `size:${formatBytes(stats.bytes)} ${rate.toFixed(1)}/s ETA:${formatDuration(eta)}`;

  if (process.stdout.isTTY) {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    const width = Math.max(20, (process.stdout.columns || 120) - 1);
    process.stdout.write(line.length > width ? line.slice(0, width - 1) : line);
  } else {
    process.stdout.write(`\r${line}`);
  }
}

async function main() {
  try { await execFileAsync('cwebp', ['-version']); }
  catch { console.error('cwebp not found. Install package: webp'); process.exitCode = 1; return; }

  await fsp.mkdir(THUMBS_DIR, { recursive: true });

  console.log('Reading name index...');
  const names = await readNames();
  console.log(`  ${names.length.toLocaleString()} names found`);
  console.log(`  source: ${AVATARS_DIR}`);
  console.log(`  output: ${THUMBS_DIR}`);
  console.log(`  cwebp quality=${QUALITY}, size=${SIZE}, concurrency=${CONCURRENCY}`);

  const startFrom = loadProgress();
  if (startFrom) console.log(`  Resuming from position ${startFrom.toLocaleString()}`);
  const slice = names.slice(startFrom);

  stats.startTime = Date.now();
  let lastSaved = startFrom;
  const saveTick = setInterval(() => {
    const current = startFrom + stats.done;
    if (current !== lastSaved) { saveProgress(current); lastSaved = current; }
  }, 5000);
  const progressTick = setInterval(() => printProgress(slice.length), 2000);

  const tasks = slice.map(name => () => makeOne(name));
  await runPool(tasks, CONCURRENCY);

  clearInterval(saveTick);
  clearInterval(progressTick);
  saveProgress(names.length);

  console.log('\nDone.');
  console.log(`  ok:      ${stats.ok.toLocaleString()}`);
  console.log(`  skipped: ${stats.skipped.toLocaleString()}`);
  console.log(`  missing: ${stats.missing.toLocaleString()} (no local PNG yet)`);
  console.log(`  failed:  ${stats.failed.toLocaleString()}`);
  console.log(`  size:    ${formatBytes(stats.bytes)} generated this run`);
}

main().catch(err => { console.error(err); process.exitCode = 1; });
