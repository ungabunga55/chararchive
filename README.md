# Chub Card Viewer

A local gallery viewer for the Chub.ai character card dump. Browse, search, and download cards directly from your machine. No account, no internet required for the data — images lazy-load from charhub.io unless you run the downloader.

---

## What you need before starting

### 1. The JSON dump
~500k character card JSON files, already in the sharded folder structure (`00/00/117.json`, etc.).

Download here: **https://gofile.io/d/kohwJu**

Extract so your folder looks like this:
```
chub/
  00/
  01/
  02/
  ...
  65/
  w401i2.txt
  viewer-server.cjs
  viewer.html
  ...
```

### 2. The name index
`w401i2.txt` is included in this repo — no separate download needed.

### 3. Node.js 18 or newer
Check with `node --version`. Download from https://nodejs.org if needed.

---

## Storage breakdown

| What | Size |
|---|---|
| JSON files (the dump) | ~15–20 GB |
| Metadata cache (auto-built on first run) | ~100–150 MB |
| PNGs — lazy-loaded from charhub, not stored | 0 |
| PNGs — if you run the downloader | ~200 GB |

The JSON files are large because ~300k of the cards embed full lorebooks with hundreds of entries inline — some individual files are 30–100 KB. Plain character cards are 2–5 KB each. Filesystem block overhead across 500k files adds up too.

The metadata cache only stores name, creator, tags, and file path per card — no descriptions or lorebook content. It's what the viewer actually searches and paginates against.

---

## Running the viewer

```bash
cd /path/to/chub
node viewer-server.cjs
```

Then open **http://127.0.0.1:8787** in your browser.

**First run:** the server scans all JSON files and builds a metadata cache at `.chub-viewer-cache/cards.jsonl` (~100–150 MB). This takes a few minutes and happens in the background — you can already browse while it runs. Subsequent starts load the cache instantly.

**Images:** card thumbnails are lazy-loaded on demand from `avatars.charhub.io`. Nothing is downloaded or stored locally unless you run the downloader script below.

---

## Searching

The search bar filters by **card name**, **creator name**, and **tags** only (not full description text — that would require loading all JSONs into memory).

---

## Opening a card

Click the card image or the **Open** button. A dialog shows all available fields as tabs:
- Description, First Message, Personality, Scenario, Creator Notes, System Prompt, Post History, Alternate Greetings, Raw JSON

Only tabs with actual content are shown.

---

## Downloading cards

Each card has two download buttons:
- **JSON** — downloads the `.json` file directly from your local dump
- **PNG** — proxies the image from `avatars.charhub.io` (or serves from local disk if you ran the downloader)

---

## Downloading all PNGs locally (VPS or high-storage machine)

If you want a fully offline copy — or want to preserve the images before charhub goes away — run:

```bash
node download-pngs.cjs
```

This reads `w401i2.txt` and downloads every PNG into `./avatars/` using 20 parallel connections. Progress is saved to `.png-download-progress` so you can stop and resume any time. Already-downloaded files are skipped.

**Expected size: ~200 GB** (~400 KB average per card × 500k cards).

Once a PNG is downloaded, the viewer serves it from disk automatically — no restart, no config change needed. Cards not yet downloaded continue to load from charhub as a fallback.

Recommended to run this on a VPS with fast bandwidth. On a 1 Gbps connection the full download takes a few hours.

---

## Cache

The metadata cache lives at `.chub-viewer-cache/cards.jsonl`. It contains one line per card with: local file path, id, name, creator, full path, tags. No image data, no descriptions.

Delete it to force a full rescan (e.g. if you add new JSON files to the dump).

---

## Port

Default port is **8787**. Change it with:

```bash
PORT=3000 node viewer-server.cjs
```
