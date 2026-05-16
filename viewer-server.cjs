#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const readline = require('node:readline');
const { URL } = require('node:url');

const ROOT = process.cwd();
const PORT = Number(process.env.PORT || 8787);
const CACHE_DIR = path.join(ROOT, '.chub-viewer-cache');
const INDEX_PATH = path.join(CACHE_DIR, 'cards.jsonl');
const INDEX_TMP_PATH = path.join(CACHE_DIR, 'cards.jsonl.tmp');
const HTML_PATH = path.join(ROOT, 'viewer.html');
const AVATARS_DIR = path.join(ROOT, 'avatars');

const cards = [];
const status = {
  mode: 'starting',
  ready: false,
  indexing: false,
  scanned: 0,
  kept: 0,
  errors: 0,
  message: 'Starting viewer',
  startedAt: Date.now(),
  finishedAt: null,
};

function json(res, code, value) {
  const body = JSON.stringify(value);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function text(res, code, value) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(value);
}

function safeFileName(name, fallback) {
  const base = String(name || fallback || 'card')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return base || 'card';
}

function relPath(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join('/');
}

function resolveJsonPath(rawPath) {
  if (!rawPath || rawPath.includes('\0')) return null;
  const resolved = path.resolve(ROOT, rawPath);
  if (!resolved.startsWith(ROOT + path.sep)) return null;
  if (!resolved.endsWith('.json')) return null;
  return resolved;
}

function getChub(data) {
  return data?.extensions?.chub || {};
}

function getImageUrl(data) {
  const fullPath = getChub(data).full_path;
  if (typeof fullPath === 'string' && fullPath) {
    // /img/ serves local file if downloaded, falls back to charhub automatically
    return `/img/${encodeURI(fullPath)}/chara_card_v2.png`;
  }
  return '';
}

function makeRecord(jsonPath, parsed) {
  const data = parsed?.data || {};
  const chub = getChub(data);
  return {
    jsonPath: relPath(jsonPath),
    id: chub.id ?? null,
    name: data.name || '(unnamed)',
    creator: data.creator || '',
    fullPath: chub.full_path || '',
    avatar: getImageUrl(data),
    tags: Array.isArray(data.tags) ? data.tags.slice(0, 24) : [],
  };
}

async function parseCardFile(filePath) {
  const raw = await fsp.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || parsed.spec !== 'chara_card_v2' || !parsed.data) return null;
  return { parsed, record: makeRecord(filePath, parsed) };
}

async function loadExistingIndex() {
  status.mode = 'loading-cache';
  status.message = 'Loading cached metadata index';
  const input = fs.createReadStream(INDEX_PATH, 'utf8');
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    try {
      cards.push(JSON.parse(line));
      status.kept = cards.length;
    } catch {
      status.errors += 1;
    }
  }
  status.ready = true;
  status.mode = 'ready';
  status.message = `Loaded ${cards.length.toLocaleString()} cached cards`;
  status.finishedAt = Date.now();
}

