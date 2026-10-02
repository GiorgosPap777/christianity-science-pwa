/* Interface translations. Episode titles are NEVER translated -- they come
   from the original Greek folder names and are rendered verbatim in both
   languages. Only chrome (buttons, labels, headings) switches. */

const I18N = {
  el: {
    "app.title": "Χριστιανισμός - Επιστήμη",
    "app.subtitle": "{seasons} κύκλοι · {episodes} εκπομπές · {hours} ώρες",
    "app.loading": "Φόρτωση αρχείου…",
    "app.loadError": "Δεν ήταν δυνατή η φόρτωση του index.json. Τρέξτε: python3 _site/build_index.py",

    "search.placeholder": "Αναζήτηση τίτλου ή ημερομηνίας…",
    "search.clear": "Καθαρισμός αναζήτησης",
    "search.results": "{n} αποτελέσματα",
    "search.results.one": "{n} αποτέλεσμα",
    "search.noResults": "Καμία εκπομπή δεν ταιριάζει με «{q}»",

    "filter.unheard": "Μόνο ανήκουστες",
    "filter.unheardOn": "Εμφάνιση όλων",
    "sort.newest": "Νεότερες πρώτα",
    "sort.oldest": "Παλαιότερες πρώτα",
    "nav.expandAll": "Άνοιγμα όλων",
    "nav.collapseAll": "Κλείσιμο όλων",

    "season.label": "{n}ος Κύκλος Εκπομπών",
    "season.episodes": "{n} εκπομπές",
    "season.episodes.one": "{n} εκπομπή",
    "season.unheard": "{n} ανήκουστες",
    "season.unheard.one": "{n} ανήκουστη",
    "season.allListened": "όλες ακουσμένες",
    "season.progress": "{done} από {total} ακουσμένες",

    "continue.title": "Συνέχεια ακρόασης",
    "continue.resume": "Συνέχεια",
    "continue.at": "Μέρος {part}/{total} · {time}",
    "recent.title": "Πρόσφατα",
    "recent.empty": "Δεν έχετε ακούσει ακόμη καμία εκπομπή.",

    "ep.part": "Μέρος {n}/{total}",
    "ep.parts": "{n} μέρη",
    "ep.parts.one": "{n} μέρος",
    "ep.duration": "{n} λεπτά",
    "ep.duration.one": "{n} λεπτό",
    "ep.saved": "Αποθηκευμένη στη συσκευή",
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
    "player.loadError": "Δεν ήταν δυνατή η φόρτωση αυτού του μέρους. Ελέγξτε τη σύνδεση και δοκιμάστε ξανά.",
    "player.notSaved": "Αυτή η εκπομπή δεν είναι αποθηκευμένη στη συσκευή.",

    "np.title": "Τώρα παίζει",
    "np.open": "Άνοιγμα σε πλήρη οθόνη",
    "np.close": "Ελαχιστοποίηση",
    "np.left": "Απομένουν {time}",

    "sleep.title": "Χρονοδιακόπτης ύπνου",
    "sleep.off": "Ανενεργός",
    "sleep.min": "Σε {n} λεπτά",
    "sleep.part": "Στο τέλος του μέρους",
    "sleep.episode": "Στο τέλος της εκπομπής",
    "sleep.partShort": "Μέρος",
    "sleep.episodeShort": "Εκπομπή",

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

    "search.placeholder": "Search titles or dates…",
    "search.clear": "Clear search",
    "search.results": "{n} results",
    "search.results.one": "{n} result",
    "search.noResults": "No episode matches “{q}”",

    "filter.unheard": "Unheard only",
    "filter.unheardOn": "Show all",
    "sort.newest": "Newest first",
    "sort.oldest": "Oldest first",
    "nav.expandAll": "Expand all",
    "nav.collapseAll": "Collapse all",

    "season.label": "Season {n}",
    "season.episodes": "{n} episodes",
    "season.episodes.one": "{n} episode",
    "season.unheard": "{n} unheard",
    "season.allListened": "all listened",
    "season.progress": "{done} of {total} listened",

    "continue.title": "Continue listening",
    "continue.resume": "Resume",
    "continue.at": "Part {part}/{total} · {time}",
    "recent.title": "Recently played",
    "recent.empty": "You haven’t listened to anything yet.",

    "ep.part": "Part {n}/{total}",
    "ep.parts": "{n} parts",
    "ep.parts.one": "{n} part",
    "ep.duration": "{n} min",
    "ep.saved": "Saved on this device",
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
    "player.loadError": "Couldn’t load this part. Check your connection and try again.",
    "player.notSaved": "This episode isn’t saved on this device.",

    "np.title": "Now playing",
    "np.open": "Open full screen",
    "np.close": "Minimise",
    "np.left": "{time} left",

    "sleep.title": "Sleep timer",
    "sleep.off": "Off",
    "sleep.min": "In {n} minutes",
    "sleep.part": "At the end of this part",
    "sleep.episode": "At the end of this episode",
    "sleep.partShort": "Part",
    "sleep.episodeShort": "Episode",

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

/* t("ep.part", {n: 2, total: 4}). When {n} is 1 and a "<key>.one" entry
   exists it is used instead, so counts read "1 result", not "1 results". */
function t(key, vars) {
  const table = I18N[window.__lang] || I18N.el;
  if (vars && vars.n === 1 && table[key + ".one"] !== undefined) key += ".one";
  let s = table[key];
  if (s === undefined) s = (I18N.el[key] !== undefined ? I18N.el[key] : key);
  if (vars) {
    for (const k in vars) s = s.split("{" + k + "}").join(vars[k]);
  }
  return s;
}
