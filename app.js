/* Χριστιανισμός - Επιστήμη — local archive player.
   Vanilla JS, no dependencies. Loads index.json, renders seasons, and drives a
   single <audio> element through parts and episodes. All user state lives in
   localStorage. */

"use strict";

/* ------------------------------------------------------------------ store */

const K = "cs:v1:";

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(K + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (e) { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(K + key, JSON.stringify(value)); } catch (e) {}
}

/* Saved state is checked on the way in. A value from an older version, a
   half-written one or a hand edit must not break the app: an invalid
   playbackRate, for one, throws, and would come back on every reload. Each
   key keeps what is valid and falls back to its default for the rest. */
const SPEEDS = Array.from(document.querySelectorAll("#speed option"), (o) => parseFloat(o.value));
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && isFinite(v);
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

const CLEAN = {
  lang: (v) => (v === "en" ? "en" : "el"),
  progress: (v) => {                   // id -> {part, time, updated}
    const out = {};
    if (isObj(v)) Object.keys(v).forEach((id) => {
      const p = v[id];
      if (isObj(p) && Number.isInteger(p.part) && p.part >= 0 && isNum(p.time) && p.time >= 0) {
        out[id] = { part: p.part, time: p.time, updated: isNum(p.updated) ? p.updated : 0 };
      }
    });
    return out;
  },
  listened: (v) => {                   // id -> true
    const out = {};
    if (isObj(v)) Object.keys(v).forEach((id) => { if (v[id] === true) out[id] = true; });
    return out;
  },
  last: (v) => (isObj(v) && typeof v.id === "string" ? {   // {id, part, time}
    id: v.id,
    part: Number.isInteger(v.part) && v.part >= 0 ? v.part : 0,
    time: isNum(v.time) && v.time >= 0 ? v.time : 0,
  } : null),
  recent: strings,                     // [id, ...] most recent first
  cachedEps: strings,                  // ids held in the audio cache, MRU first
  ui: (v) => {
    const u = isObj(v) ? v : {};
    return {
      sort: u.sort === "oldest" ? "oldest" : "newest",
      unheardOnly: u.unheardOnly === true,
      open: Array.isArray(u.open) ? u.open.filter(Number.isInteger) : [],  // season numbers
      volume: isNum(u.volume) ? Math.max(0, Math.min(1, u.volume)) : 1,
      speed: SPEEDS.indexOf(u.speed) !== -1 ? u.speed : 1,
      offlineCache: u.offlineCache !== false,
    };
  },
};
const load = (key) => CLEAN[key](read(key, null));

const store = {};
Object.keys(CLEAN).forEach((key) => { store[key] = load(key); });

/* The installed app and a browser tab can be open at once, so a change is
   applied to a fresh read of its key, not to this tab's copy, which would
   write back whatever was there when this tab loaded. `change` edits the
   value in place or returns a new one. */
function update(key, change) {
  const v = load(key);
  const res = change(v);
  store[key] = res === undefined ? v : res;
  write(key, store[key]);
}

const saveUI     = () => write("ui", store.ui);   // view settings: per tab, last one wins
const saveLast   = () => write("last", store.last);

window.__lang = store.lang;

/* ------------------------------------------------------------- utilities */

const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel));

/* Per-code-point normalisation: lowercase, drop Greek diacritics, fold final
   sigma. Each code point maps to exactly one, so indices stay aligned with the
   original string and search hits can be highlighted accurately. */
function normCP(cp) {
  let x = cp.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (x.length !== 1) x = x.charAt(0) || cp;
  return x === "\u03C2" ? "\u03C3" : x;   // ς -> σ
}
function normalize(s) {
  return Array.from(s).map(normCP).join("");
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => (n < 10 ? "0" + n : "" + n);
  return h > 0 ? h + ":" + pad(m) + ":" + pad(s) : m + ":" + pad(s);
}

/* --------------------------------------------------------------- app data */

let DATA = null;
let SEASONS = [];          // chronological, season 1 .. N
let FLAT = [];             // every episode, chronological across the archive
const BY_ID = Object.create(null);

/* Autoplay and the prev/next episode buttons both walk FLAT, so a season's
   last episode continues into the next season instead of dead-ending. */
function neighbour(ep, delta) {
  const i = ep._i + delta;
  return (i >= 0 && i < FLAT.length) ? FLAT[i] : null;
}

function epTotal(ep) {
  if (ep.totalDur) return ep.totalDur;
  let sum = 0;
  for (const p of ep.parts) sum += p.dur || 0;
  return sum;
}
function elapsedBefore(ep, partIdx) {
  let sum = 0;
  for (let i = 0; i < partIdx; i++) sum += ep.parts[i].dur || 0;
  return sum;
}

const isListened = (id) => !!store.listened[id];
/* Played to the end (or marked so), and not started again since. */
const finished = (id) => isListened(id) && !store.progress[id];

function setListened(id, on) {
  update("listened", (l) => { if (on) l[id] = true; else delete l[id]; });
}

/* Where an episode picks up: its saved position, else the start. */
function resumeAt(ep) {
  const p = store.progress[ep.id];
  return p && p.part < ep.parts.length ? p : { part: 0, time: 0 };
}

function seasonLabel(s) {
  return store.lang === "el" ? s.dir : t("season.label", { n: s.num });
}
function epDate(ep) {
  return store.lang === "el" ? ep.dateLabel : (ep.dateLabelEn || ep.dateLabel);
}

/* ------------------------------------------------------------------- i18n */

function applyI18n() {
  window.__lang = store.lang;
  document.documentElement.lang = store.lang;
  document.title = t("app.title");

  $$("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  $$("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  $$("[data-i18n-title]").forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  $$("[data-i18n-aria-label]").forEach((el) => {
    el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel));
  });

  const fu = $("#filter-unheard");
  if (fu) fu.textContent = t(store.ui.unheardOnly ? "filter.unheardOn" : "filter.unheard");

  $$(".lang-btn").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.lang === store.lang));
  });

  if (DATA) {
    const hours = Math.round(
      FLAT.reduce((a, e) => a + epTotal(e), 0) / 3600);
    $("#subtitle").textContent = t("app.subtitle", {
      seasons: DATA.counts.seasons,
      episodes: DATA.counts.episodes,
      hours: hours.toLocaleString(store.lang === "el" ? "el-GR" : "en-GB"),
    });
  }

  $("#sort-toggle").textContent =
    t(store.ui.sort === "newest" ? "sort.newest" : "sort.oldest");
  renderOfflineChip();
  renderNetBanner();
  labelSleepOptions();
  renderSleep();
  updateExpandLabel();
  updatePlayerText();
}

/* ------------------------------------------------------------------ state */

/* query: the normalised search text; terms: its words. Every word must match
   the title or the date, in any order, so "εξελιξη 2009" works. */
const view = { query: "", terms: [], debounce: 0 };

function setQuery(raw) {
  view.query = normalize(raw.trim());
  view.terms = view.query.split(/\s+/).filter(Boolean);
}

function matches(ep) {
  if (store.ui.unheardOnly && isListened(ep.id)) return false;
  for (const w of view.terms) {
    if (ep._norm.indexOf(w) === -1 && ep._dateNorm.indexOf(w) === -1) return false;
  }
  return true;
}

/* ---------------------------------------------------------------- render */

/* Text with every occurrence of every search word wrapped in <mark>. `norm`
   is normalize(text): same length in code points, so indices line up. */
function highlight(text, norm) {
  const frag = document.createDocumentFragment();
  const hits = [];
  for (const w of view.terms) {
    for (let i = norm.indexOf(w); i !== -1; i = norm.indexOf(w, i + 1)) {
      hits.push([i, i + w.length]);
    }
  }
  if (hits.length === 0) {
    frag.appendChild(document.createTextNode(text));
    return frag;
  }
  hits.sort((a, b) => a[0] - b[0]);
  const cps = Array.from(text);
  let pos = 0;
  for (const [a, b] of hits) {
    if (b <= pos) continue;                        // inside an earlier mark
    const from = Math.max(a, pos);
    if (from > pos) frag.appendChild(document.createTextNode(cps.slice(pos, from).join("")));
    const mk = document.createElement("mark");
    mk.textContent = cps.slice(from, b).join("");
    frag.appendChild(mk);
    pos = b;
  }
  if (pos < cps.length) frag.appendChild(document.createTextNode(cps.slice(pos).join("")));
  return frag;
}

