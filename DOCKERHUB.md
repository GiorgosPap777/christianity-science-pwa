# Χριστιανισμός - Επιστήμη

An installable, offline-capable web player for a personal archive of the Greek
podcast **Χριστιανισμός - Επιστήμη** (Christianity - Science).

**Source:** https://github.com/GiorgosPap777/christianity-science-pwa

The image ships **only the site and server — no audio**. Your archive stays on
the host and is bind-mounted read-only, so a 20 GB collection never touches the
image. The episode index is rebuilt from that mount every time the container
starts, so adding episodes only needs a restart, or none at all with the
downloader below.

## Quick start

```bash
docker run -d --name christianity-science -p 8080:8080 \
  -v /path/to/archive:/archive:ro \
  giorgospap777/christianity-science-pwa:latest
```

Then open http://localhost:8080/

## Expected archive layout

The mounted folder must contain one directory per season, each holding one
directory per episode, each holding the numbered parts:

```
/archive/
├── 1ος Κύκλος Εκπομπών/
│   └── Εισαγωγική Εκπομπή - 31 Ιανουαρίου 2008/
│       ├── 1.mp3
│       ├── 2.mp3
│       ├── 3.mp3
│       └── 4.mp3
└── 2ος Κύκλος Εκπομπών/
    └── ...
```

Episode folders are named `<title> - <day> <Greek month> <year>`. The date is
parsed from the **end** of the name, so titles may contain " - " themselves.
Episodes with a different number of parts still work; anything unparseable is
reported in the container log rather than silently skipped.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARCHIVE_ROOT` | `/archive` | where the season folders are mounted |
| `HOST` / `PORT` | `0.0.0.0` / `8080` | listen address inside the container |
| `REBUILD_INDEX` | `1` | set `0` to skip the startup scan |
| `INDEX_OUT` | `/data/index.json` | where the generated index is written |
| `TLS_CERT` / `TLS_KEY` | unset | serve HTTPS directly instead of behind a proxy |
| `FETCH_URL` | the official radio page | where `fetch` looks for new episodes |

Runs as **uid 10001**. If your archive is not readable by that user, add
`--user "$(id -u):$(id -g)"` — the index is written to `/data`, which any uid
can write, so overriding the user is safe. Mount a volume at `/data` if you
want the index to survive restarts (then `REBUILD_INDEX=0` becomes useful).

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
purpose; `--include-older` fetches them as well. `--dry-run` shows what would
be downloaded, and `--max` (default 10) caps the episodes per run.

Once, by hand: `docker compose run --rm fetcher fetch --dry-run`.

## What it does

- Continuous playback across an episode's parts; optional autoplay into the
  next episode, across season boundaries.
- A **Series** view of multi-part runs, each playable start to finish.
- "New" badges on episodes added since your last visit.
- Share links that open an episode at a given moment.
- Resume where you left off, per-episode listened tracking, "unheard only"
  filter, accent-insensitive Greek search (Greeklish too) by title words and
  dates.
- Sleep timer, lock-screen controls with artwork, and a full-screen "now
  playing" view on phones.
- Greek/English interface toggle and a light/dark theme. Episode titles are
  never translated.
- **Installable (PWA)** — full screen, own home-screen icon, works offline.
- **Offline caching** — the episode you are listening to is kept on the device
  so playback survives a tunnel. Bounded to the 3 most recent episodes, and
  paced so a few listeners cannot saturate a home uplink.

## Two things that will bite you

1. **Behind a reverse proxy, `Range` headers must be forwarded and responses
   must not be buffered**, or seeking inside an episode breaks. (nginx:
   `proxy_buffering off;`)
2. **Installing the app and offline caching require HTTPS** (or `localhost`).
   On a plain `http://192.168.x.x` the site works, but neither feature turns on.

## Tags

`latest` follows `main`; versioned tags (`1.0.4`, …) are published for
releases. `linux/amd64`.