async function* iterJsonFiles() {
  const topEntries = await fsp.readdir(ROOT, { withFileTypes: true });
  const topDirs = topEntries
    .filter((entry) => entry.isDirectory() && /^\d{2}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  for (const top of topDirs) {
    const topPath = path.join(ROOT, top);
    const midEntries = await fsp.readdir(topPath, { withFileTypes: true });
    const midDirs = midEntries
      .filter((entry) => entry.isDirectory() && /^\d{2}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();

    for (const mid of midDirs) {
      const midPath = path.join(topPath, mid);
      const fileEntries = await fsp.readdir(midPath, { withFileTypes: true });
      const jsonFiles = fileEntries
        .filter((entry) => entry.isFile() && /^\d{3}\.json$/.test(entry.name))
        .map((entry) => entry.name)
        .sort();

      for (const file of jsonFiles) yield path.join(midPath, file);
    }
  }
}

async function buildIndex() {
  status.mode = 'building-cache';
  status.ready = true;
  status.indexing = true;
  status.message = 'Building metadata index in the background';
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  const out = fs.createWriteStream(INDEX_TMP_PATH, 'utf8');

  try {
    for await (const filePath of iterJsonFiles()) {
      status.scanned += 1;
      try {
        const result = await parseCardFile(filePath);
        if (!result) continue;
        cards.push(result.record);
        status.kept = cards.length;
        out.write(`${JSON.stringify(result.record)}\n`);
      } catch {
        status.errors += 1;
      }
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }

  await fsp.rename(INDEX_TMP_PATH, INDEX_PATH);
  status.indexing = false;
  status.mode = 'ready';
  status.message = `Indexed ${cards.length.toLocaleString()} cards`;
  status.finishedAt = Date.now();
}

function queryCards(params) {
  const q = (params.get('q') || '').trim().toLowerCase();
  const offset = Math.max(0, Number(params.get('offset') || 0));
  const limit = Math.min(80, Math.max(1, Number(params.get('limit') || 40)));
  const terms = q.split(/\s+/).filter(Boolean);

  let filtered = cards;
  if (terms.length) {
    filtered = cards.filter((card) => {
      const textValue = [card.name, card.creator, ...(card.tags || [])]
        .join(' ')
        .toLowerCase();
      return terms.every((term) => textValue.includes(term));
    });
  }

  return {
    total: filtered.length,
    offset,
    limit,
    items: filtered.slice(offset, offset + limit),
    status: publicStatus(),
  };
}

function publicStatus() {
  return {
    ...status,
    cards: cards.length,
    uptimeSeconds: Math.round((Date.now() - status.startedAt) / 1000),
  };
}

async function readSafeCard(rawPath) {
  const jsonPath = resolveJsonPath(rawPath);
  if (!jsonPath) return { error: 'Invalid JSON path', code: 400 };
  const result = await parseCardFile(jsonPath);
  if (!result) return { error: 'Not a Chara Card v2 JSON file', code: 404 };
  return { jsonPath, ...result };
}

async function handleCardJson(reqUrl, res) {
  const card = await readSafeCard(reqUrl.searchParams.get('path'));
  if (card.error) return json(res, card.code, { error: card.error });
  return json(res, 200, { record: card.record, card: card.parsed });
}

async function handleJsonDownload(reqUrl, res, method = 'GET') {
  const card = await readSafeCard(reqUrl.searchParams.get('path'));
  if (card.error) return text(res, card.code, card.error);
  const raw = await fsp.readFile(card.jsonPath);
  const filename = `${safeFileName(card.record.name, card.record.fullPath)}.json`;
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
    'content-length': raw.length,
  });
  if (method === 'HEAD') return res.end();
  res.end(raw);
}

// ── PNG + card-data embedding (Chara Card V2 spec) ───────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ b) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makeTEXtChunk(keyword, text) {
  const data = Buffer.concat([Buffer.from(keyword + '\0'), Buffer.from(text, 'latin1')]);
  const type = Buffer.from('tEXt');
  const len  = Buffer.allocUnsafe(4); len.writeUInt32BE(data.length);
  const crc  = Buffer.allocUnsafe(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([len, type, data, crc]);
}

function injectCardIntoPng(pngBuf, cardJson) {
  const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!pngBuf.subarray(0, 8).equals(PNG_SIG)) throw new Error('Not a valid PNG');

  // IHDR is always 25 bytes (4 len + 4 type + 13 data + 4 crc) after the 8-byte signature
  const AFTER_IHDR = 33;

  // strip any existing 'chara' tEXt chunks from the remainder
  const tail     = pngBuf.subarray(AFTER_IHDR);
  const filtered = [];
  let i = 0;
  while (i + 12 <= tail.length) {
    const chunkLen  = tail.readUInt32BE(i);
    const chunkType = tail.subarray(i + 4, i + 8).toString('ascii');
    const total     = 4 + 4 + chunkLen + 4;
    if (chunkType === 'tEXt') {
      const d = tail.subarray(i + 8, i + 8 + chunkLen);
      const kw = d.subarray(0, d.indexOf(0)).toString();
      if (kw === 'chara') { i += total; continue; }
    }
    filtered.push(tail.subarray(i, i + total));
    i += total;
  }

  const b64chunk = makeTEXtChunk('chara', Buffer.from(JSON.stringify(cardJson)).toString('base64'));

  return Buffer.concat([pngBuf.subarray(0, AFTER_IHDR), b64chunk, ...filtered]);
}

