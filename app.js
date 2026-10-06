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
  theme: (v) => (v === "light" || v === "dark" ? v : "auto"),
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
  last: (v) => (isObj(v) && typeof v.id === "string" ? {   // {id, part, time, series?}
    id: v.id,
    part: Number.isInteger(v.part) && v.part >= 0 ? v.part : 0,
    time: isNum(v.time) && v.time >= 0 ? v.time : 0,
    series: typeof v.series === "string" ? v.series : undefined,   // playing a series through
  } : null),
  recent: strings,                     // [id, ...] most recent first
  cachedEps: strings,                  // ids held in the audio cache, MRU first
  seen: strings,                       // ids no longer shown as new
  ui: (v) => {
    const u = isObj(v) ? v : {};
    return {
      sort: u.sort === "oldest" ? "oldest" : "newest",
      unheardOnly: u.unheardOnly === true,
      open: Array.isArray(u.open) ? u.open.filter(Number.isInteger) : [],  // season numbers
      openSeries: strings(u.openSeries),                 // series rows opened in the list
      volume: isNum(u.volume) ? Math.max(0, Math.min(1, u.volume)) : 1,
      speed: SPEEDS.indexOf(u.speed) !== -1 ? u.speed : 1,
      autoplay: u.autoplay === true,   // off unless the listener turns it on
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
let SEASONS = [];          // chronological, oldest season first
const SEASON_BY_NUM = Object.create(null);   // season number -> season
let FLAT = [];             // every episode, chronological across the archive
const BY_ID = Object.create(null);

/* The series being played through, if any (see playSeries). */
let queue = null;

/* The episode before or after: within the series being played through, else
   across the whole archive, so a season's last episode continues into the
   next season instead of dead-ending. */
function neighbour(ep, delta) {
  const q = queue ? queue.eps.indexOf(ep) : -1;
  if (q !== -1 && q + delta >= 0 && q + delta < queue.eps.length) return queue.eps[q + delta];
  const i = ep._i + delta;
  return (i >= 0 && i < FLAT.length) ? FLAT[i] : null;
}
const inQueue = (ep) => !!(queue && ep && queue.eps.indexOf(ep) !== -1);

function epTotal(ep) {
  if (ep.totalDur) return ep.totalDur;
  let sum = 0;
  for (const p of ep.parts) sum += p.dur || 0;
  return sum;
}
function elapsedBefore(ep, partIdx) {
  let sum = 0;
  for (let i = 0; i < Math.min(partIdx, ep.parts.length); i++) sum += ep.parts[i].dur || 0;
  return sum;
}

const isListened = (id) => !!store.listened[id];
/* Played to the end (or marked so), and not started again since. */
const finished = (id) => isListened(id) && !store.progress[id];

function setListened(id, on) {
  update("listened", (l) => { if (on) l[id] = true; else delete l[id]; });
}

/* Where playback moves on to when an episode ends: the next one not yet
   heard. An episode that was already marked listened when it was put on is
   being heard again, so the listener is going back through old ones on
   purpose, and then it is simply the next one in order. Marking it listened
   near the end does not make it a replay (`replaying`, set in loadEpisode). */
function upNext(ep) {
  let nx = neighbour(ep, 1);
  if (cur && cur.ep === ep ? replaying : isListened(ep.id)) return nx;
  while (nx && finished(nx.id)) nx = neighbour(nx, 1);
  return nx;
}

/* New: arrived since this browser first opened the app, and not yet
   played, marked as listened or dismissed. */
let SEEN = new Set(store.seen);
const isNew = (id) => !SEEN.has(id) && !isListened(id);

function markSeen(ids) {
  update("seen", (s) => s.concat(ids.filter((id) => s.indexOf(id) === -1)));
  SEEN = new Set(store.seen);
}

/* Where an episode picks up: its saved position, else the start. */
function resumeAt(ep) {
  const p = store.progress[ep.id];
  return p && p.part < ep.parts.length ? p : { part: 0, time: 0 };
}

function seasonLabel(s) {
  return store.lang === "el" ? s.dir : t("season.label", { n: s.num });
}
/* By number: an archive may start at a later season or skip one, so the
   seasons are not always 1..N in order. */
function epSeasonLabel(ep) {
  const s = SEASON_BY_NUM[ep.season];
  return s ? seasonLabel(s) : t("season.label", { n: ep.season });
}
function epDate(ep) {
  return store.lang === "el" ? ep.dateLabel : (ep.dateLabelEn || ep.dateLabel);
}

/* ----------------------------------------------------------------- series

   Runs of episodes titled "<name> - Μέρος 1ο", "… Μέρος 2ο", … (also
   "Μέρος Α'" and "(2ο μέρος)"). Found from the titles when the index loads,
   so a new part joins its series with nothing to maintain. */

let SERIES = [];                            // oldest first
const SERIES_BY_ID = Object.create(null);   // the first episode's id -> series
const SERIES_OF = Object.create(null);      // episode id -> series

/* On the folded title (so "μεροσ": ς is folded to σ). Group 1 is the
   name, then the part's number. */
const PART_RE = new RegExp("^(.*?)[\\s'\"«»\\-–—:,.]*(?:" +
  "μεροσ\\s*(\\d+)\\s*ο?(?![α-ω])" +       // Μέρος 2ο, Μέρος 2 ο
  "|μεροσ\\s*([α-θ])['΄’](?![α-ω])" +       // Μέρος Β'
  "|\\((\\d+)\\s*ο\\s*μεροσ\\))");      // (2ο μέρος)
const GREEK_ORD = "αβγδεζηθ";
const DAY = 86400000;

/* What two titles of one series have in common: the name, without quotes
   and punctuation. */
const seriesKey = (norm) =>
  norm.replace(/['"«»‘’“”΄]/g, "").replace(/[\s\-–—:,.;]+/g, " ").trim();

function findSeries() {
  const runs = [];
  for (const ep of FLAT) {
    const m = PART_RE.exec(ep._norm);
    if (!m) continue;
    const key = seriesKey(m[1]);
    if (key.length < 6) continue;
    const n = m[2] ? +m[2] : m[3] ? GREEK_ORD.indexOf(m[3]) + 1 : +m[4];
    const at = Date.parse(ep.date) || 0;
    const name = ep._cps.slice(0, m[1].length).join("")
      .replace(/^['"«‘“\s]+|['"»’”\s\-–—:,]+$/g, "");

    /* The same name (or one that starts the other: "… - Μέθοδοι εναλλακτικής
       ιατρικής Μέρος 2ο" then "… - Μέρος 3ο"), a higher number and not years
       apart. A new "Μέρος 1ο" starts a new series, so a topic revisited years
       later ("Κατακλυσμός", 2013 and 2020) stays two. */
    let run = null;
    for (let i = runs.length - 1; i >= 0 && !run; i--) {
      const r = runs[i];
      if ((r.key.startsWith(key) || key.startsWith(r.key)) &&
          n > r.lastN && at - r.lastAt < 400 * DAY) run = r;
    }
    if (!run) {
      run = { key: key, name: name, eps: [], lastN: 0, lastAt: 0 };
      runs.push(run);
      /* A series whose first part has no number of its own ("Η επίδραση
         των smartphones στην ψυχοσωματική υγεία", then "… Μέρος 2ο"): the
         episode just before, if it has the same name and is weeks away. */
      const prev = FLAT[ep._i - 1];
      if (n === 2 && prev && seriesKey(prev._norm).startsWith(key) &&
          at - (Date.parse(prev.date) || 0) < 60 * DAY) run.eps.push(prev);
    } else if (key.length < run.key.length) {
      run.key = key;                               // the shorter, common name
      run.name = name;
    }
    run.eps.push(ep);
    run.lastN = n;
    run.lastAt = at;
  }

  SERIES = runs.filter((r) => r.eps.length > 1).map((r) => {
    const years = r.eps.map((e) => parseInt(e.date, 10)).filter(isFinite);
    return {
      id: r.eps[0].id, name: r.name, eps: r.eps,
      yearStart: Math.min.apply(null, years), yearEnd: Math.max.apply(null, years),
    };
  });
  for (const s of SERIES) {
    SERIES_BY_ID[s.id] = s;
    for (const ep of s.eps) SERIES_OF[ep.id] = s;
  }
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
  renderAutoplay();
  renderTheme();
  renderOfflineChip();
  renderNetBanner();
  labelSleepOptions();
  renderSleep();
  updateExpandLabel();
  updatePlayerText();
}

/* ------------------------------------------------------------------ state */

/* query: the normalised search text; terms: its words, each with the
   patterns that find it. Every word must match the title or the date, in
   any order, so "εξελιξη 2009" works. */
const view = { query: "", terms: [], debounce: 0 };

/* Greeklish: a word typed in Latin letters is also looked for as Greek, so
   "exelixi", "ekseliksi" and "εξελιξη" all find Εξέλιξη. Each Latin letter
   (or pair) stands for the Greek it is usually typed for; pairs also stay
   open to being two letters, so "ks" finds κσ as well as ξ. Matched against
   the folded title: lowercase, no accents, ς as σ. */
const GREEKLISH = {
  th: "θ", ps: "ψ", ks: "ξ", ch: "χ", kh: "χ", gh: "γ", dh: "δ", ph: "φ",
  ou: "ου", ai: "αι|ε", ei: "ει|ι", oi: "οι|ι", mp: "μπ", nt: "ντ", gk: "γκ",
  gg: "γγ", ng: "γγ|γκ", av: "αυ", ev: "ευ", af: "αυ", ef: "ευ",
  a: "α", b: "β|μπ", c: "κ|σ", d: "δ|ντ", e: "ε|η|αι", f: "φ", g: "γ",
  h: "η|χ", i: "ι|η|υ|ει|οι", j: "ζ|τζ", k: "κ", l: "λ", m: "μ", n: "ν",
  o: "ο|ω", p: "π", q: "κ", r: "ρ", s: "σ", t: "τ", u: "υ|ου", v: "β|υ",
  w: "ω|ου", x: "ξ|χ", y: "υ|ι|η", z: "ζ",
  8: "8|θ", 3: "3|ξ",                            // "8eos"; still a digit in "3o"
};
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function greeklish(word) {
  if (!/[a-z]/.test(word)) return null;          // Greek or digits: as typed
  let src = "";
  for (let i = 0; i < word.length;) {
    const two = word.substr(i, 2);
    const one = word.charAt(i);
    if (two.length === 2 && GREEKLISH[two]) {
      const split = GREEKLISH[two.charAt(0)] && GREEKLISH[two.charAt(1)]
        ? "|(?:" + GREEKLISH[two.charAt(0)] + ")(?:" + GREEKLISH[two.charAt(1)] + ")" : "";
      src += "(?:" + GREEKLISH[two] + split + ")";
      i += 2;
    } else {
      src += GREEKLISH[one] && /[a-z38]/.test(one) ? "(?:" + GREEKLISH[one] + ")" : reEscape(one);
      i += 1;
    }
  }
  return new RegExp(src, "g");
}

function setQuery(raw) {
  view.query = normalize(raw.trim());
  view.terms = view.query.split(/\s+/).filter(Boolean)
    .map((w) => ({ word: w, re: greeklish(w) }));
}

function termIn(term, norm) {
  if (norm.indexOf(term.word) !== -1) return true;
  if (!term.re) return false;
  term.re.lastIndex = 0;
  return term.re.test(norm);
}

function matches(ep) {
  if (store.ui.unheardOnly && isListened(ep.id)) return false;
  for (const term of view.terms) {
    if (!termIn(term, ep._norm) && !termIn(term, ep._dateNorm)) return false;
  }
  return true;
}

/* ---------------------------------------------------------------- render */

/* Text with every occurrence of every search word wrapped in <mark>. `norm`
   is normalize(text): same length in code points, so indices line up. */
function highlight(text, norm) {
  const frag = document.createDocumentFragment();
  const hits = [];
  for (const term of view.terms) {
    const w = term.word;
    for (let i = norm.indexOf(w); i !== -1; i = norm.indexOf(w, i + 1)) {
      hits.push([i, i + w.length]);
    }
    if (term.re) {
      term.re.lastIndex = 0;
      for (let m; (m = term.re.exec(norm));) hits.push([m.index, m.index + m[0].length]);
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

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ep-play";
  setRowButton(btn, ep);
  const start = () => {
    if (cur && cur.ep === ep) { togglePlay(); return; }
    const p = resumeAt(ep);
    loadEpisode(ep, p.part, p.time, true);
  };
  btn.addEventListener("click", start);

  /* Most of the row is the title: tapping it plays, as in any podcast app.
     The play button stays the control for keyboards and screen readers. */
  const main = document.createElement("div");
  main.className = "ep-main";
  main.addEventListener("click", start);

  const title = document.createElement("span");
  title.className = "ep-title";
  title.title = ep.title;
  if (isNew(ep.id)) {
    const badge = document.createElement("span");
    badge.className = "new-badge";
    badge.textContent = t("new.badge");
    title.appendChild(badge);
  }
  title.appendChild(highlight(ep.title, ep._norm));
  main.appendChild(title);

  const sub = document.createElement("div");
  sub.className = "ep-sub";
  const dl = epDate(ep);
  if (dl) {                      // a folder whose date could not be read has none
    const date = document.createElement("span");
    date.className = "ep-date";
    date.appendChild(highlight(dl, normalize(dl)));
    sub.appendChild(date);
    sub.insertAdjacentHTML("beforeend", '<span class="dot">·</span>');
  }
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

  row.appendChild(btn);
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
  const row = el.closest(".ep[data-id]");
  const box = !row && el.closest(".ep-series");
  const sec = el.closest(".season");
  const cls = ["ep-play", "ep-check", "series-toggle"].filter((c) => el.classList.contains(c))[0];
  return { id: row && row.dataset.id, series: box && box.dataset.series, cls: cls,
           group: sec && sec.dataset.key };
}
function refocus(f) {
  if (!f) return;
  const sec = f.group && document.querySelector('.season[data-key="' + cssEscape(f.group) + '"]');
  const row = f.id && f.cls && sec &&
    sec.querySelector('.ep[data-id="' + cssEscape(f.id) + '"]');
  const head = f.series && f.cls && sec &&
    sec.querySelector('.ep-series[data-series="' + cssEscape(f.series) + '"] > .series-head');
  const el = (row && row.querySelector("." + f.cls)) ||
    (head && head.querySelector("." + f.cls)) ||
    (sec && sec.querySelector(".season-head"));
  if (el) el.focus({ preventScroll: true });
}

/* The seasons, each keeping its open/closed state in store.ui.open. */
function listGroups() {
  return SEASONS.map((s) => ({
    key: "s:" + s.num, id: s.num, openList: store.ui.open,
    label: seasonLabel(s), yearStart: s.yearStart, yearEnd: s.yearEnd, episodes: s.episodes,
  }));
}

/* A season's episodes in display order. Outside a search, two or more parts
   of one series in the season become a single series row, where the first
   of them shown would be; one part on its own stays an ordinary row. `all`
   is the whole season: with "unheard only" on, a series row still counts
   and lists all of its parts, and the filter only decides whether it shows. */
function appendRows(host, eps, flat, all) {
  const shown = Object.create(null);         // series id -> its episodes here
  if (!flat) {
    for (const ep of all || eps) {
      const sr = SERIES_OF[ep.id];
      if (sr) (shown[sr.id] = shown[sr.id] || []).push(ep);
    }
  }
  const done = Object.create(null);
  for (const ep of eps) {
    const sr = SERIES_OF[ep.id];
    const here = sr && shown[sr.id];
    if (here && here.length > 1) {
      if (!done[sr.id]) {
        done[sr.id] = true;
        host.appendChild(seriesRow(sr, sr.eps.filter((e) => here.indexOf(e) !== -1)));
      }
      continue;
    }
    host.appendChild(episodeRow(ep));
  }
}

/* "19 Μαρτίου – 2 Απριλίου 2026": the year once when both share it. */
function dateRange(eps) {
  const a = epDate(eps[0]), b = epDate(eps[eps.length - 1]);
  if (a === b) return a;
  return (a.slice(-4) === b.slice(-4) ? a.slice(0, -5) : a) + " – " + b;
}

/* The series row's button plays the series through in order, from the
   first part not yet heard (playSeries); while one of its parts is playing
   it pauses, like an episode's. */
function setSeriesButton(btn, series) {
  const mine = !!(cur && series.eps.indexOf(cur.ep) !== -1);
  const playing = mine && isPlaying();
  btn.toggleAttribute("data-loading", playing && loading);
  btn.innerHTML = playing ? SVG_PAUSE : SVG_PLAY;
  const done = series.eps.every((e) => finished(e.id));
  const fresh = series.eps.every((e) => !isListened(e.id) && !store.progress[e.id]);
  const lbl = t(playing ? "player.pause"
    : done ? "series.again" : fresh ? "series.play" : "series.continue");
  btn.title = lbl;
  btn.setAttribute("aria-label", lbl + ": " + series.name);
}

/* One row for the parts of a series in a season. Opening it lists them,
   Μέρος 1ο first, whatever the list's sort order: the order to hear them in. */
function seriesRow(series, eps) {
  const open = store.ui.openSeries.indexOf(series.id) !== -1;
  const box = document.createElement("div");
  box.className = "ep-series";
  box.dataset.series = series.id;
  box.dataset.open = String(open);

  const head = document.createElement("div");
  head.className = "ep series-head";
  const heard = eps.filter((e) => isListened(e.id)).length;
  if (heard === eps.length) head.classList.add("listened");
  if (cur && eps.indexOf(cur.ep) !== -1) head.classList.add("playing");

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ep-play series-play";
  setSeriesButton(btn, series);
  btn.addEventListener("click", () => {
    if (cur && series.eps.indexOf(cur.ep) !== -1) {
      if (isPlaying()) { audio.pause(); return; }
      queue = series;                              // carry on through the series
      play();
      return;
    }
    playSeries(series);
  });

  const main = document.createElement("button");
  main.type = "button";
  main.className = "ep-main series-toggle";
  main.setAttribute("aria-expanded", String(open));
  const text = document.createElement("span");
  text.className = "series-text";
  const title = document.createElement("span");
  title.className = "ep-title";
  title.title = series.name;
  if (eps.some((e) => isNew(e.id))) {
    const badge = document.createElement("span");
    badge.className = "new-badge";
    badge.textContent = t("new.badge");
    title.appendChild(badge);
  }
  title.appendChild(document.createTextNode(series.name));
  text.appendChild(title);

  const sub = document.createElement("span");
  sub.className = "ep-sub";
  // The dates go last: on phones they take a line of their own.
  const bits = [t("series.label"), t("series.count", { n: eps.length })];
  if (heard > 0 && heard < eps.length) bits.push(t("series.heard", { n: heard, total: eps.length }));
  bits.push(dateRange(eps));
  bits.forEach((b, i) => {
    if (i) sub.insertAdjacentHTML("beforeend", '<span class="dot">·</span>');
    const sp = document.createElement("span");
    if (i === 0) sp.className = "series-tag";
    else if (i === bits.length - 1) sp.className = "ep-date";
    sp.textContent = b;
    sub.appendChild(sp);
  });
  text.appendChild(sub);
  main.appendChild(text);
  main.insertAdjacentHTML("beforeend", SVG_CARET);
  main.addEventListener("click", () => {
    const i = store.ui.openSeries.indexOf(series.id);
    if (i === -1) store.ui.openSeries.push(series.id); else store.ui.openSeries.splice(i, 1);
    saveUI();
    renderSeasons();
  });

  head.appendChild(btn);
  head.appendChild(main);
  box.appendChild(head);

  if (open) {
    const body = document.createElement("div");
    body.className = "series-body";
    for (const ep of eps) body.appendChild(episodeRow(ep));
    box.appendChild(body);
  }
  return box;
}

function renderSeasons() {
  const host = $("#seasons");
  const focus = focusedInList();
  host.textContent = "";
  const searching = !!view.query;
  document.body.classList.toggle("searching", searching);
  let shown = 0;

  // Seasons follow the same newest/oldest toggle as the episodes inside them.
  const all = listGroups();
  const groups = store.ui.sort === "newest" ? all.reverse() : all;

  for (const g of groups) {
    const eps = g.episodes.filter(matches);
    shown += eps.length;
    if ((searching || store.ui.unheardOnly) && eps.length === 0) continue;

    const open = searching ? true : g.openList.indexOf(g.id) !== -1;

    const sec = document.createElement("section");
    sec.className = "season";
    sec.dataset.open = String(open);
    sec.dataset.key = g.key;

    const head = document.createElement("button");
    head.type = "button";
    head.className = "season-head";
    head.setAttribute("aria-expanded", String(open));
    head.innerHTML = SVG_CARET;

    const name = document.createElement("span");
    name.className = "season-name";
    name.textContent = g.label;
    if (g.yearStart) {
      const yr = document.createElement("span");
      yr.className = "season-years";
      yr.textContent = "  " + (g.yearStart === g.yearEnd
        ? g.yearStart : g.yearStart + "–" + g.yearEnd);
      name.appendChild(yr);
    }
    head.appendChild(name);

    const meta = document.createElement("span");
    meta.className = "season-meta";
    const unheard = g.episodes.filter((e) => !isListened(e.id)).length;
    const fresh = g.episodes.filter((e) => isNew(e.id)).length;
    if (fresh > 0) {
      const pill = document.createElement("span");
      pill.className = "new-pill";
      pill.textContent = t("season.new", { n: fresh });
      meta.appendChild(pill);
    }
    if (unheard === 0) {
      meta.appendChild(document.createTextNode(t("season.allListened")));
    } else {
      const count = document.createElement("span");
      count.className = "season-count";               // hidden on phones
      count.textContent = t("season.episodes", { n: g.episodes.length }) + " ";
      meta.appendChild(count);
      if (fresh < unheard) {
        const pill = document.createElement("span");
        pill.className = "unheard-pill";
        pill.textContent = t("season.unheard", { n: unheard });
        meta.appendChild(pill);
      }
    }
    head.appendChild(meta);

    /* Read out as one phrase, not "Εκπομπών 20262 εκπομπές": the parts sit
       side by side on screen with nothing between them. */
    head.setAttribute("aria-label", [g.label,
      g.yearStart && (g.yearStart === g.yearEnd ? g.yearStart : g.yearStart + "–" + g.yearEnd),
      fresh > 0 && t("season.new", { n: fresh }),
      unheard === 0 ? t("season.allListened") : t("season.episodes", { n: g.episodes.length }),
      unheard > 0 && fresh < unheard && t("season.unheard", { n: unheard }),
    ].filter(Boolean).join(", "));

    const heard = g.episodes.length - unheard;
    if (heard > 0) {
      const bar = document.createElement("span");
      bar.className = "season-bar";
      bar.setAttribute("role", "img");
      bar.setAttribute("aria-label",
        t("season.progress", { done: heard, total: g.episodes.length }));
      bar.innerHTML = '<i style="width:' +
        ((heard / g.episodes.length) * 100).toFixed(1) + '%"></i>';
      head.appendChild(bar);
    }

    head.addEventListener("click", () => {
      if (view.query) return;                      // stays open while searching
      const i = g.openList.indexOf(g.id);
      if (i === -1) g.openList.push(g.id); else g.openList.splice(i, 1);
      saveUI();
      render();
    });
    /* A heading, so screen readers can jump from group to group. */
    const h = document.createElement("h2");
    h.className = "season-title";
    h.appendChild(head);
    sec.appendChild(h);

    if (open) {
      const body = document.createElement("div");
      body.className = "season-body";
      appendRows(body, store.ui.sort === "newest" ? eps.slice().reverse() : eps, searching,
        g.episodes);
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
  sub.textContent = epSeasonLabel(ep) + " · " +
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

/* Episodes added since the last visit, newest first. Playing one, marking
   it listened or Dismiss takes it off; the rest of the list keeps its
   badges until then. */
const NEW_SHOWN = 5;
function renderNew() {
  const sec = $("#new-section");
  const eps = FLAT.filter((e) => isNew(e.id)).reverse();
  if (eps.length === 0) { sec.hidden = true; return; }
  sec.hidden = false;

  const list = $("#new-list");
  list.textContent = "";
  eps.slice(0, NEW_SHOWN).forEach((ep) => {
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
  if (eps.length > NEW_SHOWN) {
    const li = document.createElement("li");
    li.className = "new-more";
    li.textContent = t("new.more", { n: eps.length - NEW_SHOWN });
    list.appendChild(li);
  }
}

/* Where a series picks up: the first episode not finished, else (all heard)
   the first one again. */
function seriesStart(series) {
  return series.eps.filter((e) => !finished(e.id))[0] || series.eps[0];
}

function playSeries(series) {
  const ep = seriesStart(series);
  queue = series;
  if (cur && cur.ep === ep) {
    if (!isPlaying()) play();
    return;
  }
  const p = resumeAt(ep);
  loadEpisode(ep, p.part, p.time, true);
}

function render() {
  renderContinue();
  renderNew();
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
let replaying = false;     // the current episode was already heard when put on
let notedPlaying = null;   // the episode last counted as played (see "playing")

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
  if (!inQueue(ep)) queue = null;                  // left the series
  if (!cur || cur.ep !== ep) {
    replaying = isListened(ep.id);
    notedPlaying = null;
  }
  part = Math.max(0, Math.min(part | 0, ep.parts.length - 1));
  cur = { ep: ep, part: part };
  pendingSeek = time || 0;
  lastGood = pendingSeek;
  retryOnline = false;
  setLoading(false);

  /* A part put back paused (the last episode on opening the app, a shared
     link) loads nothing until Play: on a small home uplink, a megabyte of
     audio per app open adds up. Its length comes from the index meanwhile,
     and a seek before Play waits in pendingSeek. Setting src starts the
     load; Chrome's load() would fetch the metadata even with "none". */
  audio.preload = autoplay ? "metadata" : "none";
  audio.src = ep.parts[part].url;
  audio.playbackRate = store.ui.speed;
  audio.volume = store.ui.volume;
  if (autoplay) audio.load();

  $("#player").hidden = false;
  document.body.classList.remove("no-player");

  handedOff = false;
  dirty = !quiet;
  if (!quiet) persistPosition(true);   // "recent" waits until it actually plays

  renderOfflineChip();

  if (autoplay) {
    const p = audio.play();
    if (p && p.catch) p.catch(() => {});
  }
  updatePlayerText();
  updateTimes();             // the new part's length and start, before its metadata
  updateMediaSession();
  render();
}

function noteRecent(id) {
  if (store.recent[0] === id) return;
  update("recent", (r) => [id].concat(r.filter((x) => x !== id)).slice(0, 20));
}

/* Where playback is in the part. Until a loaded part's metadata arrives,
   that is where it will start (pendingSeek), not the element's 0; after a
   load error, where it stopped. */
function posInPart() {
  return audio.error ? lastGood : pendingSeek > 0 ? pendingSeek : (audio.currentTime || 0);
}

/* The part's length: the index's figure until the element knows it. */
function partDur() {
  if (isFinite(audio.duration) && audio.duration > 0) return audio.duration;
  return cur ? cur.ep.parts[cur.part].dur || 0 : 0;
}

/* A seek by the listener: the seek bar, the skip buttons, the lock screen.
   While a part is still loading, the loadedmetadata handler applies
   pendingSeek, which would undo a currentTime set now, so the target
   replaces pendingSeek instead. */
function seekTo(time) {
  if (!cur) return;
  const dur = partDur();
  time = Math.max(0, dur ? Math.min(dur, time) : time);
  if (audio.error) lastGood = time;                // play() reloads from here
  else if (audio.readyState === 0 || pendingSeek > 0) pendingSeek = lastGood = time;
  else audio.currentTime = time;
  takeOver();
  persistPosition(true);
  updateTimes();
}

function skip(delta) {
  if (cur) seekTo(posInPart() + delta);
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
  /* An episode that ended where it is (see onEnded) plays again from its
     first part, not from the start of its last one. */
  if (audio.ended && cur.part === cur.ep.parts.length - 1) {
    replaying = true;
    notedPlaying = null;
    loadEpisode(cur.ep, 0, 0, true);
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
  queue = queueOf(last, ep);
  loadEpisode(ep, last.part, last.time, autoplay, !autoplay);
  return true;
}

/* The series a saved position was playing through, if it still holds it. */
function queueOf(last, ep) {
  const s = last && last.series && SERIES_BY_ID[last.series];
  return s && s.eps.indexOf(ep) !== -1 ? s : null;
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
  const nx = upNext(ep);                          // before it is marked listened
  setListened(ep.id, true);                       // all parts played through
  update("progress", (p) => { delete p[ep.id]; });
  /* Only autoplay, or a series being played through, moves on to the next
     episode; a series stops at its own end, with autoplay on or off. A
     sleep timer set to "end of episode" still moves on, paused. */
  if (nx && (inQueue(ep) ? inQueue(nx) : store.ui.autoplay)) {
    const p = resumeAt(nx);                        // it may have been started before
    loadEpisode(nx, p.part, p.time, !stop);
    return;
  }
  /* Autoplay is off, the series is over, or this was the newest episode:
     playback stops on this one. There is nothing to continue, so the
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
  const time = posInPart();
  const id = cur.ep.id, part = cur.part;
  /* Merely put in place (autoplay off) is not a start: no "part 1/4" mark
     on an episode nobody has played yet. */
  if (part > 0 || time > 0 || store.progress[id]) {
    update("progress", (p) => { p[id] = { part: part, time: time, updated: now }; });
  }
  store.last = { id: id, part: part, time: time, series: queue ? queue.id : undefined };
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
  [["season", epSeasonLabel(ep)],
   ["part", t("ep.part", { n: cur.part + 1, total: ep.parts.length })],
   ["date", epDate(ep)]].forEach((x) => {
    if (!x[1]) return;
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
  const dur = partDur();
  const t0 = posInPart();
  const seek = $("#seek");
  // While the knob is held, the label shows where letting go will land.
  const shown = scrubbing ? parseFloat(seek.value) : t0;
  $("#t-cur").textContent = fmtTime(shown);
  $("#t-dur").textContent = fmtTime(dur);
  seek.max = dur || 1;
  if (!scrubbing) seek.value = t0;
  setFill(seek);
  seek.setAttribute("aria-valuetext",
    t("player.seekValue", { cur: fmtTime(shown), dur: fmtTime(dur) }));

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
      album: epSeasonLabel(cur.ep),
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

function allGroupsOpen() {
  const groups = listGroups();
  return groups.length > 0 && groups.every((g) => g.openList.indexOf(g.id) !== -1);
}

function updateExpandLabel() {
  $("#expand-toggle").textContent = t(allGroupsOpen() ? "nav.collapseAll" : "nav.expandAll");
}

function wire() {
  /* language */
  $$(".lang-btn").forEach((b) => b.addEventListener("click", () => {
    store.lang = b.dataset.lang;
    write("lang", store.lang);
    applyI18n();
    render();
  }));

  /* On a narrow phone the toolbar's chips scroll sideways with no scrollbar:
     fade the side that has more, so it shows there is more. */
  const bar = $(".toolbar-btns");
  const fade = () => {
    const more = bar.scrollWidth - bar.clientWidth;
    const start = bar.scrollLeft > 1, end = bar.scrollLeft < more - 1;
    if (start || end) bar.dataset.fade = start && end ? "both" : start ? "start" : "end";
    else delete bar.dataset.fade;
  };
  bar.addEventListener("scroll", fade, { passive: true });
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(fade);        // the bar, and labels that change
    [bar].concat(Array.from(bar.children)).forEach((el) => ro.observe(el));
  } else {
    window.addEventListener("resize", fade);
  }
  fade();

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
    store.ui.open = allGroupsOpen() ? [] : listGroups().map((g) => g.id);
    saveUI();
    updateExpandLabel();
    render();
  });
  $("#btn-new-dismiss").addEventListener("click", () => {
    markSeen(FLAT.filter((ep) => isNew(ep.id)).map((ep) => ep.id));
    render();
    const h = $("#seasons .season-head");                 // the panel is gone
    if (h) h.focus({ preventScroll: true });
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
  $("#btn-autoplay").addEventListener("click", () => {
    store.ui.autoplay = !store.ui.autoplay;
    saveUI();
    renderAutoplay();
  });
  $("#btn-share").addEventListener("click", shareLink);

  /* header */
  $("#btn-theme").addEventListener("click", () => {
    const order = ["auto", "light", "dark"];
    store.theme = order[(order.indexOf(store.theme) + 1) % order.length];
    write("theme", store.theme);
    applyTheme();
  });
  const keys = $("#keys-dialog");
  $("#btn-keys").addEventListener("click", openKeys);
  $("#btn-keys-close").addEventListener("click", () => keys.close());
  keys.addEventListener("click", (e) => { if (e.target === keys) keys.close(); });  // backdrop

  /* a shared link opened while the app is already open */
  window.addEventListener("hashchange", () => { if (DATA) openFromHash(); });

  /* saving for offline: only when asked */
  const off = $("#btn-offline");
  if (off) off.addEventListener("click", () => { offlineAction().catch(() => {}); });

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
    seekTo(parseFloat(seek.value));
  };
  seek.addEventListener("change", commit);
  seek.addEventListener("pointerup", commit);
  /* A drag can end with neither: the browser took the touch for a scroll,
     or focus left mid-drag. The bar then follows playback again. */
  const drop = () => {
    if (!scrubbing) return;
    scrubbing = false;
    updateTimes();
  };
  seek.addEventListener("pointercancel", drop);
  seek.addEventListener("blur", drop);

  /* speed + volume */
  const speed = $("#speed");
  speed.value = String(store.ui.speed);
  speed.addEventListener("change", () => {
    store.ui.speed = parseFloat(speed.value);
    audio.playbackRate = store.ui.speed;
    saveUI();
  });
  const vol = $("#volume");
  vol.hidden = isIOS();           // iOS ignores audio.volume: the slider would do nothing
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
  /* An episode counts as played -- into Recent, no longer new -- once sound
     actually comes out, not on a Play that then fails to load. */
  audio.addEventListener("playing", () => {
    if (!cur || notedPlaying === cur.ep.id) return;
    notedPlaying = cur.ep.id;
    noteRecent(cur.ep.id);
    if (isNew(cur.ep.id)) {
      markSeen([cur.ep.id]);
      render();
    }
  });
  audio.addEventListener("seeked", updatePositionState);
  audio.addEventListener("ratechange", updatePositionState);
  audio.addEventListener("ended", onEnded);
  audio.addEventListener("error", () => {
    if (!audio.src || !cur) return;
    console.error("Audio failed to load:", audio.src);
    retryOnline = !audio.paused;
    setLoading(false);
    const saved = store.cachedEps.indexOf(cur.ep.id) !== -1;
    const src = audio.src;
    if (!navigator.onLine) {
      showToast(t(saved ? "player.loadError" : "player.notSaved"));
    } else {
      /* A media error cannot tell a part missing from the archive from a
         dead connection; one HEAD request can. */
      const tell = (key) => { if (audio.src === src) showToast(t(key)); };
      fetch(src, { method: "HEAD", cache: "no-store" })
        .then((r) => tell(r.status === 404 ? "player.missing" : "player.loadError"))
        .catch(() => tell("player.loadError"));
    }
    updatePlayerText();
    markPlayingRow();
    renderNetBanner();
  });

  /* sleep timer */
  $("#sleep").addEventListener("change", (e) => setSleep(e.currentTarget.value));

  /* keyboard */
  document.addEventListener("keydown", (e) => {
    if (keys.open) return;                         // the dialog handles its own Escape
    if (e.key === "Escape" && npIsOpen()) { e.preventDefault(); closeNowPlaying(); return; }
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea") return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === "Space" && keyboardFocusedButton(e.target)) return;  // let it press
    if (e.code === "Space" || (e.code === "KeyK" && !e.shiftKey)) {
      e.preventDefault();
      togglePlay();
    }
    else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (e.shiftKey) goPart(-1); else skip(-15);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (e.shiftKey) goPart(1); else skip(15);
    } else if (e.shiftKey && (e.code === "KeyN" || e.code === "KeyP")) {
      e.preventDefault();
      goEpisode(e.code === "KeyN" ? 1 : -1);
    } else if (e.key === "/") {
      e.preventDefault();
      if (npIsOpen()) closeNowPlaying();
      $("#search").focus();
    } else if (e.key === "?") {
      e.preventDefault();
      openKeys();
    }
  });

  /* flush position on the way out; on the way back, catch up with any
     other tab that played meanwhile */
  const flush = () => persistPosition(true);
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { flush(); return; }
    if (handedOff && !isPlaying()) followOtherTab(false);
    recheckIndex();
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
      if (posInPart() > 3) { seekTo(0); return; }
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
      if (d && isFinite(d.seekTime)) seekTo(d.seekTime);
    });
  }
}

/* Another tab saved something. Listening marks, positions and the saved
   list are taken over as they are; this tab's view settings stay its own. */
function onStorage(e) {
  if (e.storageArea !== localStorage) return;
  const all = e.key === null;                      // storage was cleared
  if (all || e.key === K + "theme") {             // follows the other tab's choice
    store.theme = load("theme");
    applyTheme();
  }
  const shared = ["listened", "progress", "recent", "cachedEps", "seen", "last"]
    .filter((k) => all || e.key === K + k);
  if (shared.length === 0) return;
  shared.forEach((k) => {
    if (k === "seen") { store.seen = load("seen"); SEEN = new Set(store.seen); }
    else if (k !== "last") store[k] = load(k);
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
  $$(".ep.playing[data-id]").forEach((r) => {
    r.classList.remove("playing");
    setRowButton(r.querySelector(".ep-play"), BY_ID[r.dataset.id]);
  });
  $$(".ep-series").forEach((box) => {
    const series = SERIES_BY_ID[box.dataset.series];
    const head = box.querySelector(".series-head");
    head.classList.toggle("playing", !!(cur && series.eps.indexOf(cur.ep) !== -1));
    setSeriesButton(head.querySelector(".series-play"), series);
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

/* ================================================================ theme

   "auto" follows the device; "light" and "dark" set data-theme on <html>,
   which styles.css gives precedence over the device's preference. The
   inline script in index.html applies a saved choice before first paint. */

const THEME_BG = { light: "#f7f7f5", dark: "#16161a" };   // as --bg in styles.css

function applyTheme() {
  const root = document.documentElement;
  if (store.theme === "auto") delete root.dataset.theme;
  else root.dataset.theme = store.theme;
  syncThemeColor();
  renderTheme();
}

function renderTheme() {
  const b = $("#btn-theme");
  b.dataset.mode = store.theme;
  const lbl = t("theme." + store.theme);
  b.setAttribute("aria-label", lbl);
  b.title = lbl + " — " + t("theme.change");
}

/* The browser bar: the sheet's top while the full-screen player is open,
   else the page background of the chosen theme, else per the media query
   each <meta> carries. */
function syncThemeColor() {
  const top = npIsOpen()
    ? getComputedStyle(document.documentElement).getPropertyValue("--np-top").trim() : "";
  $$('meta[name="theme-color"]').forEach((m) => {
    if (!m.dataset.base) m.dataset.base = m.content;
    m.content = top || THEME_BG[store.theme] || m.dataset.base;
  });
}

/* ============================================================== autoplay */

function renderAutoplay() {
  const b = $("#btn-autoplay");
  const on = store.ui.autoplay;
  const lbl = t(on ? "autoplay.on" : "autoplay.off");
  b.setAttribute("aria-pressed", String(on));
  b.setAttribute("aria-label", lbl);
  b.title = lbl;
}

/* ================================================================= share

   A link to an episode at a moment: …/_site/#e=2025-10-30&t=754, the
   episode's date and the seconds into it. Dates are one per episode, so
   the link stays short; should two ever share one, the full id is used. */

const BY_DATE = Object.create(null);    // date -> episode, or null if not unique

function linkFor(ep, at) {
  const url = new URL("./", location.href);
  url.hash = (BY_DATE[ep.date] === ep ? "e=" + ep.date : "id=" + encodeURIComponent(ep.id)) +
    (at >= 5 ? "&t=" + Math.floor(at) : "");
  return url.href;
}

async function shareLink() {
  if (!cur) return;
  const ep = cur.ep;
  const inPart = posInPart();
  const at = elapsedBefore(ep, cur.part) + inPart;
  const url = linkFor(ep, at);
  const text = at >= 5 ? ep.title + " (" + partTime(ep, cur.part, inPart) + ")" : ep.title;

  if (navigator.share) {
    try {
      await navigator.share({ title: ep.title, text: text, url: url });
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return;    // closed the share sheet
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast(t("share.copied"));
  } catch (e) {
    window.prompt(t("share.copy"), url);           // no clipboard over plain http
  }
}

/* "part 3/4, 7:31": the player counts time per part, so a link says so too. */
function partTime(ep, part, time) {
  return t("share.at", { part: part + 1, total: ep.parts.length, time: fmtTime(time) });
}

/* Seconds into an episode -> the part and the time within it. */
function positionAt(ep, at) {
  for (let i = 0; i < ep.parts.length; i++) {
    const d = ep.parts[i].dur;
    if (!d || at < d || i === ep.parts.length - 1) {
      return { part: i, time: d ? Math.min(at, d) : at };
    }
    at -= d;
  }
  return { part: 0, time: 0 };
}

/* Opens the episode a shared link points to, paused at its moment; Play
   starts it. Nothing is saved until then, so a link only looked at leaves
   the listener's own place alone. */
function openFromHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const date = h.get("e"), id = h.get("id");
  if (!date && !id) return false;
  history.replaceState(history.state, "", location.pathname + location.search);
  const ep = id ? BY_ID[id] : BY_DATE[date];
  if (!ep) { showToast(t("share.notFound")); return false; }

  let at = Math.max(0, parseInt(h.get("t"), 10) || 0);
  /* At (or past) the very end, Play would only finish the episode at once
     and mark it heard: open it at the start instead. */
  if (epTotal(ep) && at >= epTotal(ep) - 5) at = 0;
  const pos = positionAt(ep, at);
  queue = null;
  loadEpisode(ep, pos.part, pos.time, false, true);
  revealEpisode(ep);
  showToast(at >= 5 ? t("share.opened", { at: partTime(ep, pos.part, pos.time) })
    : t("share.openedStart"));
  return true;
}

/* Scrolls the list to an episode's row, opening its group first. */
function revealEpisode(ep) {
  if (view.query) {
    $("#search").value = "";
    $("#search-clear").hidden = true;
    setQuery("");
  }
  if (store.ui.unheardOnly && isListened(ep.id)) {
    store.ui.unheardOnly = false;
    $("#filter-unheard").setAttribute("aria-pressed", "false");
  }
  const series = SERIES_OF[ep.id];
  if (series && store.ui.openSeries.indexOf(series.id) === -1) store.ui.openSeries.push(series.id);
  if (store.ui.open.indexOf(ep.season) === -1) store.ui.open.push(ep.season);
  saveUI();
  updateExpandLabel();
  render();
  const row = document.querySelector('#seasons .ep[data-id="' + cssEscape(ep.id) + '"]');
  if (row) {
    row.scrollIntoView({ block: "center", behavior: REDUCED_MOTION.matches ? "auto" : "smooth" });
    row.classList.add("flash");
    setTimeout(() => row.classList.remove("flash"), 2400);
  }
}

/* ============================================================ shortcuts */

function openKeys() {
  const d = $("#keys-dialog");
  if (d.open) return;
  if (npIsOpen()) closeNowPlaying();
  d.showModal();
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
  syncThemeColor();
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

   Saves an episode on the device when the listener asks for it (the cloud
   button in the player), so it plays in a tunnel or with no signal. Nothing
   is saved by itself: a new episode is 40-120 MB of someone's mobile data,
   and of the server's small home uplink, which every listener shares.

   The downloads ask for ?save=1, which the server paces and limits to a few
   at a time (see serve.py); one turned away with 503 waits and tries again.
   One episode is saved at a time, in the order asked. The service worker
   serves saved parts back with byte-range support; see sw.js. */

const AUDIO_CACHE = "cs-audio-v1";
/* Held, with the episode's id after it, for as long as a save runs, so a
   prune in another tab leaves its parts alone. The browser drops it if the
   tab closes. */
const SAVE_LOCK = "cs-saving:";
const SAVE_RETRY_MS = 30000;           // when the server says busy without a Retry-After
/* serve.py's default SAVE_KBPS, for the estimate before a save starts; once
   it runs, the rate actually measured takes over. */
const SAVE_KBPS_GUESS = 256;

const saving = {
  queue: [],            // episodes waiting their turn
  ep: null,             // the one downloading now
  pct: 0,
  left: 0,              // seconds still to go, from the measured rate (0: not yet known)
  busy: false,          // the server's save slots are full; waiting to retry
  ctl: null,
  failed: Object.create(null),         // id -> true: the last attempt failed
};

/* CacheStorage only exists in a secure context (https, or localhost). */
function cacheSupported() {
  return "caches" in window && window.isSecureContext;
}

function pathOf(url) {
  try { return new URL(url, location.origin).pathname; } catch (e) { return url; }
}

const isSaved = (ep) => store.cachedEps.indexOf(ep.id) !== -1;
const epBytes = (ep) => ep.parts.reduce((sum, p) => sum + (p.bytes || 0), 0);
const fmtMB = (bytes) => String(Math.max(1, Math.round(bytes / 1e6)));
const minutes = (secs) => Math.max(1, Math.ceil(secs / 60));
const saveMinutes = (ep) => minutes(epBytes(ep) * 8 / (SAVE_KBPS_GUESS * 1000));

/* What the cloud button shows for an episode. */
function saveState(ep) {
  if (isSaved(ep)) return "ready";
  if (saving.ep === ep) return saving.busy ? "queued" : "saving";
  if (saving.queue.indexOf(ep) !== -1) return "queued";
  return saving.failed[ep.id] ? "error" : "idle";
}

function renderOfflineChip() {
  const chip = $("#btn-offline");
  if (!chip) return;
  const label = $("#offline-label");

  if (!cacheSupported() || !cur) { chip.hidden = true; return; }
  chip.hidden = false;
  const ep = cur.ep;
  const state = saveState(ep);
  chip.dataset.state = state;

  const mb = fmtMB(epBytes(ep));
  const full = {
    idle: t("offline.save", { mb: mb }),
    queued: t("offline.queued"),
    saving: saving.left
      ? t("offline.savingLeft", { pct: saving.pct, n: minutes(saving.left) })
      : t("offline.saving", { pct: saving.pct }),
    ready: t("offline.ready"),
    error: t("offline.error"),
  }[state];
  const hint = {
    idle: t("offline.hintSave", { n: saveMinutes(ep) }),
    queued: t("offline.hintStop"), saving: t("offline.hintStop"),
    ready: t("offline.hintDelete"), error: t("offline.hintSave", { n: saveMinutes(ep) }),
  }[state];

  /* The Greek wording is long; on a phone the icon carries the meaning and the
     full text lives in the tooltip / accessible name. */
  const compact = window.matchMedia("(max-width: 700px)").matches && !npIsOpen();
  label.textContent = !compact ? full
    : state === "saving" ? saving.pct + "%"
    : state === "queued" ? "…"
    : state === "error" ? "!" : "";
  chip.setAttribute("aria-label", full + " — " + hint);
  chip.title = full + " — " + hint;
}

/* The cloud button: save the episode, stop saving it, or delete it. */
async function offlineAction() {
  if (!cur) return;
  const ep = cur.ep;
  const state = saveState(ep);
  if (state === "ready") {
    if (confirm(t("offline.confirmDelete", { mb: fmtMB(epBytes(ep)) }))) await deleteSaved(ep);
  } else if (state === "saving" || state === "queued") {
    if (confirm(t("offline.confirmStop"))) stopSaving(ep);
  } else {
    await requestSave(ep);
  }
  renderOfflineChip();
}

async function requestSave(ep) {
  if (!cacheSupported() || isSaved(ep) || saving.ep === ep ||
      saving.queue.indexOf(ep) !== -1) return;
  /* Fail early, rather than an hour in, when the device has no room. */
  try {
    const est = navigator.storage && navigator.storage.estimate &&
      await navigator.storage.estimate();
    if (est && est.quota && est.quota - (est.usage || 0) < epBytes(ep) * 1.1) {
      showToast(t("offline.full"));
      return;
    }
  } catch (e) { /* unknown: try anyway */ }
  /* Ask the browser not to evict saved episodes under storage pressure. */
  try {
    if (navigator.storage && navigator.storage.persist &&
        !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch (e) { /* not fatal */ }
  delete saving.failed[ep.id];
  saving.queue.push(ep);
  /* It runs inside the page, and a phone freezes a page left in the
     background: say how long it takes, and to keep the app open. */
  showToast(t("offline.started", { n: saveMinutes(ep) }));
  renderOfflineChip();
  pumpSaves();
}

function stopSaving(ep) {
  saving.queue = saving.queue.filter((e) => e !== ep);
  if (saving.ep === ep && saving.ctl) saving.ctl.abort();
  renderOfflineChip();
}

async function pumpSaves() {
  if (saving.ep || !saving.queue.length) return;
  const ep = saving.queue.shift();
  saving.ep = ep;
  saving.pct = 0;
  saving.left = 0;
  saving.busy = false;
  saving.ctl = new AbortController();
  renderOfflineChip();
  try {
    const run = async () => {
      await saveEpisode(ep, saving.ctl.signal);
      noteCached(ep.id);                           // before the lock goes
    };
    await (navigator.locks
      ? navigator.locks.request(SAVE_LOCK + ep.id, { signal: saving.ctl.signal }, run)
      : run());
    showToast(t("offline.done", { title: ep.title }));
  } catch (err) {
    if (!saving.ctl.signal.aborted) {
      console.warn("Saving for offline failed:", ep.id, err);
      saving.failed[ep.id] = true;
      showToast(t(err && err.name === "QuotaExceededError" ? "offline.full" : "offline.failed"));
    }
  }
  saving.ep = null;
  saving.ctl = null;
  saving.busy = false;
  await pruneAudioCache().catch(() => {});       // parts of a stopped save
  renderOfflineChip();
  renderSeasons();                                // the "saved" mark
  pumpSaves();
}

/* Resolves after `ms`, or straight away once `signal` aborts. */
function delay(ms, signal) {
  return new Promise((resolve) => {
    const id = setTimeout(resolve, ms);
    if (signal) signal.addEventListener("abort", () => { clearTimeout(id); resolve(); },
      { once: true });
  });
}

async function saveEpisode(ep, signal) {
  const cache = await caches.open(AUDIO_CACHE);
  const total = epBytes(ep) || ep.parts.length;
  let before = 0;                                 // bytes of the parts already done
  for (const part of ep.parts) {
    const size = part.bytes || 1;
    if (!(await cache.match(pathOf(part.url)))) {
      await savePart(cache, part, signal, (got, secs) => {
        /* Time left at this part's rate, once a few seconds have shown it. */
        if (secs >= 5) saving.left = (total - before - got) / (got / secs);
        const pct = Math.min(99, Math.floor(((before + got) / total) * 100));
        if (pct !== saving.pct) { saving.pct = pct; renderOfflineChip(); }
      });
    }
    before += size;
  }
}

/* One part into the cache. The server sends it at its paced rate; while
   its save slots are all taken it answers 503, and this waits its turn. */
async function savePart(cache, part, signal, onProgress) {
  for (;;) {
    if (signal.aborted) throw new DOMException("stopped", "AbortError");
    const res = await fetch(part.url + "?save=1", { signal: signal, cache: "no-store" });
    if (res.status === 503) {
      saving.busy = true;
      renderOfflineChip();
      const after = parseInt(res.headers.get("Retry-After"), 10);
      await delay(after > 0 ? after * 1000 : SAVE_RETRY_MS, signal);
      continue;
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
    if (saving.busy) { saving.busy = false; renderOfflineChip(); }

    const chunks = [];
    const t0 = performance.now();
    let got = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        chunks.push(step.value);
        got += step.value.length;
        onProgress(got, (performance.now() - t0) / 1000);
      }
    } else {
      chunks.push(await res.arrayBuffer());
    }
    const blob = new Blob(chunks, { type: "audio/mpeg" });
    await cache.put(part.url, new Response(blob, {
      status: 200,
      headers: { "Content-Type": "audio/mpeg", "Content-Length": String(blob.size) },
    }));
    return;
  }
}

/* Records a fully saved episode, most recent first. */
function noteCached(id) {
  update("cachedEps", (c) => [id].concat(c.filter((x) => x !== id)));
}

async function deleteSaved(ep) {
  if (!cacheSupported()) return;
  const cache = await caches.open(AUDIO_CACHE);
  for (const part of ep.parts) await cache.delete(pathOf(part.url));
  update("cachedEps", (c) => c.filter((x) => x !== ep.id));
  renderSeasons();
}

/* Keeps the cache to the episodes saved whole, and the ones being saved.
   Removes leftovers: a stopped save's parts, or parts the index no longer
   points at (an episode now served from a smaller copy). Also reconciles
   cachedEps with what is really stored: the browser may evict on its own. */
async function pruneAudioCache() {
  if (!cacheSupported()) return;
  const cache = await caches.open(AUDIO_CACHE);
  const keys = await cache.keys();
  const have = new Set(keys.map((req) => new URL(req.url).pathname));

  store.cachedEps = load("cachedEps");             // another tab may have saved one
  const keepIds = store.cachedEps.filter((id) => BY_ID[id] &&
    BY_ID[id].parts.every((p) => have.has(pathOf(p.url))));

  const keep = new Set();
  const keepEp = (ep) => ep.parts.forEach((p) => keep.add(pathOf(p.url)));
  keepIds.forEach((id) => keepEp(BY_ID[id]));
  if (saving.ep) keepEp(saving.ep);
  if (navigator.locks && navigator.locks.query) {   // saves running in other tabs
    const locks = await navigator.locks.query().catch(() => ({}));
    for (const l of (locks.held || []).concat(locks.pending || [])) {
      const id = l.name && l.name.indexOf(SAVE_LOCK) === 0 && l.name.slice(SAVE_LOCK.length);
      if (id && BY_ID[id]) keepEp(BY_ID[id]);
    }
  }
  for (const req of keys) {
    if (!keep.has(new URL(req.url).pathname)) await cache.delete(req);
  }

  const changed = keepIds.join("\n") !== store.cachedEps.join("\n");
  store.cachedEps = keepIds;
  if (changed) {
    write("cachedEps", keepIds);
    renderSeasons();
  }
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

/* An installed app can stay open for days, and the index is read once, at
   boot. Back in the app after a while, ask again (usually a 304). If the
   archive changed, offer a reload rather than rebuilding in place what a
   playing episode, its series or a running save still point into. */
const INDEX_RECHECK_MS = 6 * 3600 * 1000;
let indexCheckedAt = 0;

const indexShape = (seasons) => seasons.map((s) => s.episodes.map((ep) =>
  ep.id + ":" + ep.parts.map((p) => p.url + "=" + p.bytes).join()).join("|")).join("/");

async function recheckIndex() {
  if (!DATA || !navigator.onLine || Date.now() - indexCheckedAt < INDEX_RECHECK_MS) return;
  indexCheckedAt = Date.now();
  try {
    const res = await fetch("index.json", { cache: "no-cache" });
    if (!res.ok) return;
    const json = await res.json();
    if (indexShape(json.seasons) !== indexShape(SEASONS)) showReloadNotice();
  } catch (e) { /* offline or a blip: next time */ }
}

function showReloadNotice() {
  if (document.getElementById("reload-notice")) return;
  const el = document.createElement("button");
  el.type = "button";
  el.id = "reload-notice";
  el.className = "notice notice-action";
  el.dataset.i18n = "app.updated";             // re-translated on a language switch
  el.textContent = t("app.updated");
  el.addEventListener("click", () => location.reload());
  noticeHost().prepend(el);
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  wire();
  applyTheme();
  applyI18n();
  registerSW();

  let json;
  try {
    /* no-cache: the browser asks the server, and an unchanged index comes
       back as a 304 from its own copy instead of ~800 KB again. */
    const res = await fetch("index.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(res.status + " " + res.statusText);
    json = await res.json();
    indexCheckedAt = Date.now();
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
    SEASON_BY_NUM[s.num] = s;
    for (const ep of s.episodes) {
      ep._cps = Array.from(ep.title);
      ep._norm = ep._cps.map(normCP).join("");
      ep._dateNorm = normalize([ep.dateLabel, ep.dateLabelEn, ep.date].join(" "));
      ep._i = FLAT.length;
      FLAT.push(ep);
      BY_ID[ep.id] = ep;
      if (ep.date) BY_DATE[ep.date] = ep.date in BY_DATE ? null : ep;
    }
  }
  findSeries();
  dropStalePositions();

  /* The first time, everything already here counts as seen: "new" means
     added since this browser started using the app. */
  if (read("seen", null) === null) {
    store.seen = FLAT.map((ep) => ep.id);
    write("seen", store.seen);
  }
  SEEN = new Set(store.seen);

  $("#status").hidden = true;
  $("#filter-unheard").setAttribute("aria-pressed", String(store.ui.unheardOnly));
  applyI18n();

  /* One at a time, so a failure in one cannot skip the rest -- nor leave a
     blank page. A shared link takes the place of the last episode. */
  [render, () => { if (!openFromHash()) restoreLast(); }, setupInstall, renderNetBanner,
   () => { pruneAudioCache().catch(() => {}); }].forEach((step) => {
    try { step(); } catch (e) { console.error(e); }
  });

  if (json.warnings && json.warnings.length) {
    console.warn("index.json warnings:", json.warnings);
  }
}

/* A saved position can point past an episode's last part: the episode was
   re-split or corrected in the archive since, or the state is old or hand
   edited. Such a position means nothing any more, and reading it would
   break rendering on every load, so it is dropped. A time past the end of
   its part (a part since replaced by a shorter copy) starts that part from
   the top, as playing it would anyway. */
function dropStalePositions() {
  const stale = (id, part) => BY_ID[id] && part >= BY_ID[id].parts.length;
  const pastEnd = (id, pos) => {
    const part = BY_ID[id] && BY_ID[id].parts[pos.part];
    return !!part && part.dur > 0 && pos.time >= part.dur;
  };
  const prog = store.progress;
  if (Object.keys(prog).some((id) => stale(id, prog[id].part) || pastEnd(id, prog[id]))) {
    update("progress", (p) => {
      Object.keys(p).forEach((id) => {
        if (stale(id, p[id].part)) delete p[id];
        else if (pastEnd(id, p[id])) p[id].time = 0;
      });
    });
  }
  if (store.last && stale(store.last.id, store.last.part)) {
    store.last = null;
    saveLast();
  } else if (store.last && pastEnd(store.last.id, store.last)) {
    store.last.time = 0;
    saveLast();
  }
}

/* Put the last episode back on screen, paused and without saving anything.
   Browsers block autoplay before a user gesture, so playback starts on the
   first click rather than failing. A finished episode is not brought back. */
function restoreLast() {
  const last = store.last;
  const ep = last && BY_ID[last.id];
  if (ep && !finished(ep.id)) {
    queue = queueOf(last, ep);
    loadEpisode(ep, last.part, last.time, false, true);
  } else {
    document.body.classList.add("no-player");
  }
}

document.addEventListener("DOMContentLoaded", boot);