const SVG_PLAY  = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
const SVG_PAUSE = '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';
const SVG_CHECK = '<svg viewBox="0 0 24 24"><path d="M4 12.5l5 5L20 6.5" fill="none"/></svg>';
const SVG_CARET = '<svg class="caret" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7z"/></svg>';
const SVG_CLOUD = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 19a4.5 4.5 0 01-.4-8.98 6 6 0 0111.64-1.7A4.25 4.25 0 0117.75 19z"/></svg>';

/* The row's play button turns into pause while that episode is playing, and
   shows the buffering ring like the player's. */
function setRowButton(btn, ep) {
  const playing = !!(cur && cur.ep === ep && isPlaying());
  btn.toggleAttribute("data-loading", playing && loading);
  btn.innerHTML = playing ? SVG_PAUSE : SVG_PLAY;
  const lbl = t(playing ? "player.pause" : "ep.play");
  btn.title = lbl;
  btn.setAttribute("aria-label", lbl + ": " + ep.title);
}

function episodeRow(ep) {
  const row = document.createElement("div");
  row.className = "ep";
  row.dataset.id = ep.id;
  if (isListened(ep.id)) row.classList.add("listened");
  if (cur && cur.ep === ep) row.classList.add("playing");

  const play = document.createElement("button");
  play.type = "button";
  play.className = "ep-play";
  setRowButton(play, ep);
  play.addEventListener("click", () => {
    if (cur && cur.ep === ep) { togglePlay(); return; }
    const p = resumeAt(ep);
    loadEpisode(ep, p.part, p.time, true);
  });

  const main = document.createElement("div");
  main.className = "ep-main";

  const title = document.createElement("span");
  title.className = "ep-title";
  title.appendChild(highlight(ep.title, ep._norm));
  main.appendChild(title);

  const sub = document.createElement("div");
  sub.className = "ep-sub";
  const date = document.createElement("span");
  date.className = "ep-date";
  const dl = epDate(ep);
  date.appendChild(highlight(dl, normalize(dl)));
  sub.appendChild(date);

  sub.insertAdjacentHTML("beforeend", '<span class="dot">·</span>');
  const dur = document.createElement("span");
  dur.textContent = t("ep.duration", { n: Math.round(epTotal(ep) / 60) });
  sub.appendChild(dur);

  if (ep.parts.length !== 4) {
    sub.insertAdjacentHTML("beforeend", '<span class="dot">·</span>');
    const np = document.createElement("span");
    np.textContent = t("ep.parts", { n: ep.parts.length });
    sub.appendChild(np);
  }

  const prog = store.progress[ep.id];
  if (prog && !isListened(ep.id)) {
    sub.insertAdjacentHTML("beforeend", '<span class="dot">·</span>');
    const res = document.createElement("span");
    res.className = "ep-resume";
    res.textContent = t("ep.part", { n: prog.part + 1, total: ep.parts.length });
    sub.appendChild(res);
  }

  if (store.cachedEps.indexOf(ep.id) !== -1) {
    const saved = document.createElement("span");
    saved.className = "ep-saved";
    saved.innerHTML = SVG_CLOUD;
    saved.title = t("ep.saved");
    saved.setAttribute("role", "img");
    saved.setAttribute("aria-label", t("ep.saved"));
    sub.appendChild(saved);
  }
  main.appendChild(sub);

  if (prog && !isListened(ep.id)) {
    const total = epTotal(ep);
    const done = elapsedBefore(ep, prog.part) + (prog.time || 0);
    const bar = document.createElement("div");
    bar.className = "ep-progress-sliver";
    bar.innerHTML = '<i style="width:' +
      Math.max(1, Math.min(100, (done / total) * 100)).toFixed(1) + '%"></i>';
    main.appendChild(bar);
  }

  const check = document.createElement("button");
  check.type = "button";
  check.className = "ep-check";
  check.innerHTML = SVG_CHECK;
  const lbl = isListened(ep.id) ? "ep.markUnlistened" : "ep.markListened";
  check.title = t(lbl);
  check.setAttribute("aria-label", t(lbl));
  check.setAttribute("aria-pressed", String(isListened(ep.id)));
  check.addEventListener("click", (e) => {
    e.stopPropagation();
    setListened(ep.id, !isListened(ep.id));
    render();
  });

  row.appendChild(play);
  row.appendChild(main);
  row.appendChild(check);
  return row;
}

/* Rebuilding the list would drop keyboard focus onto <body>, which puts a
   keyboard or screen-reader user back at the top of the page. So the focused
   control is noted first and found again in the new list: the same button of
   the same episode, else that season's header. */
function focusedInList() {
  const el = document.activeElement;
  if (!el || !$("#seasons").contains(el)) return null;
  const row = el.closest(".ep");
  const sec = el.closest(".season");
  const cls = ["ep-play", "ep-check"].filter((c) => el.classList.contains(c))[0];
  return { id: row && row.dataset.id, cls: cls, season: sec && sec.dataset.num };
}
function refocus(f) {
  if (!f) return;
  const row = f.id && f.cls &&
    document.querySelector('.ep[data-id="' + cssEscape(f.id) + '"]');
  const el = (row && row.querySelector("." + f.cls)) ||
    (f.season && document.querySelector('.season[data-num="' + f.season + '"] .season-head'));
  if (el) el.focus({ preventScroll: true });
}

function renderSeasons() {
  const host = $("#seasons");
  const focus = focusedInList();
  host.textContent = "";
  const searching = !!view.query;
  document.body.classList.toggle("searching", searching);
  let shown = 0;

  // Seasons follow the same newest/oldest toggle as the episodes inside them.
  // Copy before reversing: SEASONS stays index-ordered for SEASONS[ep.season-1].
  const seasons = store.ui.sort === "newest" ? SEASONS.slice().reverse() : SEASONS;

  for (const s of seasons) {
    const eps = s.episodes.filter(matches);
    shown += eps.length;
    if ((searching || store.ui.unheardOnly) && eps.length === 0) continue;

    const open = searching ? true : store.ui.open.indexOf(s.num) !== -1;

    const sec = document.createElement("section");
    sec.className = "season";
    sec.dataset.open = String(open);
    sec.dataset.num = s.num;

    const head = document.createElement("button");
    head.type = "button";
    head.className = "season-head";
    head.setAttribute("aria-expanded", String(open));
    head.innerHTML = SVG_CARET;

    const name = document.createElement("span");
    name.className = "season-name";
    name.textContent = seasonLabel(s);
    if (s.yearStart) {
      const yr = document.createElement("span");
      yr.className = "season-years";
      yr.textContent = "  " + (s.yearStart === s.yearEnd
        ? s.yearStart : s.yearStart + "–" + s.yearEnd);
      name.appendChild(yr);
    }
    head.appendChild(name);

    const meta = document.createElement("span");
    meta.className = "season-meta";
    const unheard = s.episodes.filter((e) => !isListened(e.id)).length;
    if (unheard === 0) {
      meta.textContent = t("season.allListened");
    } else {
      const count = document.createElement("span");
      count.className = "season-count";               // hidden on phones
      count.textContent = t("season.episodes", { n: s.episodes.length }) + " ";
      meta.appendChild(count);
      const pill = document.createElement("span");
      pill.className = "unheard-pill";
      pill.textContent = t("season.unheard", { n: unheard });
      meta.appendChild(pill);
    }
    head.appendChild(meta);

    const heard = s.episodes.length - unheard;
    if (heard > 0) {
      const bar = document.createElement("span");
      bar.className = "season-bar";
      bar.setAttribute("role", "img");
      bar.setAttribute("aria-label",
        t("season.progress", { done: heard, total: s.episodes.length }));
      bar.innerHTML = '<i style="width:' +
        ((heard / s.episodes.length) * 100).toFixed(1) + '%"></i>';
      head.appendChild(bar);
    }

    head.addEventListener("click", () => {
      if (view.query) return;                      // stays open while searching
      const i = store.ui.open.indexOf(s.num);
      if (i === -1) store.ui.open.push(s.num); else store.ui.open.splice(i, 1);
      saveUI();
      render();
    });
    /* A heading, so screen readers can jump from season to season. */
    const h = document.createElement("h2");
    h.className = "season-title";
    h.appendChild(head);
    sec.appendChild(h);

    if (open) {
      const body = document.createElement("div");
      body.className = "season-body";
      const ordered = store.ui.sort === "newest" ? eps.slice().reverse() : eps;
      for (const ep of ordered) body.appendChild(episodeRow(ep));
      sec.appendChild(body);
    }
    host.appendChild(sec);
  }

  const st = $("#search-status");
  if (searching) {
    st.hidden = false;
    st.textContent = shown === 0
      ? t("search.noResults", { q: $("#search").value })
      : t("search.results", { n: shown });
    st.classList.toggle("error", shown === 0);
  } else {
    st.hidden = true;
  }
  refocus(focus);
}