async function handlePngDownload(reqUrl, res, method = 'GET') {
  const card = await readSafeCard(reqUrl.searchParams.get('path'));
  if (card.error) return text(res, card.code, card.error);
  const fullPath = card.record.fullPath;
  if (!fullPath) return text(res, 404, 'No avatar path found');

  // get raw PNG bytes — local disk first, charhub fallback
  let pngBuf;
  const localFile = path.join(AVATARS_DIR, fullPath, 'chara_card_v2.png');
  try {
    pngBuf = await fsp.readFile(localFile);
  } catch {
    const remoteUrl = `https://avatars.charhub.io/avatars/${encodeURI(fullPath)}/chara_card_v2.png`;
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const upstream = await fetch(remoteUrl, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
        if (!upstream.ok) return text(res, upstream.status, `Avatar fetch failed: ${upstream.status}`);
        pngBuf = Buffer.from(await upstream.arrayBuffer());
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    if (lastError) return text(res, 502, `Avatar fetch failed: ${lastError.message || String(lastError)}`);
  }

  // embed card JSON into PNG tEXt chunk so SillyTavern can import it directly
  let outBuf;
  try {
    outBuf = injectCardIntoPng(pngBuf, card.parsed);
  } catch {
    outBuf = pngBuf;
  }

  const filename = `${safeFileName(card.record.name, fullPath)}.png`;
  res.writeHead(200, {
    'content-type': 'image/png',
    'content-disposition': `attachment; filename="${filename}"`,
    'content-length': outBuf.length,
  });
  if (method === 'HEAD') return res.end();
  res.end(outBuf);
}

async function handleImg(reqUrl, res, method) {
  // strip leading /img/
  const rel = decodeURIComponent(reqUrl.pathname.slice(5));
  if (!rel || rel.includes('\0') || rel.includes('..')) return text(res, 400, 'Bad path');

  // try local file first
  const localPath = path.join(AVATARS_DIR, rel);
  if (!localPath.startsWith(AVATARS_DIR + path.sep)) return text(res, 400, 'Bad path');

  try {
    const stat = await fsp.stat(localPath);
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': stat.size,
      'cache-control': 'public, max-age=86400',
    });
    if (method === 'HEAD') return res.end();
    fs.createReadStream(localPath).pipe(res);
    return;
  } catch {
    // not downloaded yet — proxy from charhub
  }

  const remoteUrl = `https://avatars.charhub.io/avatars/${encodeURI(rel)}`;
  let upstream;
  try {
    upstream = await fetch(remoteUrl, { redirect: 'follow' });
  } catch (error) {
    return text(res, 502, `Fetch failed: ${error.message}`);
  }
  if (!upstream.ok) return text(res, upstream.status, `Remote ${upstream.status}`);

  res.writeHead(200, {
    'content-type': upstream.headers.get('content-type') || 'image/png',
    'cache-control': 'public, max-age=3600',
  });
  if (method === 'HEAD') return res.end();
  try {
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch (error) {
    res.destroy(error);
  }
}

async function handler(req, res) {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if ((req.method === 'GET' || req.method === 'HEAD') && (reqUrl.pathname === '/' || reqUrl.pathname === '/viewer.html')) {
      const html = await fsp.readFile(HTML_PATH);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (req.method === 'HEAD') return res.end();
      return res.end(html);
    }
    if (req.method === 'GET' && reqUrl.pathname === '/api/status') return json(res, 200, publicStatus());
    if (req.method === 'GET' && reqUrl.pathname === '/api/cards') return json(res, 200, queryCards(reqUrl.searchParams));
    if (req.method === 'GET' && reqUrl.pathname === '/api/card') return await handleCardJson(reqUrl, res);
    if ((req.method === 'GET' || req.method === 'HEAD') && reqUrl.pathname === '/download/json') return await handleJsonDownload(reqUrl, res, req.method);
    if ((req.method === 'GET' || req.method === 'HEAD') && reqUrl.pathname === '/download/png') return await handlePngDownload(reqUrl, res, req.method);
    if ((req.method === 'GET' || req.method === 'HEAD') && reqUrl.pathname.startsWith('/img/')) return await handleImg(reqUrl, res, req.method);
    return text(res, 404, 'Not found');
  } catch (error) {
    status.errors += 1;
    return json(res, 500, { error: error.message || String(error) });
  }
}

async function main() {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  http.createServer(handler).listen(PORT, '127.0.0.1', () => {
    console.log(`Chub viewer: http://127.0.0.1:${PORT}`);
    console.log('Images are fetched on demand; no PNG mirror is created.');
  });

  if (fs.existsSync(INDEX_PATH)) {
    await loadExistingIndex();
  } else {
    buildIndex().catch((error) => {
      status.indexing = false;
      status.mode = 'error';
      status.message = error.message || String(error);
      status.errors += 1;
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
