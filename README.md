# Chub Card Viewer

A local gallery viewer for the Chub.ai character card dump. Browse, search, sort, open, and download cards from your machine. The JSON dump stays local. Thumbnails lazy-load from `avatars.charhub.io` unless you mirror PNGs locally.

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

Optional PNG compression:

```bash
sudo apt install pngquant
```

`pngquant` is only needed if you run `download-pngs.cjs` and want compressed local PNGs.

## Storage

| Item | Approx size |
|---|---:|
| JSON dump only | 15-20 GB |
| Viewer card index `.chub-viewer-cache/cards.jsonl` | 100-150 MB |
| Extra API metadata `.chub-viewer-cache/meta.jsonl` | varies, potentially 100+ MB |
| PNGs without compression | around 300 GB |
| PNGs with `pngquant --quality=70-80` | roughly 65-100 GB projected from sample testing |

The JSON dump is large because many cards embed full lorebooks and long definitions inline. The viewer index is small because it stores only minimal searchable metadata like path, name, creator, full path, avatar path, and tags.

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

The gallery avatar URL always goes through the local viewer:

```text
/img/{creator}/{character}/chara_card_v2.png
```

The `/img/` route behaves like this:

| Local PNG exists? | Gallery behavior |
|---|---|
| Yes | Serve local `avatars/.../chara_card_v2.png` |
| No | Redirect to lightweight charhub `avatar.webp` |

This means the viewer works immediately without downloading the 200 GB archive. If you later run the PNG downloader, cards automatically start using local PNGs where available.

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

## Opening A Card

Click a card image or the `Open` button.

The card dialog shows available fields as tabs:

```text
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

Only fields with content are shown.

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
| No | Fetch full PNG from charhub, inject JSON, send download |

Compressed local PNGs still work. The JSON is injected when you click download, not when the image is stored.

## Download All PNGs Locally

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
avatars/Anonymous/sarah-your-oblivious-free-use-mom-fc88d458a7fa/chara_card_v2.png
```

Progress is saved to:

```text
.png-download-progress
```

You can stop with `Ctrl-C` and run it again later. Already downloaded files are skipped.

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

Small 100-card tests showed:

| pngquant setting | Projected size from 200 GB |
|---|---:|
| `80-80` | around 76 GB |
| `70-70` | around 64 GB |
| `70-80` | around 71 GB |

`70-80` is the current sweet spot.

## Extra Chub Metadata

The JSON card files do not include all server-side Chub metadata. Chub also exposes fields such as:

```text
tagline
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