function renderContinue() {
  const sec = $("#continue-section");
  const last = store.last;
  const ep = last && BY_ID[last.id];
  if (!ep || finished(ep.id)) { sec.hidden = true; return; }
  sec.hidden = false;

  const total = epTotal(ep);
  const done = elapsedBefore(ep, last.part) + (last.time || 0);

  const card = $("#continue-card");
  card.textContent = "";
  card.className = "continue-card";

  const main = document.createElement("div");
  main.className = "continue-main";
  const ttl = document.createElement("div");
  ttl.className = "continue-title";
  ttl.textContent = ep.title;
  const sub = document.createElement("div");
  sub.className = "continue-sub";
  sub.textContent = seasonLabel(SEASONS[ep.season - 1]) + " · " +
    t("continue.at", {
      part: last.part + 1, total: ep.parts.length, time: fmtTime(last.time || 0),
    });
  const bar = document.createElement("div");
  bar.className = "mini-bar";
  bar.innerHTML = '<i style="width:' +
    Math.max(1, Math.min(100, (done / total) * 100)).toFixed(1) + '%"></i>';
  main.appendChild(ttl); main.appendChild(sub); main.appendChild(bar);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-primary";
  btn.innerHTML = SVG_PLAY;
  btn.appendChild(document.createTextNode(t("continue.resume")));
  btn.addEventListener("click", () => loadEpisode(ep, last.part, last.time, true));

  card.appendChild(main);
  card.appendChild(btn);
}

function renderRecent() {
  const sec = $("#recent-section");
  const inContinue = store.last && !finished(store.last.id) ? store.last.id : null;
  const ids = store.recent.filter((id) => BY_ID[id] && id !== inContinue);
  if (ids.length === 0) { sec.hidden = true; return; }
  sec.hidden = false;

  const list = $("#recent-list");
  list.textContent = "";
  ids.slice(0, 8).forEach((id) => {
    const ep = BY_ID[id];
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "recent-btn";
    const ttl = document.createElement("span");
    ttl.className = "rt";
    ttl.textContent = ep.title;
    const sm = document.createElement("span");
    sm.className = "rs";
    sm.textContent = epDate(ep);
    b.appendChild(ttl); b.appendChild(sm);
    b.addEventListener("click", () => {
      const p = resumeAt(ep);
      loadEpisode(ep, p.part, p.time, true);
    });
    li.appendChild(b);
    list.appendChild(li);
  });
}

function render() {
  renderContinue();
  renderRecent();
  renderSeasons();
}

/* ----------------------------------------------------------------- player */

const audio = $("#audio");
let cur = null;            // {ep, part}
let pendingSeek = 0;
let scrubbing = false;
let lastSave = 0;
let lastGood = 0;          // position in the part that last played without error
let retryOnline = false;   // a part failed while playing; retry when back online
let loading = false;       // playing, but waiting for data

/* Whether this tab has a position of its own to save. A tab that only put
   the last episode back on screen at startup has nothing new, and saving
   would overwrite what another tab has played since. */
let dirty = false;
/* Another tab has saved a newer position since this one last played. This
   tab then saves nothing, and its next Play picks up from that position. */
let handedOff = false;

const isPlaying = () => !audio.paused && !audio.error;
/* A seek or skip here is the listener's own doing: it is saved, and this
   tab's position counts again over the other tab's. */
function takeOver() { dirty = true; handedOff = false; }

/* `quiet` only puts the episode on screen, saving nothing: restoring it at
   startup, or following another tab. */
function loadEpisode(ep, part, time, autoplay, quiet) {
  if (!ep) return;
  part = Math.max(0, Math.min(part | 0, ep.parts.length - 1));
  cur = { ep: ep, part: part };
  pendingSeek = time || 0;
  lastGood = pendingSeek;
  retryOnline = false;
  setLoading(false);

  audio.src = ep.parts[part].url;
  audio.playbackRate = store.ui.speed;
  audio.volume = store.ui.volume;
  audio.load();

  $("#player").hidden = false;
  document.body.classList.remove("no-player");

  handedOff = false;
  dirty = !quiet;
  if (!quiet) {
    noteRecent(ep.id);
    persistPosition(true);
  }

  /* Saving for offline starts once the episode actually plays (see the play
     event), not when it is merely loaded: putting last session's episode
     back on screen must not download 50 MB nobody asked for. Moving to
     another episode stops saving the previous one. */
  if (prefetchedFor !== ep.id) {
    if (prefetchCtl) prefetchCtl.abort();
    prefetchedFor = null;
    setOffline(store.cachedEps.indexOf(ep.id) !== -1 ? "ready" : "idle");
  }

  if (autoplay) {
    const p = audio.play();
    if (p && p.catch) p.catch(() => {});
  }
  updatePlayerText();
  updateMediaSession();
  render();
}

function noteRecent(id) {
  if (store.recent[0] === id) return;
  update("recent", (r) => [id].concat(r.filter((x) => x !== id)).slice(0, 20));
}

function skip(delta) {
  if (!cur || !isFinite(audio.duration)) return;
  audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + delta));
  takeOver();
}

function play() {
  if (!cur) return;
  if (handedOff) {
    if (followOtherTab(true)) return;
  }
  /* After a load error (a tunnel at a part boundary, a server blip) the
     element is dead and play() only rejects, so load the part again from
     where it stopped. */
  if (audio.error) {
    loadEpisode(cur.ep, cur.part, lastGood, true);
    return;
  }
  const p = audio.play();
  if (p && p.catch) p.catch(() => {});
}

function togglePlay() {
  if (!cur) return;
  if (isPlaying()) audio.pause();
  else play();
}

/* Picks up where another tab left off. Returns false if there is nothing to
   pick up, e.g. that tab finished the newest episode. */
function followOtherTab(autoplay) {
  handedOff = false;
  dirty = false;
  const last = store.last;
  const ep = last && BY_ID[last.id];
  if (!ep) return false;
  loadEpisode(ep, last.part, last.time, autoplay, !autoplay);
  return true;
}

function setLoading(on) {
  if (loading === on) return;
  loading = on;
  const b = $("#btn-play");
  b.toggleAttribute("data-loading", on);
  if (on) b.setAttribute("aria-busy", "true"); else b.removeAttribute("aria-busy");
  markPlayingRow();
}

function goPart(delta) {
  if (!cur) return;
  const next = cur.part + delta;
  if (next < 0 || next >= cur.ep.parts.length) return;
  loadEpisode(cur.ep, next, 0, true);
}

function goEpisode(delta) {
  if (!cur) return;
  const nx = neighbour(cur.ep, delta);
  if (!nx) return;
  const p = resumeAt(nx);
  loadEpisode(nx, p.part, p.time, true);
}

