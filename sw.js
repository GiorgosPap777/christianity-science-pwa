/* Service worker for Χριστιανισμός - Επιστήμη.

   Two jobs:
   1. Keep the app shell available offline (network-first, so edits still land).
   2. Serve cached mp3 parts -- including RANGE requests, which is what an
      <audio> element actually issues. A cached response is a full 200 body, so
      byte ranges are sliced out of it here and returned as 206. Without this,
      seeking in a cached part would fail.

   Registered with scope "/" (see the Service-Worker-Allowed header in serve.py)
   so it can intercept the audio living at the archive root, not just /_site/. */

const VERSION = "v8";
const SHELL = `cs-shell-${VERSION}`;
const AUDIO = "cs-audio-v1";          // unversioned: survives shell updates

/* How long the shell waits for the network before falling back to its cached
   copy. On a connection that is up but passes nothing (a tunnel, a lift, one
   bar of signal) fetch() can hang far longer than that before it fails. */
const NETWORK_TIMEOUT_MS = 3000;

const SHELL_ASSETS = [
  "/_site/",
  "/_site/index.html",
  "/_site/app.js",
  "/_site/i18n.js",
  "/_site/styles.css",
  "/_site/index.json",
  "/_site/manifest.webmanifest",
  "/_site/icons/icon-192.png",
  "/_site/icons/icon-512.png",
  "/_site/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Individually, so one missing file cannot fail the whole install.
    await Promise.all(SHELL_ASSETS.map(async (url) => {
      try {
        const res = await fetch(url, { cache: "reload" });
        if (res.ok && !res.redirected) await cache.put(url, res);
      } catch (e) { /* offline at install time; picked up later */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((n) => {
      if (n !== SHELL && n !== AUDIO) return caches.delete(n);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.toLowerCase().endsWith(".mp3")) {
    event.respondWith(audioResponse(req, url));
  } else {
    event.respondWith(networkFirst(req, event));
  }
});

/* ------------------------------------------------------------------ audio */

async function audioResponse(req, url) {
  const cache = await caches.open(AUDIO);
  const hit = await cache.match(url.pathname);

  if (!hit) {
    // Not saved for offline -- stream from the server, range headers intact.
    return fetch(req);
  }

  const range = req.headers.get("range");
  const blob = await hit.blob();
  const size = blob.size;
  const type = hit.headers.get("Content-Type") || "audio/mpeg";

  if (!range) {
    return new Response(blob, {
      status: 200,
      headers: {
        "Content-Type": type,
        "Content-Length": String(size),
        "Accept-Ranges": "bytes",
      },
    });
  }

  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m) return new Response(blob, { status: 200, headers: { "Content-Type": type } });

  let start, end;
  if (m[1] === "") {
    if (m[2] === "") return new Response(blob, { status: 200, headers: { "Content-Type": type } });
    const len = Math.min(parseInt(m[2], 10), size);
    start = size - len;
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === "" ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }

  if (start >= size || start > end) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" },
    });
  }

  const slice = blob.slice(start, end + 1);
  return new Response(slice, {
    status: 206,
    statusText: "Partial Content",
    headers: {
      "Content-Type": type,
      "Content-Length": String(slice.size),
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
    },
  });
}

/* ------------------------------------------------------------------ shell */

async function networkFirst(req, event) {
  const cache = await caches.open(SHELL);
  let stored = Promise.resolve();
  const network = fetch(req).then((res) => {
    if (res && res.ok && !res.redirected) stored = cache.put(req, res.clone()).catch(() => {});
    return res;
  });
  /* If the cached copy wins the race, the network response still lands in
     the cache, ready for the next load. */
  event.waitUntil(network.then(() => stored, () => {}));

  const cached = async () =>
    (await cache.match(req)) ||
    (req.mode === "navigate" ? await cache.match("/_site/") : undefined);

  let timer;
  const slow = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS);
  });
  try {
    const res = await Promise.race([network, slow]);
    if (res) return res;
    return (await cached()) || (await network);   // nothing cached: keep waiting
  } catch (err) {
    const hit = await cached();
    if (hit) return hit;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
