/* Interface translations. Episode titles are NEVER translated -- they come
   from the original Greek folder names and are rendered verbatim in both
   languages. Only chrome (buttons, labels, headings) switches. */

const I18N = {
  el: {
    "app.title": "Χριστιανισμός - Επιστήμη",
    "app.subtitle": "{seasons} κύκλοι · {episodes} εκπομπές · {hours} ώρες",
    "app.loading": "Φόρτωση αρχείου…",
    "app.loadError": "Δεν ήταν δυνατή η φόρτωση του index.json. Τρέξτε: python3 _site/build_index.py",

    "search.placeholder": "Αναζήτηση εκπομπής…",
    "search.clear": "Καθαρισμός αναζήτησης",
    "search.results": "{n} αποτελέσματα",
    "search.noResults": "Καμία εκπομπή δεν ταιριάζει με «{q}»",

    "filter.unheard": "Μόνο ανήκουστες",
    "filter.unheardOn": "Εμφάνιση όλων",
    "sort.newest": "Νεότερες πρώτα",
    "sort.oldest": "Παλαιότερες πρώτα",
    "nav.expandAll": "Άνοιγμα όλων",
    "nav.collapseAll": "Κλείσιμο όλων",

    "season.label": "{n}ος Κύκλος Εκπομπών",
    "season.episodes": "{n} εκπομπές",
    "season.unheard": "{n} ανήκουστες",
    "season.allListened": "όλες ακουσμένες",

    "continue.title": "Συνέχεια ακρόασης",
    "continue.resume": "Συνέχεια",
    "continue.at": "Μέρος {part}/{total} · {time}",
    "recent.title": "Πρόσφατα",
    "recent.empty": "Δεν έχετε ακούσει ακόμη καμία εκπομπή.",

    "ep.part": "Μέρος {n}/{total}",
    "ep.parts": "{n} μέρη",
    "ep.duration": "{n} λεπτά",
    "ep.listened": "Ακουσμένη",
    "ep.markListened": "Σήμανση ως ακουσμένη",
    "ep.markUnlistened": "Σήμανση ως ανήκουστη",
    "ep.play": "Αναπαραγωγή",
    "ep.nowPlaying": "Παίζει τώρα",

    "player.play": "Αναπαραγωγή",
    "player.pause": "Παύση",
    "player.prevPart": "Προηγούμενο μέρος",
    "player.nextPart": "Επόμενο μέρος",
    "player.prevEpisode": "Προηγούμενη εκπομπή",
    "player.nextEpisode": "Επόμενη εκπομπή",
    "player.back15": "Πίσω 15 δευτ.",
    "player.fwd15": "Μπροστά 15 δευτ.",
    "player.speed": "Ταχύτητα",
    "player.volume": "Ένταση",
    "player.seek": "Θέση στο μέρος",
    "player.episodeProgress": "Πρόοδος εκπομπής",
    "player.empty": "Επιλέξτε μια εκπομπή",
    "player.close": "Κλείσιμο",

    "lang.switch": "Γλώσσα διεπαφής",

    "install.title": "Εγκατάσταση εφαρμογής",
    "install.sub": "Πλήρης οθόνη, δικό της εικονίδιο, λειτουργεί και εκτός σύνδεσης.",
    "install.button": "Εγκατάσταση εφαρμογής",
    "install.continue": "Συνέχεια στον browser",
    "install.iosStep1": "Πατήστε «Κοινή χρήση»",
    "install.iosStep2": "Επιλέξτε «Προσθήκη στην αρχική οθόνη»",
    "install.manual": "Από το μενού του browser, επιλέξτε «Προσθήκη στην αρχική οθόνη».",
    "install.https": "Η εγκατάσταση χρειάζεται HTTPS (ή localhost). Σε αυτή τη διεύθυνση δεν είναι διαθέσιμη.",

    "offline.off": "Εκτός σύνδεσης: ανενεργό",
    "offline.waiting": "Αποθήκευση…",
    "offline.saving": "Αποθήκευση {pct}%",
    "offline.ready": "Διαθέσιμο εκτός σύνδεσης",
    "offline.partial": "{n}/{total} μέρη",
    "offline.error": "Η αποθήκευση απέτυχε",
    "offline.hint": "Αποθηκεύει την εκπομπή που ακούτε, ώστε να μη σταματά σε τούνελ ή χωρίς σήμα.",
    "net.offline": "Είστε εκτός σύνδεσης — παίζουν μόνο οι αποθηκευμένες εκπομπές.",
  },

  en: {
    "app.title": "Christianity - Science",
    "app.subtitle": "{seasons} seasons · {episodes} episodes · {hours} hours",
    "app.loading": "Loading archive…",
    "app.loadError": "Could not load index.json. Run: python3 _site/build_index.py",

    "search.placeholder": "Search episodes…",
    "search.clear": "Clear search",
    "search.results": "{n} results",
    "search.noResults": "No episode matches “{q}”",

    "filter.unheard": "Unheard only",
    "filter.unheardOn": "Show all",
    "sort.newest": "Newest first",
    "sort.oldest": "Oldest first",
    "nav.expandAll": "Expand all",
    "nav.collapseAll": "Collapse all",

    "season.label": "Season {n}",
    "season.episodes": "{n} episodes",
    "season.unheard": "{n} unheard",
    "season.allListened": "all listened",

    "continue.title": "Continue listening",
    "continue.resume": "Resume",
    "continue.at": "Part {part}/{total} · {time}",
    "recent.title": "Recently played",
    "recent.empty": "You haven’t listened to anything yet.",

    "ep.part": "Part {n}/{total}",
    "ep.parts": "{n} parts",
    "ep.duration": "{n} min",
    "ep.listened": "Listened",
    "ep.markListened": "Mark as listened",
    "ep.markUnlistened": "Mark as unheard",
    "ep.play": "Play",
    "ep.nowPlaying": "Now playing",

    "player.play": "Play",
    "player.pause": "Pause",
    "player.prevPart": "Previous part",
    "player.nextPart": "Next part",
    "player.prevEpisode": "Previous episode",
    "player.nextEpisode": "Next episode",
    "player.back15": "Back 15s",
    "player.fwd15": "Forward 15s",
    "player.speed": "Speed",
    "player.volume": "Volume",
    "player.seek": "Position in part",
    "player.episodeProgress": "Episode progress",
    "player.empty": "Pick an episode",
    "player.close": "Close",

    "lang.switch": "Interface language",

    "install.title": "Install app",
    "install.sub": "Full screen, its own home-screen icon, works offline.",
    "install.button": "Install app",
    "install.continue": "Continue in browser",
    "install.iosStep1": "Tap Share",
    "install.iosStep2": "Choose “Add to Home Screen”",
    "install.manual": "From your browser menu, choose “Add to Home Screen”.",
    "install.https": "Installing needs HTTPS (or localhost). It isn’t available on this address.",

    "offline.off": "Offline saving: off",
    "offline.waiting": "Saving…",
    "offline.saving": "Saving {pct}%",
    "offline.ready": "Available offline",
    "offline.partial": "{n}/{total} parts",
    "offline.error": "Saving failed",
    "offline.hint": "Keeps the episode you are listening to on the device, so it doesn’t stop in a tunnel or with no signal.",
    "net.offline": "You are offline — only saved episodes will play.",
  },
};

/* t("ep.part", {n: 2, total: 4}) */
function t(key, vars) {
  const table = I18N[window.__lang] || I18N.el;
  let s = table[key];
  if (s === undefined) s = (I18N.el[key] !== undefined ? I18N.el[key] : key);
  if (vars) {
    for (const k in vars) s = s.split("{" + k + "}").join(vars[k]);
  }
  return s;
}
