# Χριστιανισμός - Επιστήμη

A fast, installable, offline-capable web player for a personal archive of the
Greek podcast **Χριστιανισμός - Επιστήμη** (Christianity - Science) — 20 seasons,
353 episodes, each split into sequential mp3 parts.

[![Docker Hub](https://img.shields.io/docker/v/giorgospap777/christianity-science-pwa?label=docker%20hub&sort=semver)](https://hub.docker.com/r/giorgospap777/christianity-science-pwa)
[![Image size](https://img.shields.io/docker/image-size/giorgospap777/christianity-science-pwa/latest)](https://hub.docker.com/r/giorgospap777/christianity-science-pwa)

> **This repository contains no audio.** It is the player only. Your archive
> stays where it is and is read in place, never copied, moved, or renamed.

## What it does

- **Continuous playback** — parts play back-to-back (`1.mp3 → 2.mp3 → …`). At
  the end of an episode playback stops there, and Play hears it again from
  the start; turn on **autoplay** in the player to have the next episode
  start by itself, across season boundaries too. Autoplay skips episodes you
  have already heard, unless the one that just ended was itself a replay:
  then you are going back through old episodes, and it carries on in order.
- **Series** — multi-part runs ("Εσχατολογικά - Μέρος 1ο … 7ο") are found from
  the titles and shown in their season as a single row. Its play button plays
  the series through in order, whether autoplay is on or not, and stops at
  its end; tap the row to open it and see the parts, Μέρος 1ο first.
- **New episodes** — episodes added since your last visit get a badge, a count
  on their season and a short list at the top until you play or dismiss them.
  An app left open for days offers to refresh once the archive has changed.
- **Keeps itself up to date** (optional) — a second container downloads new
  broadcasts from the official site into the archive as they appear; see
  [Downloading new episodes automatically](#downloading-new-episodes-automatically).
- **Share a moment** — the share button gives a link such as
  `…/_site/#e=2025-10-30&t=754` that opens that episode at that point, paused.
- **Resume anywhere** — playback position, "continue listening", and recently
  played are remembered per browser. The last episode comes back paused, and
  none of it is downloaded until you press play.
- **Listened tracking** — auto-marked when the last part finishes, manually
  togglable, with an "unheard only" filter.
- **Search** — accent-insensitive Greek matching, so `εξελιξη` finds `Εξέλιξη`,
  and Greeklish works too: `exelixi`, `ekseliksi`, `8eos`. Several words match
  in any order, and dates count too: `εξελιξη 2009`, `martiou 2022` or
  `march 2022`.
- **Sleep timer** — stop after 15–60 minutes (with a short fade-out), or at the
  end of the current part or episode.
- **Lock screen** — artwork, a scrubber, and play/pause/skip from the OS media
  controls.
- **Now playing** — on phones and tablets, tap the player's title (or swipe it
  up) for a full-screen view: large artwork, bigger controls, and the episode's
  parts as a bar you can tap to jump between. Swipe down, press back or Escape
  to return to the list.
- **Greek / English interface** with an ΕΛ⁠/⁠EN toggle. Episode titles come from
  the folder names and are never translated.
- **Light / dark theme** — follows the device, or set it with the button in
  the header.
- **Installable (PWA)** — full screen, its own home-screen icon, works offline.
- **Save for offline** — the cloud chip in the player saves the episode to the
  device, to play on a plane or in a dead spot. Nothing is downloaded unless
  you ask. Saved episodes carry a cloud mark in the list.
- **Smaller copies** (optional) — 64 kbps copies of the high-bitrate parts, for streaming over a home uplink; see
  [Smaller copies](#smaller-copies).
- **Quick seeking on a small uplink** — the server paces listening, so a seek
  does not wait behind the rest of a part already on its way; see
  [Why listening is paced too](#why-listening-is-paced-too).
- Scrubbing, ±15 s, part/episode skip, playback speed, OS media keys, and a
  mobile-friendly layout.
- **Keyboard** — Space or K play/pause, ←/→ ±15 s, Shift+←/→ part,
  Shift+P/N episode, `/` search; press `?` for the list.

## Run it

### Docker (recommended)

```bash
docker run -d --name christianity-science -p 8080:8080 \
  -v /path/to/archive:/archive:ro \
  giorgospap777/christianity-science-pwa:latest
```

Or with Compose:

```bash
# set the archive path in compose.yaml, then:
docker compose up -d
```

### Without Docker

Needs Python 3.8+ and, optionally, `ffprobe` (from ffmpeg) for episode durations.

```bash
python3 build_index.py --root /path/to/archive
python3 serve.py       --root /path/to/archive
```

If you drop this repo *inside* the archive folder, both commands work with no
arguments.

## Downloading new episodes automatically

The same image can also keep the archive up to date. Run as `fetch`, it reads
the official radio page (https://christianity-science.gr/radio.htm), downloads
any broadcast newer than the newest one in the archive into the right season
folder, named the way the existing folders are, and rebuilds the index. The
player picks up the new index without a restart, and the new episode shows up
as new for everyone.

It needs the archive **read-write**, so it runs as its own container and the
player keeps its read-only mount. With Compose, beside the player:

```yaml
  fetcher:
    image: giorgospap777/christianity-science-pwa:latest
    container_name: christianity-science-fetcher
    restart: unless-stopped
    command: ["fetch", "--every", "6h"]
    volumes:
      - /path/to/archive:/archive        # read-write: new episodes go here
      - index-data:/data                 # the same volume as the player's
    user: "1000:1000"                    # a user who owns the archive
    healthcheck:
      disable: true                      # the image's check is the player's
```

The player needs `index-data:/data` too, so both use one index. Each episode
is downloaded into `.incoming/` inside the archive and moved into its season
folder only when every part is complete; an interrupted download carries on
from the last complete part. Older broadcasts that are missing from the
archive are listed in the log but not downloaded, since they may be missing on
purpose; `--include-older` fetches them as well. An episode whose download
failed is tried again on the next run, even if a newer one was saved
meanwhile. `--dry-run` shows what would be downloaded, `--max` (default 10)
caps the episodes per run, and `--out` says where the rebuilt index goes
(default `INDEX_OUT`; set it when trying the fetcher on a test archive).

The site sometimes lists a broadcast before all of its parts are up. A new
episode with fewer than the usual 4 parts waits in `.incoming/` and is
completed on a later run, or saved as it is once it has looked the same for 3
days. An episode from the last 60 days that the site now lists with more parts
than the archive has gets the missing ones.

When `LITE_ROOT` points at a folder (the image sets `/data/lite`), each run
also makes [smaller copies](#smaller-copies) of new high-bitrate parts.

Once, by hand: `docker compose run --rm fetcher fetch --dry-run`.

## Smaller copies

Most of the archive is 64 kbps mono, but about a quarter of the parts, most of
seasons 16–19 and some older ones, are 112–192 kbps: two to three times the
size for the same speech. On a home uplink shared by every listener, that size
decides how many can listen at once. `make_lite.py`
writes a 64 kbps mono copy of every part above 80 kbps into a separate folder
that mirrors the archive's layout. The archive itself is only read.

`build_index.py` points the index at a copy when it exists and is at least as
new as its original, and `serve.py` serves the copies under `/_lite/`. Parts
without a copy, and copies older than their original, use the original.

The image keeps the copies in `/data/lite`, so the player and the fetcher need
the same `/data` volume. Make the copies for the whole archive once (the first
run encodes every high-bitrate part, about 3.8 GB, and takes a while; it runs
at low priority):

```bash
docker compose run --rm fetcher lite
```

After that the fetcher makes copies of new episodes as they arrive. Run `lite`
as the same user as the fetcher, as the command above does, since each needs
to write where the other has. Without the fetcher, run `lite` from the
player's service instead. `lite --dry-run` lists what would be encoded, and `--limit N` stops
after N parts. Without Docker:

```bash
python3 make_lite.py  --root /path/to/archive --lite /path/to/copies
python3 build_index.py --root /path/to/archive --lite /path/to/copies
python3 serve.py       --root /path/to/archive --lite /path/to/copies
```

## Expected archive layout

```
archive/
├── 1ος Κύκλος Εκπομπών/
│   ├── Εισαγωγική Εκπομπή - 31 Ιανουαρίου 2008/
│   │   ├── 1.mp3   ├── 2.mp3   ├── 3.mp3   └── 4.mp3
│   └── ...
└── 19ος Κύκλος Εκπομπών/
```

Episode folders are named `<title> - <day> <Greek month> <year>`. The date is
matched at the **end** of the name, because titles frequently contain " - "
themselves. Episodes with a different number of parts work fine. Anything that
cannot be parsed — a missing part, non-contiguous numbering, an unreadable name
— is reported as a warning rather than silently skipped.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARCHIVE_ROOT` | `/archive` (container) | where the season folders live |
| `HOST` / `PORT` | `0.0.0.0` / `8080` | listen address |
| `REBUILD_INDEX` | `1` | set `0` to skip the startup scan |
| `INDEX_OUT` | `/data/index.json` (container) | generated index location |
| `TLS_CERT` / `TLS_KEY` | unset | serve HTTPS directly |
| `FETCH_URL` | the official radio page | where `fetch` looks for new episodes |
| `LITE_ROOT` | `/data/lite` (container) | the [smaller copies](#smaller-copies); unset, none are used |
| `PLAY_KBPS` | `512` | listening speed after the first `PLAY_BURST` bytes of each request, in kbit/s; `0` is full speed |
| `PLAY_BURST` | `131072` | bytes sent at full speed first, so playback starts at once |
| `SAVE_KBPS` | `256` | speed of each offline save, in kbit/s; `0` is full speed |
| `SAVE_SLOTS` | `2` | offline saves running at once, across all listeners; `0` is no limit |

`serve.py` also takes `--root`, `--lite`, `--host`, `--port`, `--cert`,
`--key`. `build_index.py` takes `--root`, `--lite`, `--out`, `--no-durations`,
`--jobs`, and `--allow-empty`. The index is replaced in one step, so a rebuild on a running
server is safe, and a scan that finds no episodes (an archive mount that is
briefly missing) keeps the previous index unless `--allow-empty` is given.

## Three things that will bite you

1. **Behind a reverse proxy, `Range` headers must be forwarded and responses
   must not be buffered**, or seeking inside an episode breaks. In nginx that
   means `proxy_buffering off;`.
2. **Installing the app and saving for offline require a secure origin** —
   HTTPS, or `localhost`. On a plain `http://192.168.x.x` the site works
   normally, but neither the install prompt nor the Save button will appear.
3. **Behind Cloudflare or another CDN, bypass its cache for `.mp3`.**
   Cloudflare caches mp3 files by their extension. On a miss it drops the
   `Range` header and fetches the whole part from your server first, so a seek
   into a part nobody has played lately waits until most of the part has
   crossed your uplink, at the paced rate. A Cache Rule for the player's
   hostname, *URI path ends with `.mp3`* → *Bypass cache*, fixes it. Its
   *Browser Cache TTL* also turns the server's `no-cache` on the app's scripts
   into four hours; *Respect existing headers* keeps updates prompt.

## Why a custom server

`python3 -m http.server` does not implement HTTP `Range` requests, so a browser
cannot seek inside an mp3 without downloading the whole file first. `serve.py`
adds `206 Partial Content`, which is what makes scrubbing work. The service
worker does the same for cached audio, slicing byte ranges out of stored
responses.

## Saving for offline, specifically

Nothing is saved unless the listener asks: the cloud chip in the player shows
the episode's size, and tapping it saves every part to the device. While it
saves, the chip shows progress, and tapping it again stops. Once saved, the
episode plays with no network, seeking included, and tapping the chip offers
to delete it. Saving more episodes queues them; there is no cap beyond the
device's storage, which is checked first.

At the paced rate below, a 40 MB episode takes about 20 minutes. The chip
says roughly how long before it starts and how long is left while it runs.
The download runs in the page, and a phone freezes a page left in the
background unless it is playing, so the app asks to be kept open until the
save finishes.

A browser downloads as fast as the link allows, whatever the page asks, so
the pacing happens on the server. A save asks for each part with `?save=1`,
and `serve.py` sends those at `SAVE_KBPS` (256 kbit/s, four times the 64 kbps
listening rate) and runs at most `SAVE_SLOTS` (2) at once, across everyone.
Further saves get `503` with `Retry-After` and the app tries again shortly,
so offline saves never take more than about 0.5 Mbit/s of the uplink.

## Why listening is paced too

After every start and every seek, the browser asks for the rest of the part
and reads it as fast as the line allows. On a small home uplink that fills
the router's queue (and a reverse proxy's socket buffer), and the next seek,
by this listener or any other, waits behind it: on a simulated 5 Mbit/s
uplink with a 1 MB router queue, 2 to 4 seconds before the sound came back.

So `serve.py` sends the first `PLAY_BURST` bytes (128 KB, about 16 seconds of
a 64 kbps part) at once, and the rest at `PLAY_KBPS` (512 kbit/s, eight times
the listening rate, four times at 2× speed). The queue stays short, and the
same seek took 0.12 seconds. A part above 128 kbps, one with no smaller copy,
gets four times its own bitrate instead. `PLAY_KBPS=0` turns this off.
Saved episodes play from the device and are not affected.

## Stored state

Everything is per-browser `localStorage` under the `cs:v1:` prefix, and saved
audio is in the browser's Cache Storage (`cs-audio-v1`). There is no
server-side state, no account, and no network calls beyond your own server.

| Key | Contents |
| --- | --- |
| `cs:v1:lang` | `el` or `en` |
| `cs:v1:progress` | resume point per episode |
| `cs:v1:listened` | listened episodes |
| `cs:v1:last` | the "continue listening" target |
| `cs:v1:recent` | recently played |
| `cs:v1:seen` | episodes no longer shown as new |
| `cs:v1:ui` | sort order, filter, open seasons and series, volume, speed, autoplay |
| `cs:v1:cachedEps` | episodes saved for offline, newest first |
| `cs:v1:theme` | `light` or `dark`, when set by hand instead of following the device |
| `cs:v1:installDismissed` | the install card was dismissed |

## Files

| File | Purpose |
| --- | --- |
| `build_index.py` | scans the archive, probes durations, writes `index.json` |
| `fetch_new.py` | downloads new episodes from the official site into the archive, then rebuilds the index |
| `make_lite.py` | makes 64 kbps copies of the high-bitrate parts in a separate folder |
| `serve.py` | Range-capable static server; serves only the app's own files and the mp3s, no directory listings |
| `index.html` `styles.css` `app.js` `i18n.js` | the site |
| `sw.js` | service worker: offline shell + range-aware audio cache |
| `manifest.webmanifest` | PWA metadata |
| `make_icons.py` | draws `icons/` (a cross with an orbit) from geometry, in plain Python; edit the numbers at the top to change it |
| `Dockerfile` `entrypoint.sh` `compose.yaml` | container build and deployment |

## Publishing

Pushing to `main` rebuilds and publishes the image via GitHub Actions, and syncs
the Docker Hub overview from `DOCKERHUB.md`. It needs two repository secrets:
`DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` (a Docker Hub personal access token
with Read & Write scope).

## License

The code in this repository is MIT licensed. The podcast recordings are **not**
covered by it and are not distributed here — they remain the property of their
original creators.