function onEnded() {
  if (!cur) return;
  const ep = cur.ep;
  const lastPart = cur.part >= ep.parts.length - 1;
  /* A sleep timer set to "end of part/episode" still advances the position,
     just paused, so the next tap resumes where listening should continue. */
  const stop = sleep.mode === "part" || (sleep.mode === "episode" && lastPart);
  if (stop) clearSleep();

  if (!lastPart) {
    loadEpisode(ep, cur.part + 1, 0, !stop);      // next part, seamless
    return;
  }
  setListened(ep.id, true);                       // all parts played through
  update("progress", (p) => { delete p[ep.id]; });
  const nx = neighbour(ep, 1);
  if (nx) {
    const p = resumeAt(nx);                        // it may have been started before
    loadEpisode(nx, p.part, p.time, !stop);
    return;
  }
  /* Caught up with the newest episode: there is nothing to continue, so the
     Continue card goes and the next start does not bring this one back. */
  store.last = null;
  saveLast();
  dirty = false;
  updatePlayerText();
  render();
}

/* ------------------------------------------------------------ sleep timer

   "15".."60" stop after that many minutes, fading out over the last few
   seconds; "part" / "episode" stop when that ends (see onEnded). Not
   persisted: a timer from last night should not fire tomorrow. */

const SLEEP_FADE_MS = 10000;
const sleep = { mode: "off", until: 0, tick: 0 };

function setSleep(value) {
  clearSleep();
  if (value === "part" || value === "episode") {
    sleep.mode = value;
  } else if (parseInt(value, 10) > 0) {
    sleep.mode = "time";
    sleep.until = Date.now() + parseInt(value, 10) * 60000;
    sleep.tick = setInterval(checkSleep, 1000);
  }
  renderSleep();
}

function clearSleep() {
  clearInterval(sleep.tick);
  if (sleep.mode === "time") audio.volume = store.ui.volume;   // undo any fade
  sleep.mode = "off";
  sleep.until = 0;
  renderSleep();
}

function checkSleep() {
  if (sleep.mode !== "time") return;
  const left = sleep.until - Date.now();
  if (left <= 0) {
    audio.pause();
    clearSleep();
    return;
  }
  if (left < SLEEP_FADE_MS) audio.volume = store.ui.volume * (left / SLEEP_FADE_MS);
  renderSleep();
}

function renderSleep() {
  const chip = $("#sleep-chip");
  if (!chip) return;
  const label = $("#sleep-label");
  const sel = $("#sleep");
  chip.dataset.active = String(sleep.mode !== "off");
  if (sleep.mode === "time") {
    label.textContent = fmtTime(Math.max(0, (sleep.until - Date.now()) / 1000));
  } else if (sleep.mode === "part") {
    label.textContent = t("sleep.partShort");
  } else if (sleep.mode === "episode") {
    label.textContent = t("sleep.episodeShort");
  } else {
    label.textContent = "";
    sel.value = "0";
  }
}

/* Separate from renderSleep, which runs every second: rewriting the options
   while the native picker is open would make it flicker. */
function labelSleepOptions() {
  Array.prototype.forEach.call($("#sleep").options, (o) => {
    o.textContent = o.value === "0" ? t("sleep.off")
      : o.value === "part" ? t("sleep.part")
      : o.value === "episode" ? t("sleep.episode")
      : t("sleep.min", { n: parseInt(o.value, 10) });
  });
}

function persistPosition(force) {
  if (!cur || !dirty || handedOff) return;
  const now = Date.now();
  if (!force && now - lastSave < 5000) return;
  lastSave = now;
  const time = audio.error ? lastGood
    : pendingSeek > 0 ? pendingSeek : (audio.currentTime || 0);
  const id = cur.ep.id, part = cur.part;
  update("progress", (p) => { p[id] = { part: part, time: time, updated: now }; });
  store.last = { id: id, part: part, time: time };
  saveLast();
  renderContinue();   // keep the "continue listening" card in step with playback
}

/* ------------------------------------------------------------- player UI */

function updatePlayerText() {
  const title = $("#p-title"), sub = $("#p-sub");
  if (!cur) {
    title.textContent = t("player.empty");
    sub.textContent = "";
    $("#listened-label").textContent = t("ep.markListened");
    return;
  }
  const ep = cur.ep;
  title.textContent = ep.title;
  /* Spans, so the full-screen view can drop the part number, which its parts
     bar already shows. The " · " separators come from styles.css. */
  sub.textContent = "";
  [["season", seasonLabel(SEASONS[ep.season - 1])],
   ["part", t("ep.part", { n: cur.part + 1, total: ep.parts.length })],
   ["date", epDate(ep)]].forEach((x) => {
    const span = document.createElement("span");
    span.className = "sub-" + x[0];
    span.textContent = x[1];
    sub.appendChild(span);
  });
  renderParts();

  /* On a phone only the check icon shows, so the label also goes into the
     accessible name and tooltip. */
  const on = isListened(ep.id);
  const chip = $("#btn-listened");
  const heard = on ? t("ep.listened") : t("ep.markListened");
  $("#listened-label").textContent = heard;
  chip.title = heard;
  chip.setAttribute("aria-label", heard);
  chip.setAttribute("aria-pressed", String(on));

  $("#btn-prev-part").disabled = cur.part === 0;
  $("#btn-next-part").disabled = cur.part >= ep.parts.length - 1;
  $("#btn-prev-ep").disabled = !neighbour(ep, -1);
  $("#btn-next-ep").disabled = !neighbour(ep, 1);

  const playing = isPlaying();
  $("#btn-play").dataset.state = playing ? "playing" : "paused";
  const lbl = t(playing ? "player.pause" : "player.play");
  $("#btn-play").title = lbl;
  $("#btn-play").setAttribute("aria-label", lbl);
}

/* Paints the played portion of a range input (see --pct in styles.css). */
function setFill(el) {
  const min = parseFloat(el.min) || 0;
  const max = parseFloat(el.max);
  const pct = max > min ? ((parseFloat(el.value) - min) / (max - min)) * 100 : 0;
  el.style.setProperty("--pct", Math.max(0, Math.min(100, pct)).toFixed(2) + "%");
}

function updateTimes() {
  const dur = isFinite(audio.duration) ? audio.duration : 0;
  const t0 = audio.currentTime || 0;
  $("#t-cur").textContent = fmtTime(t0);
  $("#t-dur").textContent = fmtTime(dur);
  const seek = $("#seek");
  seek.max = dur || 1;
  if (!scrubbing) seek.value = t0;
  setFill(seek);
  seek.setAttribute("aria-valuetext",
    t("player.seekValue", { cur: fmtTime(t0), dur: fmtTime(dur) }));

  if (cur) {
    const total = epTotal(cur.ep);
    const done = elapsedBefore(cur.ep, cur.part) + t0;
    const pct = total ? Math.min(100, (done / total) * 100) : 0;
    $("#ep-progress-fill").style.width = pct.toFixed(2) + "%";
    const bar = $("#ep-progress");
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuenow", String(Math.round(pct)));

    const segs = $("#p-segs").children;
    const frac = dur ? Math.min(1, t0 / dur) : 0;
    for (let i = 0; i < segs.length; i++) {
      const w = i < cur.part ? 100 : i === cur.part ? frac * 100 : 0;
      segs[i].firstChild.style.width = w.toFixed(2) + "%";
    }
    $("#np-left").textContent = t("np.left", { time: fmtTime(Math.max(0, total - done)) });
  }
}

/* One segment per part, sized by its duration; tapping one jumps there. */
function renderParts() {
  const host = $("#p-segs");
  if (!cur) { host.textContent = ""; delete host.dataset.ep; return; }
  const ep = cur.ep;
  if (host.dataset.ep !== ep.id) {
    host.dataset.ep = ep.id;
    host.textContent = "";
    ep.parts.forEach((part, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "p-seg";
      b.style.flexGrow = String(part.dur || 1);
      b.appendChild(document.createElement("i"));
      b.addEventListener("click", () => {
        if (cur && cur.ep === ep && i !== cur.part) loadEpisode(ep, i, 0, true);
      });
      host.appendChild(b);
    });
  }
  Array.prototype.forEach.call(host.children, (b, i) => {
    const lbl = t("ep.part", { n: i + 1, total: ep.parts.length });
    b.title = lbl;
    b.setAttribute("aria-label", lbl);
    if (i === cur.part) b.setAttribute("aria-current", "step");
    else b.removeAttribute("aria-current");
  });
  $("#np-part").textContent = t("ep.part", { n: cur.part + 1, total: ep.parts.length });
}

