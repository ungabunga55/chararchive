# Chub Card Viewer

A local gallery viewer for the Chub.ai character card dump. Browse, search, sort, open, and download cards from your machine. The JSON dump stays local.

The viewer can browse card data with only the JSON dump. For gallery images, the current setup is local-first: it uses generated local WebP thumbnails when available, then local full PNGs, then remote CharHub `avatar.webp` as the final fallback. PNG card downloads can also fetch the full PNG from CharHub if the local PNG is missing, while that endpoint remains available.

## Data Sources

JSON dump:

```text
https://gofile.io/d/kohwJu
```

Name index:

```text
https://files.catbox.moe/w401i2.txt
```

`w401i2.txt` is included in this repo. Keep it in the same folder as the scripts.

## Required Folder Layout

Extract the JSON dump so the folder looks like this:

```text
chub/
  00/
  01/
  02/
  ...
  65/
  w401i2.txt
  viewer-server.cjs
  viewer.html
  download-pngs.cjs
  generate-thumbnails.cjs
  fetch-metadata.cjs
  README.md
```

The JSON files should remain in their sharded paths, for example:

```text
00/00/117.json
20/00/028.json
65/19/000.json
```

## Requirements

Node.js 18 or newer:

```bash
node --version
```

Optional PNG compression and thumbnail generation:

```bash
sudo apt install pngquant webp
```

`pngquant` is only needed if you run `download-pngs.cjs` and want compressed local PNGs. `webp` provides `cwebp`, which is needed for `generate-thumbnails.cjs`.

## Storage

Measured on this machine right now:

| Item | Actual size |
|---|---:|
| JSON shard folders `00/`-`65/` | 16 GB |
| Name index `w401i2.txt` | 21 MB |
| Full cache folder `.chub-viewer-cache/` | 541 MB |
| Card index `.chub-viewer-cache/cards.jsonl` | 333 MB |
| Extra API metadata `.chub-viewer-cache/meta.jsonl` | 208 MB |
| Local WebP thumbnails in `thumbs/` | 8.9 GB |
| Local full PNG archive in `avatars/` | 162 GB |

General expectations:

| Item | Typical/expected size |
|---|---:|
| PNGs if not mirrored locally | 0 GB locally; gallery falls back to remote CharHub `avatar.webp` |
| PNGs mirrored locally without compression | around 200 GB |
| PNGs mirrored locally with `pngquant --quality=70-80` | depends heavily on already-existing/uncompressed files; current measured archive is 162 GB |

The JSON dump is large because many cards embed full lorebooks and long definitions inline. The card index stores the card list, local JSON paths, avatar paths, tags, and any metadata that was available when the index was built. If metadata exists, `cards.jsonl` can be much larger than a minimal index.

## Run The Viewer

```bash
cd /path/to/chub
node viewer-server.cjs
```

Open:

```text
http://127.0.0.1:8787
```

Default port is `8787`. Override it with:

```bash
PORT=3000 node viewer-server.cjs
```

## First Run And Cache

On first run, `viewer-server.cjs` scans the JSON folders and builds:

```text
.chub-viewer-cache/cards.jsonl
```

While indexing, it writes:

```text
.chub-viewer-cache/cards.jsonl.tmp
```

If you stop the server mid-index, the `.tmp` file is kept. Starting the server again resumes from that partial `.tmp` file instead of starting over.

When indexing finishes, `.tmp` is renamed to `cards.jsonl`. Future starts load the finished cache quickly.

Delete `.chub-viewer-cache/cards.jsonl` and `.chub-viewer-cache/cards.jsonl.tmp` if you want to force a full rescan.

## Gallery Images

The gallery image pipeline is local-first with CharHub as the final fallback. This means the viewer is fast when local thumbnails exist, still works if only local PNGs exist, and can still show remote thumbnails if nothing has been mirrored yet.

The gallery avatar URL always goes through the local viewer:

```text
/thumb/{creator}/{character}/avatar.webp
```

The `/thumb/` route behaves like this:

| Local file exists? | Gallery behavior |
|---|---|
| `thumbs/.../avatar.webp` exists | Serve local thumbnail |
| Thumbnail missing, `avatars/.../chara_card_v2.png` exists | Serve local full PNG as fallback |
| Both missing | Redirect to remote CharHub `avatar.webp` as last fallback |

This makes phone/remote browsing much faster once thumbnails exist, because gallery cards load small local WebP files instead of full PNGs.

Remote final fallback endpoint:

```text
https://avatars.charhub.io/avatars/{creator}/{character}/avatar.webp
```

The full PNG route still exists for local PNG serving:

```text
/img/{creator}/{character}/chara_card_v2.png
```

`/img/` is kept for local full PNG access and legacy cached cards. It serves local PNGs when present and redirects to CharHub `avatar.webp` if the local PNG is missing.

