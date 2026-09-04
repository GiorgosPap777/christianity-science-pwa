# Χριστιανισμός - Επιστήμη

An installable, offline-capable web player for a personal archive of the Greek
podcast **Χριστιανισμός - Επιστήμη** (Christianity - Science).

**Source:** https://github.com/GiorgosPap777/christianity-science-pwa

The image ships **only the site and server — no audio**. Your archive stays on
the host and is bind-mounted read-only, so a 20 GB collection never touches the
image. The episode index is rebuilt from that mount every time the container
starts, so adding episodes only needs a restart.

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

Runs as **uid 10001**. If your archive is not readable by that user, add
`--user "$(id -u):$(id -g)"` — the index is written to `/data`, which any uid
can write, so overriding the user is safe. Mount a volume at `/data` if you
want the index to survive restarts (then `REBUILD_INDEX=0` becomes useful).

## What it does

- Continuous playback across an episode's parts, then straight into the next
  episode — across season boundaries.
- Resume where you left off, per-episode listened tracking, "unheard only"
  filter, accent-insensitive Greek search.
- Greek/English interface toggle. Episode titles are never translated.
- **Installable (PWA)** — full screen, own home-screen icon, works offline.
- **Offline caching** — the episode you are listening to is kept on the device
  so playback survives a tunnel. Bounded to the 3 most recent episodes.

## Two things that will bite you

1. **Behind a reverse proxy, `Range` headers must be forwarded and responses
   must not be buffered**, or seeking inside an episode breaks. (nginx:
   `proxy_buffering off;`)
2. **Installing the app and offline caching require HTTPS** (or `localhost`).
   On a plain `http://192.168.x.x` the site works, but neither feature turns on.

## Tags

`latest`, `1.0.3` — `linux/amd64`.