const ARTWORK = [
  { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
  { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
];

function updateMediaSession() {
  if (!("mediaSession" in navigator) || !cur) return;
  try {
    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: cur.ep.title,
      artist: t("ep.part", { n: cur.part + 1, total: cur.ep.parts.length }),
      album: seasonLabel(SEASONS[cur.ep.season - 1]),
      artwork: ARTWORK,
    });
  } catch (e) {}
}

/* Lets the lock screen / notification draw a scrubber for the current part. */
function updatePositionState() {
  const ms = navigator.mediaSession;
  if (!ms) return;
  ms.playbackState = audio.paused ? "paused" : "playing";
  if (!ms.setPositionState || !isFinite(audio.duration) || audio.duration <= 0) return;
  try {
    ms.setPositionState({
      duration: audio.duration,
      position: Math.min(audio.currentTime || 0, audio.duration),
      playbackRate: audio.playbackRate || 1,
    });
  } catch (e) {}
}

/* ------------------------------------------------------------------ wire */

function updateExpandLabel() {
  const allOpen = store.ui.open.length >= SEASONS.length && SEASONS.length > 0;
  $("#expand-toggle").textContent = t(allOpen ? "nav.collapseAll" : "nav.expandAll");
}

function wire() {
  /* language */
  $$(".lang-btn").forEach((b) => b.addEventListener("click", () => {
    store.lang = b.dataset.lang;
    write("lang", store.lang);
    applyI18n();
    render();
  }));

  /* search */
  const search = $("#search");
  search.addEventListener("input", () => {
    clearTimeout(view.debounce);
    $("#search-clear").hidden = !search.value;
    view.debounce = setTimeout(() => {
      setQuery(search.value);
      renderSeasons();
    }, 120);
  });
  $("#search-clear").addEventListener("click", () => {
    search.value = ""; setQuery("");
    $("#search-clear").hidden = true;
    renderSeasons();
    search.focus();
  });

  /* filters */
  $("#filter-unheard").addEventListener("click", (e) => {
    store.ui.unheardOnly = !store.ui.unheardOnly;
    e.currentTarget.setAttribute("aria-pressed", String(store.ui.unheardOnly));
    e.currentTarget.textContent =
      t(store.ui.unheardOnly ? "filter.unheardOn" : "filter.unheard");
    saveUI();
    render();
  });
  $("#sort-toggle").addEventListener("click", () => {
    store.ui.sort = store.ui.sort === "newest" ? "oldest" : "newest";
    $("#sort-toggle").textContent =
      t(store.ui.sort === "newest" ? "sort.newest" : "sort.oldest");
    saveUI();
    renderSeasons();
  });
  $("#expand-toggle").addEventListener("click", () => {
    const allOpen = store.ui.open.length >= SEASONS.length;
    store.ui.open = allOpen ? [] : SEASONS.map((s) => s.num);
    saveUI();
    updateExpandLabel();
    render();
  });

  /* transport */
  $("#btn-play").addEventListener("click", togglePlay);
  $("#btn-prev-part").addEventListener("click", () => goPart(-1));
  $("#btn-next-part").addEventListener("click", () => goPart(1));
  $("#btn-prev-ep").addEventListener("click", () => goEpisode(-1));
  $("#btn-next-ep").addEventListener("click", () => goEpisode(1));
  $("#btn-back15").addEventListener("click", () => skip(-15));
  $("#btn-fwd15").addEventListener("click", () => skip(15));
  $("#btn-listened").addEventListener("click", () => {
    if (!cur) return;
    setListened(cur.ep.id, !isListened(cur.ep.id));
    updatePlayerText();
    render();
  });

  /* offline caching */
  const off = $("#btn-offline");
  if (off) off.addEventListener("click", () => {
    store.ui.offlineCache = !store.ui.offlineCache;
    saveUI();
    if (store.ui.offlineCache) {
      prefetchedFor = null;
      schedulePrefetch();
    } else {
      if (prefetchCtl) prefetchCtl.abort();
      prefetchedFor = null;
      setOffline("idle");
      clearAudioCache().catch(() => {});
    }
    renderOfflineChip();
  });

  /* connection state */
  window.addEventListener("online", () => {
    renderNetBanner();
    /* A part that failed while playing (no signal) carries on by itself. */
    if (cur && audio.error && retryOnline) {
      retryOnline = false;
      loadEpisode(cur.ep, cur.part, lastGood, true);
    }
  });
  window.addEventListener("offline", renderNetBanner);

  /* other tabs */
  window.addEventListener("storage", onStorage);

  /* seek */
  const seek = $("#seek");
  seek.addEventListener("input", () => {
    scrubbing = true;
    setFill(seek);
    $("#t-cur").textContent = fmtTime(parseFloat(seek.value));
  });
  const commit = () => {
    if (!scrubbing) return;
    scrubbing = false;
    audio.currentTime = parseFloat(seek.value);
    takeOver();
    persistPosition(true);
  };
  seek.addEventListener("change", commit);
  seek.addEventListener("pointerup", commit);

  /* speed + volume */
  const speed = $("#speed");
  speed.value = String(store.ui.speed);
  speed.addEventListener("change", () => {
    store.ui.speed = parseFloat(speed.value);
    audio.playbackRate = store.ui.speed;
    saveUI();
  });
  const vol = $("#volume");
  vol.value = String(store.ui.volume);
  setFill(vol);
  vol.addEventListener("input", () => {
    store.ui.volume = parseFloat(vol.value);
    audio.volume = store.ui.volume;
    setFill(vol);
    saveUI();
  });

  /* audio element */
  audio.addEventListener("loadedmetadata", () => {
    if (pendingSeek > 0 && pendingSeek < audio.duration) {
      audio.currentTime = pendingSeek;
    }
    pendingSeek = 0;
    audio.playbackRate = store.ui.speed;
    updateTimes();
    updatePositionState();
  });
  audio.addEventListener("timeupdate", () => {
    if (!audio.error && pendingSeek === 0) lastGood = audio.currentTime || 0;
    updateTimes();
    persistPosition(false);
    checkSleep();     // timeupdate keeps firing in a background tab; intervals may not
  });
  audio.addEventListener("play", () => {
    takeOver();
    noteRecent(cur.ep.id);        // a restored episode only counts once played
    schedulePrefetch();
    updatePlayerText(); markPlayingRow(); updatePositionState();
  });
  audio.addEventListener("pause", () => {
    setLoading(false);
    updatePlayerText(); markPlayingRow(); updatePositionState(); persistPosition(true);
  });
  /* Buffering. `waiting` means playback stopped for want of data; `stalled`
     only that data is slow, which matters only once the buffer has run out. */
  const buffering = () => { if (!audio.paused && audio.readyState < 3) setLoading(true); };
  audio.addEventListener("waiting", buffering);
  audio.addEventListener("stalled", buffering);
  ["playing", "ended", "emptied"].forEach((ev) =>
    audio.addEventListener(ev, () => setLoading(false)));
  audio.addEventListener("seeked", updatePositionState);
  audio.addEventListener("ratechange", updatePositionState);
  audio.addEventListener("ended", onEnded);
  audio.addEventListener("error", () => {
    if (!audio.src || !cur) return;
    console.error("Audio failed to load:", audio.src);
    retryOnline = !audio.paused;
    setLoading(false);
    const saved = store.cachedEps.indexOf(cur.ep.id) !== -1;
    showToast(t(!navigator.onLine && !saved ? "player.notSaved" : "player.loadError"));
    updatePlayerText();
    markPlayingRow();
    renderNetBanner();
  });

  /* sleep timer */
  $("#sleep").addEventListener("change", (e) => setSleep(e.currentTarget.value));

  /* keyboard */
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && npIsOpen()) { e.preventDefault(); closeNowPlaying(); return; }
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea") return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === "Space" && keyboardFocusedButton(e.target)) return;  // let it press
    if (e.code === "Space") { e.preventDefault(); togglePlay(); }
    else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (e.shiftKey) goPart(-1); else skip(-15);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (e.shiftKey) goPart(1); else skip(15);
    }
  });

  /* flush position on the way out; on the way back, catch up with any
     other tab that played meanwhile */
  const flush = () => persistPosition(true);
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
    else if (handedOff && !isPlaying()) followOtherTab(false);
  });

  /* Keep the page's bottom padding equal to the player's real height, which
     changes when the controls row wraps. */
  const player = $("#player");
  if (window.ResizeObserver) new ResizeObserver(syncPlayerHeight).observe(player);
  window.addEventListener("resize", syncPlayerHeight);
  window.addEventListener("resize", renderOfflineChip);
  syncPlayerHeight();

  wireNowPlaying();

  /* OS media keys and lock screen. Play and pause are explicit rather than a
     toggle, so a stale lock-screen button cannot invert the state. */
  if ("mediaSession" in navigator) {
    const ms = navigator.mediaSession;
    const set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch (e) {} };
    set("play", () => { if (cur && !isPlaying()) play(); });
    set("pause", () => { if (cur && !audio.paused) audio.pause(); });
    /* Headphone and lock-screen buttons work in parts, but carry on across
       episodes. Previous restarts the part first, like most players. */
    set("previoustrack", () => {
      if (!cur) return;
      if ((audio.currentTime || 0) > 3) { audio.currentTime = 0; takeOver(); return; }
      if (cur.part > 0) { goPart(-1); return; }
      const pv = neighbour(cur.ep, -1);
      if (pv) loadEpisode(pv, pv.parts.length - 1, 0, true);
    });
    set("nexttrack", () => {
      if (!cur) return;
      if (cur.part < cur.ep.parts.length - 1) goPart(1); else goEpisode(1);
    });
    set("seekbackward", (d) => skip(-((d && d.seekOffset) || 15)));
    set("seekforward", (d) => skip((d && d.seekOffset) || 15));
    set("seekto", (d) => {
      if (!cur || !d || !isFinite(d.seekTime) || !isFinite(audio.duration)) return;
      audio.currentTime = Math.max(0, Math.min(audio.duration, d.seekTime));
      takeOver();
      persistPosition(true);
    });
  }
}