If your `.chub-viewer-cache/cards.jsonl` was created before the thumbnail route existed, rebuild it so card avatar URLs point to `/thumb/`:

```bash
rm -f .chub-viewer-cache/cards.jsonl .chub-viewer-cache/cards.jsonl.tmp
node viewer-server.cjs
```

## Generate Local Thumbnails

After downloading full PNGs, generate lightweight local thumbnails:

```bash
node generate-thumbnails.cjs
```

Input:

```text
avatars/{creator}/{character}/chara_card_v2.png
```

Output:

```text
thumbs/{creator}/{character}/avatar.webp
```

Defaults:

```text
quality=72
size=240x240 max
concurrency=8
```

Tune if needed:

```bash
QUALITY=70 SIZE=220 CONCURRENCY=12 node generate-thumbnails.cjs
```

Progress is saved to:

```text
.thumb-progress
```

You can stop and resume. Existing thumbnails are skipped. Missing PNGs are counted as `missing`.

100 random CharHub `avatar.webp` samples averaged about `9.8 KB`, projecting roughly `4.7 GB` for ~505k remote-style thumbnails. Locally generated thumbnails from the current PNG archive are larger: the current `thumbs/` folder is `8.9 GB` with the default `QUALITY=72 SIZE=240` settings.

## Search

Search uses AND logic across words.

Example:

```text
milf outdoor
```

This matches cards where both `milf` and `outdoor` appear somewhere in:

```text
name, creator, tags
```

Descriptions and full card text are not searched by the main gallery search, because doing that across 500k large JSON files would be too heavy.

Negative tag exclusions are supported:

```text
milf outdoor -male
```

This means: match `milf` and `outdoor`, but exclude cards with exact tag `male`. Exact tag exclusion avoids accidentally excluding `female`.

Quoted multi-word tag exclusions are also supported:

```text
milf -"public use"
```

Creator exclusions are supported with exact, case-insensitive matching:

```text
milf outdoor -@Anonymous
```

or:

```text
milf outdoor -creator:Anonymous
```

This excludes cards whose creator is exactly `Anonymous`.

Positive multi-word searches still work as normal AND word search:

```text
milf outdoor public use
```

This matches cards where all four words appear across name, creator, or tags.

## Creator Pages

Creator usernames in the gallery and card dialog are clickable.

Clicking a creator opens:

```text
/?creator=CreatorName
```

That page shows only cards by that exact creator. Search, sorting, and public/unlisted filters still work inside the creator page.

## Opening A Card

Click a card image or the `Open` button.

The card dialog shows available fields as tabs:

```text
Overview
Description
First Message
Personality
Scenario
Creator Notes
System Prompt
Post History
Alternate Greetings
Raw JSON
```

`Overview` uses the extra Chub metadata description/tagline when available. The normal `Description` tab is still the JSON card description. Only fields with content are shown.

## Downloading Cards

Each gallery card has:

```text
PNG
JSON
Open
```

`JSON` downloads the local `.json` file from the dump.

`PNG` downloads a PNG character card that can be imported into SillyTavern. The server embeds the full JSON into the PNG as a `tEXt` chunk with key `chara` at download time.

PNG download behavior:

| Local PNG exists? | Download behavior |
|---|---|
| Yes | Read local PNG, inject JSON, send download |
| No | Fetch full PNG from charhub endpoint, inject JSON, send download |

Compressed local PNGs still work. The JSON is injected when you click download, not when the image is stored.

So PNG card downloads still work without a local PNG archive as long as Chub/CharHub's full PNG endpoint remains available:

```text
https://avatars.charhub.io/avatars/{creator}/{character}/chara_card_v2.png
```

## Download All PNGs Locally

This step is optional for card data browsing, because gallery thumbnails and PNG downloads can still fall back to CharHub while its endpoints are available. It is needed if you want full local image preservation and local thumbnail generation. Once PNGs and thumbnails are local, normal gallery browsing no longer depends on Chub/CharHub's image endpoints.

To mirror every PNG into `./avatars/`:

```bash
node download-pngs.cjs
```

Folder structure is preserved:

```text
avatars/{creator}/{character}/chara_card_v2.png
```

Example:

```text
avatars/Anonymous/cardname-asadasdad44sdad/chara_card_v2.png
```

Progress is saved to:

```text
.png-download-progress
```

You can stop with `Ctrl-C` and run it again later. Already downloaded files are skipped.

After this has downloaded some or all PNGs, run `generate-thumbnails.cjs` so the gallery uses small local WebP thumbnails instead of full PNGs.

### Downloader Output

The downloader shows one dynamic progress line:

```text
1,900/503,200 ok:1,720 skip:20 fail:160 disk:680MB compSaved:1.05GB 4.2/s ETA:1d
```

