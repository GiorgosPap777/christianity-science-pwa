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
| `LITE_ROOT` | `/data/lite` | the smaller 64 kbps copies (see below) |
| `PLAY_KBPS` | `512` | listening speed after the first `PLAY_BURST` bytes of each request, in kbit/s; `0` is full speed |
| `PLAY_BURST` | `131072` | bytes sent at full speed first, so playback starts at once |
| `SAVE_KBPS` | `1024` | speed of each offline save, in kbit/s; `0` is full speed |
| `SAVE_IDLE_KBPS` | `2048` | speed of each offline save while no one is streaming audio |
| `SAVE_SLOTS` | `2` | offline saves running at once, across all listeners; `0` is no limit |

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
purpose; `--include-older` fetches them as well. An episode whose download
failed is tried again on the next run, even if a newer one was saved
meanwhile. `--dry-run` shows what would be downloaded, and `--max` (default
10) caps the episodes per run.

The site sometimes lists a broadcast before all of its parts are up: a new
episode with fewer than the usual 4 parts waits and is completed on a later
run, or saved as it is after 3 days, and a recent episode that the site now
lists with more parts gets the missing ones.

Once, by hand: `docker compose run --rm fetcher fetch --dry-run`.

## Smaller copies

About a quarter of the parts, most of seasons 16–19 and some older ones, are
112–192 kbps, two to three times the size of the rest for the same speech. The `lite` command writes a 64 kbps
mono copy of every part above 80 kbps to `/data/lite` (the archive is only
read), and the index then points at the copies, so a listener needs a
third to a half of the bandwidth. Run it once for the whole archive (about
3.8 GB of copies; it takes a while, at low priority):

```bash
docker compose run --rm fetcher lite
```

After that the fetcher makes copies of new episodes as they arrive. The
player and the fetcher must share the `/data` volume.

## What it does

- Continuous playback across an episode's parts; optional autoplay into the
  next episode, across season boundaries.
- Multi-part series shown as one row in their season, playable start to
  finish, and opened with a tap to show the parts.
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
- **Save for offline** — a button in the player saves an episode to the
  device; nothing is downloaded unless you ask. The server paces saves
  (`SAVE_KBPS`, faster while no one is listening, and `SAVE_SLOTS`) so they
  cannot saturate a home uplink: a 40 MB episode takes 3–5 minutes.
- **Quick seeking on a small uplink** — listening is paced too (`PLAY_KBPS`,
  after a `PLAY_BURST` sent at once), so a seek never waits behind the rest
  of a part already on its way.

## Three things that will bite you

1. **Behind a reverse proxy, `Range` headers must be forwarded and responses
   must not be buffered**, or seeking inside an episode breaks. (nginx:
   `proxy_buffering off;`)
2. **Installing the app and saving for offline require HTTPS** (or `localhost`).
   On a plain `http://192.168.x.x` the site works, but neither feature turns on.
3. **Behind Cloudflare or another CDN, bypass its cache for `.mp3`.** On a
   cache miss Cloudflare drops `Range` and fetches the whole part first, so a
   seek waits for most of the part to cross your uplink. A Cache Rule, *URI
   path ends with `.mp3`* → *Bypass cache*, fixes it.

## Tags

`latest` follows `main`; versioned tags (`1.0.4`, …) are published for
releases. `linux/amd64`.