/* Another tab saved something. Listening marks, positions and the saved
   list are taken over as they are; this tab's view settings stay its own. */
function onStorage(e) {
  if (e.storageArea !== localStorage) return;
  const all = e.key === null;                      // storage was cleared
  const shared = ["listened", "progress", "recent", "cachedEps", "last"]
    .filter((k) => all || e.key === K + k);
  if (shared.length === 0) return;
  shared.forEach((k) => {
    if (k !== "last") store[k] = load(k);
    else if (!isPlaying()) {                       // while playing, ours is newer
      store.last = load("last");
      handedOff = true;
    }
  });
  if (!DATA) return;
  /* A tab in view shows the other tab's episode straight away. Only a new
     episode or part reloads the audio, not every 5 s save of the position;
     Play picks up the latest one anyway. */
  const l = store.last;
  if (handedOff && l && cur && document.visibilityState === "visible" &&
      (l.id !== cur.ep.id || l.part !== cur.part)) {
    followOtherTab(false);
  }
  render();
  updatePlayerText();
}

function syncPlayerHeight() {
  const player = $("#player");
  if (npIsOpen()) return;                // the sheet's full height is not the bar's
  const h = player.hidden ? 0 : player.offsetHeight;
  document.documentElement.style.setProperty("--player-h", h + "px");
}

function markPlayingRow() {
  $$(".ep.playing").forEach((r) => {
    r.classList.remove("playing");
    setRowButton(r.querySelector(".ep-play"), BY_ID[r.dataset.id]);
  });
  if (!cur) return;
  const row = document.querySelector('.ep[data-id="' + cssEscape(cur.ep.id) + '"]');
  if (row) {
    row.classList.add("playing");
    setRowButton(row.querySelector(".ep-play"), cur.ep);
  }
}
/* Space on a button reached with Tab should press it. After a mouse click the
   button keeps focus but not :focus-visible, so Space still plays/pauses. */
function keyboardFocusedButton(el) {
  const btn = el.closest && el.closest("button, a[href], [role='button']");
  if (!btn) return false;
  try { return btn.matches(":focus-visible"); } catch (e) { return true; }
}

function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
}

/* ============================================================ now playing

   On phones and tablets the player expands into a full-screen sheet. It is
   the same element with the same controls, laid out larger (.player.expanded
   in styles.css), plus the artwork and a bar of the episode's parts. Back,
   Escape, the chevron or a swipe down closes it. */

const NP_MEDIA = window.matchMedia("(max-width: 860px)");
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");
let npDrag = null;

function npIsOpen() {
  return $("#player").classList.contains("expanded");
}

function openNowPlaying() {
  const player = $("#player");
  if (!cur || player.hidden || !NP_MEDIA.matches || npIsOpen()) return;
  player.classList.add("expanded");
  player.setAttribute("role", "dialog");
  player.setAttribute("aria-modal", "true");
  player.setAttribute("aria-label", t("np.title"));
  setBehindSheet(true);
  /* An entry of its own, so the phone's back button closes the sheet
     instead of leaving the app. */
  history.pushState({ np: 1 }, "");
  updateTimes();
  renderOfflineChip();
  $("#btn-np-close").focus({ preventScroll: true });
}

function closeNowPlaying(fromHistory) {
  const player = $("#player");
  if (!npIsOpen() || player.classList.contains("closing")) return;
  if (!fromHistory && history.state && history.state.np) {
    history.back();                      // popstate comes back here
    return;
  }
  player.classList.add("closing");
  if (REDUCED_MOTION.matches) { collapseNowPlaying(); return; }
  const done = (e) => {
    if (e && e.target !== player) return;
    player.removeEventListener("animationend", done);
    collapseNowPlaying();
  };
  player.addEventListener("animationend", done);
  setTimeout(done, 400);                 // in case the animation never runs
}

function collapseNowPlaying() {
  const player = $("#player");
  if (!player.classList.contains("closing")) return;
  const hadFocus = player.contains(document.activeElement);
  player.classList.remove("expanded", "closing", "snap");
  player.style.transform = "";
  player.removeAttribute("role");
  player.removeAttribute("aria-modal");
  player.removeAttribute("aria-label");
  setBehindSheet(false);
  renderOfflineChip();
  syncPlayerHeight();    // the bar may have changed size while covered
  if (hadFocus) $("#btn-np-open").focus({ preventScroll: true });
}

/* Everything the sheet covers: out of the tab order and the accessibility
   tree, and the status bar tinted to match the sheet's top. */
function setBehindSheet(open) {
  document.body.classList.toggle("np-open", open);
  $$("body > header, body > main").forEach((el) => { el.inert = open; });
  $("#btn-np-open").setAttribute("aria-expanded", String(open));
  const top = getComputedStyle(document.documentElement).getPropertyValue("--np-top").trim();
  $$('meta[name="theme-color"]').forEach((m) => {
    if (!m.dataset.base) m.dataset.base = m.content;
    m.content = open && top ? top : m.dataset.base;
  });
}