Meaning:

| Field | Meaning |
|---|---|
| `ok` | downloaded successfully this run |
| `skip` | file already existed |
| `fail` | missing or failed image |
| `disk` | actual PNG bytes processed/written this run after compression |
| `compSaved` | disk space saved by compression |
| `4.2/s` | processed files per second |
| `ETA` | estimated time remaining |

For very verbose per-file logs:

```bash
VERBOSE=1 node download-pngs.cjs
```

For more frequent progress updates:

```bash
BATCH_LOG=10 node download-pngs.cjs
```

### Download Failures

Permanent missing images like `404` and `410` are expected. Some indexed cards no longer have images upstream.

Retryable failures are written to:

```text
.png-download-failures.jsonl
```

Retry only those later:

```bash
RETRY_FAILURES=1 node download-pngs.cjs
```

The final summary includes a failure breakdown such as:

```text
failure breakdown:
  404: 1234
  TimeoutError: 12
  500: 3
```

## PNG Compression

If `pngquant` is installed, `download-pngs.cjs` compresses each PNG immediately after it downloads.

Current setting:

```bash
pngquant --quality=70-80 --ext .png --force --strip
```

This overwrites the original file in place. The compressed PNG becomes the only stored image.

If compression fails or cannot meet the quality range, the original PNG is kept untouched.

The script does not download all PNGs first and compress later. It runs:

```text
download one PNG -> write file -> compress same file -> continue
```

So you do not need temporary storage for both the full uncompressed archive and the compressed archive.

Small 100-card tests showed aggressive potential savings, but they were not representative of the full local archive. The current measured `avatars/` folder is `162 GB`.

Sample-test projections were:

| pngquant setting | Projected size from 200 GB |
|---|---:|
| `80-80` | around 76 GB |
| `70-70` | around 64 GB |
| `70-80` | around 71 GB |

The actual full archive depends on what was already downloaded before compression was enabled, what files `pngquant` refused to compress within the quality range, and how representative the sample was. `70-80` is still the current quality setting.

## Extra Chub Metadata

The JSON card files do not include all server-side Chub metadata. Chub also exposes fields such as:

```text
tagline
description
starCount
n_favorites
nChats
nMessages
rating
ratingCount
forksCount
lastActivityAt
createdAt
is_unlisted
is_public
primaryFormat
nTokens
```

Fetch and cache that metadata with:

```bash
node fetch-metadata.cjs
```

It writes:

```text
.chub-viewer-cache/meta.jsonl
```

Restart `viewer-server.cjs` after fetching metadata so the viewer loads it.

The script tries:

```text
https://gateway.chub.ai/api/characters/{creator}/{character}?full=true
```

If needed, it falls back to:

```text
https://ro.chub.ai/api/characters/{creator}/{character}?full=true
```

It retries transient failures and applies global backoff on rate limits.

### Account Headers For Metadata

`fetch-metadata.cjs` includes placeholder headers:

```js
'ch-api-key': 'your account key - get it via network api (open your chub profile, f12, network, refresh, inspect for this parameter',
'samwise':    'your account key - get it via network api (open your chub profile, f12, network, inspect for this parameter',
```

To get your account key:

1. Open `https://chub.ai` while logged in.
2. Press `F12`.
3. Open the Network tab.
4. Refresh the page or open your profile.
5. Inspect API requests for `ch-api-key` or `samwise` headers.
6. Put that value in both fields in `fetch-metadata.cjs`.

Without account headers, public metadata may still work, but private/unlisted/account-visible data may fail or return less data.

## Sorting And Filtering

Without `fetch-metadata.cjs`, only default sorting and basic search are meaningful.

After metadata is fetched, the viewer can sort by:

| Sort | Field |
|---|---|
| Most starred | `starCount` |
| Most favorited | `n_favorites` |
| Most chats | `nChats` |
| Most messages | `nMessages` |
| Best rated | weighted rating score |
| Most forked | `forksCount` |
| Latest activity | `lastActivityAt` |
| Newest | `createdAt` |
| Oldest | `createdAt` |

Best rated uses:

```js
ratingScore = rating * Math.log1p(ratingCount)
```

This prevents a `5.0` rating with one vote from beating a slightly lower rating with hundreds of votes.

Metadata filtering currently supports:

```text
All cards
Public only
Unlisted only
```

Cards without fetched metadata default to public/listed for filtering purposes.

## Card Layout And Mobile UI

The gallery uses a compact Chub-like card layout:

```text
title bar: card name + token count + stars
image area: full image visible, not cropped
info area: tagline/overview, creator, tags, actions
```

On phones, the grid stays dense with two columns and a compact header so multiple cards are visible at once. Images use `object-fit: contain`, so they are scaled down but still shown in full.
