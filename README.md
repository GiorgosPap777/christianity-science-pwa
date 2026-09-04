# Χριστιανισμός - Επιστήμη

A fast, installable, offline-capable web player for a personal archive of the
Greek podcast **Χριστιανισμός - Επιστήμη** (Christianity - Science) — 19 seasons,
351 episodes, each split into sequential mp3 parts.

[![Docker Hub](https://img.shields.io/docker/v/giorgospap777/christianity-science-pwa?label=docker%20hub&sort=semver)](https://hub.docker.com/r/giorgospap777/christianity-science-pwa)
[![Image size](https://img.shields.io/docker/image-size/giorgospap777/christianity-science-pwa/latest)](https://hub.docker.com/r/giorgospap777/christianity-science-pwa)

> **This repository contains no audio.** It is the player only. Your archive
> stays where it is and is read in place, never copied, moved, or renamed.

## What it does

- **Continuous playback** — parts play back-to-back (`1.mp3 → 2.mp3 → …`), then
  the next episode starts automatically, continuing across season boundaries so
  multi-part series play in order.
- **Resume anywhere** — playback position, "continue listening", and recently
  played are remembered per browser.
- **Listened tracking** — auto-marked when the last part finishes, manually
  togglable, with an "unheard only" filter.
- **Search** — accent-insensitive Greek matching, so `εξελιξη` finds `Εξέλιξη`.
- **Greek / English interface** with an ΕΛ⁠/⁠EN toggle. Episode titles come from
  the folder names and are never translated.
- **Installable (PWA)** — full screen, its own home-screen icon, works offline.
- **Offline caching** — the episode you are listening to is stored on the
  device, so playback survives a tunnel or a dead spot.
- Scrubbing, ±15 s, part/episode skip, playback speed, OS media keys, and a
  mobile-friendly layout.

## Run it

### Docker (recommended)

```bash
docker run -d --name christianity-science -p 8080:8080 \
  -v /path/to/archive:/archive:ro \
  giorgospap777/christianity-science-pwa:latest
```

Or with Compose:

```bash
cp .env.example .env      # set ARCHIVE_PATH
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
| `INDEX_OUT` | `index.json` beside the site | generated index location |
| `TLS_CERT` / `TLS_KEY` | unset | serve HTTPS directly |

`serve.py` also takes `--root`, `--host`, `--port`, `--cert`, `--key`.
`build_index.py` takes `--root`, `--out`, `--no-durations`, `--jobs`.

## Two things that will bite you

1. **Behind a reverse proxy, `Range` headers must be forwarded and responses
   must not be buffered**, or seeking inside an episode breaks. In nginx that
   means `proxy_buffering off;`.
2. **Installing the app and offline caching require a secure origin** — HTTPS,
   or `localhost`. On a plain `http://192.168.x.x` the site works normally, but
   neither the install prompt nor offline caching will turn on.

## Why a custom server

`python3 -m http.server` does not implement HTTP `Range` requests, so a browser
cannot seek inside an mp3 without downloading the whole file first. `serve.py`
adds `206 Partial Content`, which is what makes scrubbing work. The service
worker does the same for cached audio, slicing byte ranges out of stored
responses.

## Offline caching, specifically

When an episode starts, the parts *ahead* of the current one download first —
the part you are on is already being buffered by the audio element, so it is
fetched last and nothing is downloaded twice. Once the episode is complete,
part 1 of the next episode is fetched so autoplay does not stall either.

Only the **3 most recent episodes** are kept (~150 MB); older ones are evicted
automatically. The cloud chip in the player shows progress — tap it to turn
caching off and clear what is stored.

## Stored state

Everything is per-browser `localStorage` under the `cs:v1:` prefix. There is no
server-side state, no account, and no network calls beyond your own server.

| Key | Contents |
| --- | --- |
| `cs:v1:lang` | `el` or `en` |
| `cs:v1:progress` | resume point per episode |
| `cs:v1:listened` | listened episodes |
| `cs:v1:last` | the "continue listening" target |
| `cs:v1:recent` | recently played |
| `cs:v1:ui` | sort order, filters, open seasons, volume, speed, offline caching |
| `cs:v1:cachedEps` | episodes held in the offline audio cache |

## Files

| File | Purpose |
| --- | --- |
| `build_index.py` | scans the archive, probes durations, writes `index.json` |
| `serve.py` | Range-capable static server |
| `index.html` `styles.css` `app.js` `i18n.js` | the site |
| `sw.js` | service worker: offline shell + range-aware audio cache |
| `manifest.webmanifest` | PWA metadata |
| `make_icons.py` | regenerates `icons/` (pure Python, no image libraries) |
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