function wireNowPlaying() {
  const player = $("#player");
  /* A reload keeps the history entry but not the sheet. */
  if (history.state && history.state.np) history.replaceState(null, "");

  $("#btn-np-open").addEventListener("click", (e) => {
    e.stopPropagation();
    openNowPlaying();
  });
  $("#btn-np-close").addEventListener("click", () => closeNowPlaying());
  player.querySelector(".p-meta").addEventListener("click", () => openNowPlaying());
  window.addEventListener("popstate", () => { if (npIsOpen()) closeNowPlaying(true); });
  const onWidth = () => { if (!NP_MEDIA.matches) closeNowPlaying(); };
  if (NP_MEDIA.addEventListener) NP_MEDIA.addEventListener("change", onWidth);
  else if (NP_MEDIA.addListener) NP_MEDIA.addListener(onWidth);

  /* Swipe up on the bar's title opens the sheet; swipe down on the sheet's
     header or artwork closes it. Gestures that start on a control are left to
     the control. */
  player.addEventListener("pointerdown", (e) => {
    if (!NP_MEDIA.matches || e.button > 0) return;
    if (!e.target.closest(".np-head, .p-meta")) return;
    if (e.target.closest("button, input, select, label")) return;
    npDrag = { id: e.pointerId, y: e.clientY, t: e.timeStamp, dy: 0, open: npIsOpen() };
  });
  player.addEventListener("pointermove", (e) => {
    if (!npDrag || e.pointerId !== npDrag.id) return;
    const dy = e.clientY - npDrag.y;
    if (!npDrag.open) {
      if (dy < -24) { npDrag = null; openNowPlaying(); }
      return;
    }
    npDrag.dy = Math.max(0, dy);
    player.style.transform = npDrag.dy ? "translateY(" + npDrag.dy + "px)" : "";
  });
  const end = (e) => {
    if (!npDrag || e.pointerId !== npDrag.id) return;
    const d = npDrag;
    npDrag = null;
    if (!d.open || !npIsOpen() || !d.dy) return;
    const speed = d.dy / Math.max(1, e.timeStamp - d.t);      // px per ms
    if (d.dy > 110 || (d.dy > 40 && speed > 0.6)) {
      closeNowPlaying();
    } else {
      player.classList.add("snap");                           // spring back
      player.style.transform = "";
      setTimeout(() => player.classList.remove("snap"), 250);
    }
  };
  player.addEventListener("pointerup", end);
  player.addEventListener("pointercancel", end);
}

/* ============================================================ offline cache

   Keeps the episode you are listening to on the device, so playback survives a
   tunnel or a dead spot. The service worker serves these back with byte-range
   support; see sw.js. */

const AUDIO_CACHE = "cs-audio-v1";
const MAX_CACHED_EPISODES = 3;          // ~3 x 50 MB

/* Saving is paced at this multiple of the audio's own bitrate rather than
   pulling ~50 MB per episode as fast as the link allows. The server sits on a
   ~5 Mbps home uplink: 15 listeners x 4 x 64 kbps is ~3.8 Mbps, so everyone's
   live stream and seeks stay responsive. 4x still finishes a whole episode
   while its first part plays. Set to 0 to download at full speed. */
const PREFETCH_SPEEDUP = 4;

let prefetchCtl = null;
let prefetchedFor = null;
let offlineUI = { state: "idle", pct: 0 };

/* CacheStorage only exists in a secure context (https, or localhost). */
function cacheSupported() {
  return "caches" in window && window.isSecureContext;
}

function pathOf(url) {
  try { return new URL(url, location.origin).pathname; } catch (e) { return url; }
}

function setOffline(state, pct) {
  offlineUI = { state: state, pct: pct || 0 };
  renderOfflineChip();
}

function renderOfflineChip() {
  const chip = $("#btn-offline");
  if (!chip) return;
  const label = $("#offline-label");

  if (!cacheSupported()) { chip.hidden = true; return; }
  chip.hidden = !cur;
  chip.dataset.state = offlineUI.state;
  chip.setAttribute("aria-pressed", String(store.ui.offlineCache));

  let full;
  if (!store.ui.offlineCache)            full = t("offline.off");
  else if (offlineUI.state === "saving") full = t("offline.saving", { pct: offlineUI.pct });
  else if (offlineUI.state === "ready")  full = t("offline.ready");
  else if (offlineUI.state === "error")  full = t("offline.error");
  else                                   full = t("offline.idle");

  /* The Greek wording is long; on a phone the icon carries the meaning and the
     full text lives in the tooltip / accessible name. */
  const compact = window.matchMedia("(max-width: 700px)").matches && !npIsOpen();
  if (!compact) {
    label.textContent = full;
  } else if (store.ui.offlineCache && offlineUI.state === "saving") {
    label.textContent = offlineUI.pct + "%";
  } else if (offlineUI.state === "error") {
    label.textContent = "!";
  } else {
    label.textContent = "";
  }
  chip.setAttribute("aria-label", full + " — " + t("offline.hint"));
  chip.title = full + " — " + t("offline.hint");
}

function schedulePrefetch() {
  if (!cur) return;
  if (prefetchedFor === cur.ep.id) { renderOfflineChip(); return; }
  prefetchedFor = cur.ep.id;
  prefetchEpisode(cur.ep, cur.part).catch(() => {});
}

/* Bytes per second to save a part at; 0 = unthrottled. */
function partRate(part) {
  if (!PREFETCH_SPEEDUP || !part.dur || !part.bytes) return 0;
  return (part.bytes / part.dur) * PREFETCH_SPEEDUP;
}

/* Resolves after `ms`, or straight away once `signal` aborts. */
function delay(ms, signal) {
  return new Promise((resolve) => {
    const id = setTimeout(resolve, ms);
    if (signal) signal.addEventListener("abort", () => { clearTimeout(id); resolve(); },
      { once: true });
  });
}

/* Download one part into the cache, reporting 0..1 progress, at no more than
   `rate` bytes/s. Not reading the body is what slows the transfer: TCP flow
   control pushes the back-pressure all the way to the server. */
async function cachePart(cache, part, signal, onProgress, rate) {
  const url = part.url;
  const res = await fetch(url, { signal: signal });
  if (!res.ok) throw new Error("HTTP " + res.status);

  const total = parseInt(res.headers.get("Content-Length") || "0", 10) || part.bytes || 0;
  if (!res.body || (!onProgress && !rate)) {
    await cache.put(url, res);
    return;
  }
  const reader = res.body.getReader();
  const chunks = [];
  const started = performance.now();
  let got = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    chunks.push(step.value);
    got += step.value.length;
    if (onProgress && total) onProgress(Math.min(1, got / total));
    if (rate) {
      const ahead = (got / rate) * 1000 - (performance.now() - started);
      if (ahead > 50) await delay(ahead, signal);
    }
  }
  const blob = new Blob(chunks, { type: "audio/mpeg" });
  await cache.put(url, new Response(blob, {
    status: 200,
    headers: { "Content-Type": "audio/mpeg", "Content-Length": String(blob.size) },
  }));
}

async function prefetchEpisode(ep, fromPart) {
  if (prefetchCtl) prefetchCtl.abort();
  if (!cacheSupported() || !store.ui.offlineCache) { setOffline("idle"); return; }

  const ctl = new AbortController();
  prefetchCtl = ctl;

  /* Ask the browser not to evict this data under pressure. */
  try {
    if (navigator.storage && navigator.storage.persist) {
      const already = await navigator.storage.persisted();
      if (!already) await navigator.storage.persist();
    }
  } catch (e) { /* not fatal */ }

  const cache = await caches.open(AUDIO_CACHE);

  /* The part playing right now is already being buffered by the <audio>
     element, so fetch it last -- the parts *ahead* are what a tunnel eats. */
  const order = [];
  for (let i = fromPart + 1; i < ep.parts.length; i++) order.push(ep.parts[i]);
  for (let i = 0; i < fromPart; i++) order.push(ep.parts[i]);
  order.push(ep.parts[fromPart]);

  const total = order.length;
  let done = 0;
  setOffline("saving", 0);

  for (const part of order) {
    if (ctl.signal.aborted) return;
    const already = await cache.match(pathOf(part.url));
    if (already) {
      done++;
      setOffline("saving", Math.round((done / total) * 100));
      continue;
    }
    try {
      await cachePart(cache, part, ctl.signal, (frac) => {
        setOffline("saving", Math.round(((done + frac) / total) * 100));
      }, partRate(part));
      done++;
      setOffline("saving", Math.round((done / total) * 100));
    } catch (err) {
      if (ctl.signal.aborted || err.name === "AbortError") return;
      console.warn("offline cache failed for", part.url, err);
      setOffline("error");
      return;
    }
  }

  noteCached(ep.id);
  setOffline("ready", 100);
  renderSeasons();                                // show the "saved" mark

  /* One part of the next episode too, so autoplay does not stall either. It
     is deliberately not recorded in cachedEps: that list holds whole episodes
     only, and a one-part lookahead must not push one of those out. */
  const nx = neighbour(ep, 1);
  if (nx && !ctl.signal.aborted) {
    try {
      if (!(await cache.match(pathOf(nx.parts[0].url)))) {
        await cachePart(cache, nx.parts[0], ctl.signal, null, partRate(nx.parts[0]));
      }
    } catch (e) { /* best effort */ }
  }
  pruneAudioCache().catch(() => {});
}

/* Records a fully saved episode, most recent first. */
function noteCached(id) {
  update("cachedEps", (c) => [id].concat(c.filter((x) => x !== id))
    .slice(0, MAX_CACHED_EPISODES));
}

/* Keep only the most recent few episodes; the archive is 20 GB and the device
   is not. Also reconciles cachedEps with what is really stored, since the
   browser may evict the cache on its own. */
async function pruneAudioCache() {
  if (!cacheSupported()) return;
  const cache = await caches.open(AUDIO_CACHE);
  const keys = await cache.keys();
  const have = new Set(keys.map((req) => new URL(req.url).pathname));

  store.cachedEps = load("cachedEps");             // another tab may have saved one
  const keepIds = store.cachedEps.filter((id) => BY_ID[id] &&
    BY_ID[id].parts.every((p) => have.has(pathOf(p.url)))).slice(0, MAX_CACHED_EPISODES);

  const keep = new Set();
  const keepEp = (ep) => ep.parts.forEach((p) => keep.add(pathOf(p.url)));
  keepIds.forEach((id) => keepEp(BY_ID[id]));
  /* ...plus the episode playing now (it may still be downloading) and the
     first part of the one autoplay moves on to. */
  if (cur) {
    keepEp(cur.ep);
    const nx = neighbour(cur.ep, 1);
    if (nx) keep.add(pathOf(nx.parts[0].url));
  }
  for (const req of keys) {
    if (!keep.has(new URL(req.url).pathname)) await cache.delete(req);
  }

  const changed = keepIds.join("\n") !== store.cachedEps.join("\n");
  store.cachedEps = keepIds;
  write("cachedEps", keepIds);
  if (changed) renderSeasons();
}

async function clearAudioCache() {
  if (!cacheSupported()) return;
  if (prefetchCtl) prefetchCtl.abort();
  await caches.delete(AUDIO_CACHE);
  store.cachedEps = [];
  write("cachedEps", []);
  prefetchedFor = null;
  setOffline("idle");
  renderSeasons();
}

/* ================================================================ network */

/* The offline banner and transient messages stack in one spot above the
   player, so they never overlap each other. */
function noticeHost() {
  let host = document.getElementById("notices");
  if (!host) {
    host = document.createElement("div");
    host.id = "notices";
    host.className = "notices";
    host.setAttribute("aria-live", "polite");
    document.body.appendChild(host);
  }
  return host;
}

function renderNetBanner() {
  let el = document.getElementById("net-banner");
  if (navigator.onLine) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement("div");
    el.id = "net-banner";
    el.className = "notice";
    noticeHost().prepend(el);
  }
  el.textContent = t("net.offline");
}

let toastTimer = 0;
function showToast(msg) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "notice toast";
    noticeHost().appendChild(el);
  }
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 6000);
}

/* ================================================================ install */

let deferredPrompt = null;

function isStandalone() {
  return (window.matchMedia && (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.matchMedia("(display-mode: minimal-ui)").matches ||
      window.matchMedia("(display-mode: fullscreen)").matches)) ||
    navigator.standalone === true;
}

function isIOS() {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function hideInstallCard(remember) {
  const card = $("#install-card");
  if (card) card.hidden = true;
  if (remember) write("installDismissed", true);
}

function setupInstall() {
  const card = $("#install-card");
  if (!card) return;

  /* The note is set by key, so applyI18n re-translates it on a language switch. */
  const show = (mode, noteKey) => {
    card.hidden = false;
    $("#install-actions").hidden = mode !== "prompt";
    $("#install-ios").hidden = mode !== "ios";
    const n = $("#install-note");
    n.hidden = !noteKey;
    if (noteKey) {
      n.dataset.i18n = noteKey;
      n.textContent = t(noteKey);
    }
  };

  /* appinstalled can fire even if the card was never shown. */
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    hideInstallCard(true);
  });

  if (isStandalone() || read("installDismissed", false)) return;

  if (isIOS()) {
    /* Safari has no programmatic install prompt at all -- show the manual
       Share -> Add to Home Screen route instead. */
    show("ios");
  } else if (!window.isSecureContext) {
    show(null, "install.https");
  } else if (/Android/i.test(navigator.userAgent)) {
    /* Chrome fires beforeinstallprompt; if nothing arrives, fall back to
       telling the user where the menu item is. Every Android browser has
       one. On a desktop that has no prompt (Firefox, Safari) there is
       nothing to point to, so the card stays hidden. */
    setTimeout(() => {
      if (!deferredPrompt && card.hidden) show(null, "install.manual");
    }, 2000);
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    show("prompt");
  });

  $("#btn-install").addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    try {
      const choice = await deferredPrompt.userChoice;
      if (choice && choice.outcome === "accepted") hideInstallCard(true);
    } catch (e) { /* dialog dismissed */ }
    deferredPrompt = null;
  });

  ["#btn-install-dismiss", "#btn-install-later", "#btn-install-later-ios"]
    .forEach((sel) => {
      const b = $(sel);
      if (b) b.addEventListener("click", () => hideInstallCard(true));
    });
}

function registerSW() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  /* scope "/" reaches the audio at the archive root; serve.py sends the
     matching Service-Worker-Allowed header. */
  navigator.serviceWorker.register("sw.js", { scope: "/" })
    .catch((err) => console.warn("Service worker registration failed:", err));
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  wire();
  applyI18n();
  registerSW();

  let json;
  try {
    /* no-cache: the browser asks the server, and an unchanged index comes
       back as a 304 from its own copy instead of ~800 KB again. */
    const res = await fetch("index.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(res.status + " " + res.statusText);
    json = await res.json();
  } catch (err) {
    console.error("Could not load index.json (" + err.message + "). " +
      "If it is missing, run: python3 _site/build_index.py");
    const st = $("#status");
    st.textContent = t("app.loadError");
    st.classList.add("error");
    return;
  }

  DATA = json;
  SEASONS = json.seasons;
  FLAT = [];
  for (const s of SEASONS) {
    for (const ep of s.episodes) {
      ep._cps = Array.from(ep.title);
      ep._norm = ep._cps.map(normCP).join("");
      ep._dateNorm = normalize([ep.dateLabel, ep.dateLabelEn, ep.date].join(" "));
      ep._i = FLAT.length;
      FLAT.push(ep);
      BY_ID[ep.id] = ep;
    }
  }

  $("#status").hidden = true;
  $("#filter-unheard").setAttribute("aria-pressed", String(store.ui.unheardOnly));
  $("#filter-unheard").textContent =
    t(store.ui.unheardOnly ? "filter.unheardOn" : "filter.unheard");
  applyI18n();
  render();

  /* One at a time, so a failure in one cannot skip the rest. */
  [restoreLast, setupInstall, renderNetBanner,
   () => { pruneAudioCache().catch(() => {}); }].forEach((step) => {
    try { step(); } catch (e) { console.error(e); }
  });

  if (json.warnings && json.warnings.length) {
    console.warn("index.json warnings:", json.warnings);
  }
}

/* Put the last episode back on screen, paused and without saving anything.
   Browsers block autoplay before a user gesture, so playback starts on the
   first click rather than failing. A finished episode is not brought back. */
function restoreLast() {
  const last = store.last;
  const ep = last && BY_ID[last.id];
  if (ep && !finished(ep.id)) loadEpisode(ep, last.part, last.time, false, true);
  else document.body.classList.add("no-player");
}

document.addEventListener("DOMContentLoaded", boot);
