// Jumbly: find every word hidden in six jumbled letters.
// Original Ducky Dailies game; puzzles come from tools/build_jumbly.py.
(() => {
  "use strict";

  const S = Shared;
  const PUZZLES = JUMBLY_PUZZLES;
  const EPOCH = JUMBLY_EPOCH;
  const KEYS = {
    mode: "jumbly:mode",
    daily: (d) => `jumbly:daily:${d}`,
    practice: "jumbly:practice",
  };

  const els = {
    board: document.getElementById("jb-board"),
    guess: document.getElementById("jb-guess"),
    letters: document.getElementById("jb-letters"),
    foundCount: document.getElementById("jb-found-count"),
    bonusCount: document.getElementById("jb-bonus-count"),
    enter: document.getElementById("jb-enter"),
    del: document.getElementById("jb-delete"),
    clear: document.getElementById("jb-clear"),
    shuffle: document.getElementById("jb-shuffle"),
    hint: document.getElementById("jb-hint"),
    reveal: document.getElementById("jb-reveal"),
    newGame: document.getElementById("new-game-btn"),
  };

  let state = null; // { mode, date, index, puzzle, order, found, bonus, hints, hinted, revealed }
  let picked = []; // indexes into state.order for the word being built
  let revealArmed = false;
  let archiveCtrl = null;

  // ---------- Quackers, the mascot ----------
  const mascotEl = document.getElementById("jb-mascot");
  const bubbleEl = document.getElementById("jb-bubble");
  const LINES = {
    hello: ["Quack! Let's find some words!", "Hi there! Ready to play?", "Ooh, good letters today!"],
    happy: ["Nice one!", "Quack-tastic!", "Ooh, good word!", "You're on a roll!", "Ducky!"],
    great: ["Ooh, a long one!", "Brainy bird!", "Now we're quacking!"],
    big: ["WOW! The big one!", "THAT'S the six-letter word!", "Holy quack! You got it!"],
    bonus: ["Bonus word! Fancy!", "Not on the board, but I'll allow it!", "Extra credit!"],
    wrong: ["Hmm, I don't know that one…", "Not a word, I think!", "Quack? Try again!"],
    again: ["You already found that one!", "Déjà vu! Got that already."],
    short: ["Need at least 3 letters!"],
    hint: ["Psst… look at the orange letter!", "Here's a little help!", "I peeked for you!"],
    mix: ["Shuffle shuffle!", "Fresh eyes!", "Wheee!"],
    done: ["You found them ALL! Quack quack!", "Genius goose! Er… duck!"],
    reveal: ["Aw, next time! Here they are.", "Tough one! Here are the answers."],
  };
  let moodTimer = null;
  let talkTimer = null;
  let lastLine = "";
  function pick(arr) {
    let l = arr[Math.floor(Math.random() * arr.length)];
    if (l === lastLine && arr.length > 1) l = arr[(arr.indexOf(l) + 1) % arr.length];
    lastLine = l;
    return l;
  }
  function react(mood, key, ms = 2600) {
    if (!mascotEl) return;
    mascotEl.className = `jb-mascot mood-${mood}`;
    void mascotEl.offsetWidth;
    mascotEl.classList.add("bump");
    if (key && LINES[key]) {
      const line = pick(LINES[key]);
      bubbleEl.textContent = line;
      bubbleEl.classList.remove("hidden");
      // flap the beak while he "says" the line
      mascotEl.classList.add("talking");
      clearTimeout(talkTimer);
      talkTimer = setTimeout(() => mascotEl.classList.remove("talking"), Math.min(2200, 450 + line.length * 45));
    }
    clearTimeout(moodTimer);
    if (ms) {
      moodTimer = setTimeout(() => {
        mascotEl.className = "jb-mascot mood-idle";
        bubbleEl.classList.add("hidden");
      }, ms);
    }
  }
  if (mascotEl) {
    mascotEl.addEventListener("click", () => { react("happy", "hello"); S.sfx("quack"); });
  }

  // ---------- puzzle selection ----------

  function dayNumber(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const [ey, em, ed] = EPOCH.split("-").map(Number);
    return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ey, em - 1, ed)) / 86400000);
  }

  function dailyIndex(dateStr) {
    const n = PUZZLES.length;
    return ((dayNumber(dateStr) % n) + n) % n;
  }

  function jumble(root, seed) {
    const rand = S.seededRandom(seed);
    let letters = root.split("");
    for (let tries = 0; tries < 10; tries++) {
      letters = S.shuffle(letters, rand);
      if (letters.join("") !== root) break;
    }
    return letters;
  }

  // ---------- persistence ----------

  function storageKey() {
    return state.mode === "daily" ? KEYS.daily(state.date) : KEYS.practice;
  }

  function persist() {
    const words = state.puzzle.words;
    S.save(storageKey(), {
      index: state.index,
      order: state.order,
      found: state.found,
      bonus: state.bonus,
      hints: state.hints,
      hinted: state.hinted,
      revealed: state.revealed,
      started: state.found.length > 0 || state.bonus.length > 0,
      over: state.revealed || state.found.length === words.length,
      total: words.length,
    });
  }

  function loadState(mode, date, index, saved) {
    const puzzle = PUZZLES[index];
    const ok = saved && saved.index === index;
    state = {
      mode,
      date,
      index,
      puzzle,
      order: ok && Array.isArray(saved.order) && saved.order.length === 6 ? saved.order : jumble(puzzle.root, `${mode}:${date || ""}:${index}`),
      found: ok && Array.isArray(saved.found) ? saved.found.filter((w) => puzzle.words.includes(w)) : [],
      bonus: ok && Array.isArray(saved.bonus) ? saved.bonus.filter((w) => puzzle.bonus.includes(w)) : [],
      hints: ok && Number.isInteger(saved.hints) ? saved.hints : 0,
      hinted: ok && saved.hinted && typeof saved.hinted === "object" ? saved.hinted : {},
      revealed: ok && !!saved.revealed,
    };
    picked = [];
    revealArmed = false;
    els.reveal.textContent = "Show all answers";
    render();
  }

  // ---------- modes ----------

  function setMode(mode) {
    try { localStorage.setItem(KEYS.mode, mode); } catch { /* ignore */ }
    document.querySelectorAll(".mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    els.newGame.classList.toggle("hidden", mode !== "practice");
  }

  function startDaily(dateStr) {
    setMode("daily");
    const date = dateStr || S.todayDateString();
    if (archiveCtrl) archiveCtrl.setDate(date);
    const index = dailyIndex(date);
    loadState("daily", date, index, S.load(KEYS.daily(date)));
  }

  function startPractice(forceNew) {
    setMode("practice");
    if (archiveCtrl) archiveCtrl.setDate(S.todayDateString());
    const saved = S.load(KEYS.practice);
    if (!forceNew && saved && Number.isInteger(saved.index) && PUZZLES[saved.index] && !saved.over) {
      loadState("practice", null, saved.index, saved);
      return;
    }
    let index = Math.floor(Math.random() * PUZZLES.length);
    if (state && index === state.index) index = (index + 1) % PUZZLES.length;
    loadState("practice", null, index, null);
    persist();
  }

  // ---------- rendering ----------

  function render() {
    renderBoard();
    renderLetters();
    renderGuess();
    const { words } = state.puzzle;
    els.foundCount.textContent = `${state.found.length} of ${words.length} words`;
    els.bonusCount.textContent = state.bonus.length ? `+ ${state.bonus.length} bonus` : "";
    const scoreEl = document.getElementById("jb-score");
    if (scoreEl) scoreEl.textContent = String(score());
    const done = state.revealed || state.found.length === words.length;
    [els.enter, els.del, els.clear, els.shuffle, els.hint, els.reveal].forEach((b) => (b.disabled = done));
  }

  function renderBoard() {
    const { words } = state.puzzle;
    const byLen = new Map();
    words.forEach((w) => {
      if (!byLen.has(w.length)) byLen.set(w.length, []);
      byLen.get(w.length).push(w);
    });
    let html = "";
    [...byLen.keys()].sort((a, b) => a - b).forEach((len) => {
      html += `<div class="jb-group"><div class="jb-group-label">${len} letters</div><div class="jb-group-words">`;
      byLen.get(len).forEach((w) => {
        const found = state.found.includes(w);
        const show = found || state.revealed;
        const hintLetters = state.hinted[w] || 0;
        html += `<div class="jb-word${found ? " found" : ""}${!found && state.revealed ? " missed" : ""}${w.length === 6 ? " big" : ""}" data-word="${w}">`;
        for (let i = 0; i < w.length; i++) {
          const ch = show || i < hintLetters ? w[i].toUpperCase() : "";
          html += `<span class="jb-box${!show && i < hintLetters ? " hinted" : ""}">${ch}</span>`;
        }
        html += `</div>`;
      });
      html += `</div></div>`;
    });
    els.board.innerHTML = html;
  }

  function renderLetters() {
    els.letters.innerHTML = state.order
      .map(
        (ch, i) =>
          `<button type="button" class="jb-letter${picked.includes(i) ? " used" : ""}" data-i="${i}" aria-label="${ch.toUpperCase()}"${picked.includes(i) ? " disabled" : ""} style="--bob-delay:${(i * 0.37).toFixed(2)}s"><span class="jb-duck" aria-hidden="true"></span><span class="jb-sign">${ch.toUpperCase()}</span></button>`
      )
      .join("");
  }

  function renderGuess() {
    const word = currentWord();
    els.guess.innerHTML = word
      ? word.toUpperCase().split("").map((c) => `<span class="jb-guess-letter">${c}</span>`).join("")
      : `<span class="jb-guess-placeholder">Tap the letters below</span>`;
  }

  // 10 points a letter; the six-letter word is worth 100; bonus words half.
  function wordPoints(w) {
    return w.length === 6 ? 100 : w.length * 10;
  }

  function score() {
    return state.found.reduce((t, w) => t + wordPoints(w), 0) + state.bonus.reduce((t, w) => t + Math.round(wordPoints(w) / 2), 0);
  }

  function currentWord() {
    return picked.map((i) => state.order[i]).join("");
  }

  // ---------- actions ----------

  function addIndex(i) {
    if (picked.includes(i) || isOver()) return;
    picked.push(i);
    S.sfx("tap");
    renderLetters();
    renderGuess();
    X.fxTap(els.letters.children[i]);
  }

  function typeLetter(ch) {
    const i = state.order.findIndex((c, idx) => c === ch && !picked.includes(idx));
    if (i >= 0) addIndex(i);
  }

  function removeLast() {
    if (picked.length) S.sfx("tap");
    picked.pop();
    renderLetters();
    renderGuess();
  }

  function clearGuess() {
    picked = [];
    renderLetters();
    renderGuess();
  }

  function mix() {
    S.sfx("shuffle");
    react("happy", "mix", 1400);
    const word = currentWord();
    state.order = S.shuffle(state.order);
    picked = [];
    // keep what they were spelling, re-mapped onto the new order
    word.split("").forEach((ch) => typeLetter(ch));
    persist();
    renderLetters();
    renderGuess();
  }

  function isOver() {
    return state.revealed || state.found.length === state.puzzle.words.length;
  }

  function flashGuess(cls) {
    els.guess.classList.remove("shake", "pop");
    void els.guess.offsetWidth;
    els.guess.classList.add(cls);
  }

  function submit() {
    if (isOver()) return;
    const word = currentWord();
    if (word.length < 3) {
      react("think", "short");
      flashGuess("shake");
      return;
    }
    const { words, bonus } = state.puzzle;
    if (state.found.includes(word) || state.bonus.includes(word)) {
      react("think", "again");
      S.sfx("wrong");
      flashGuess("shake");
    } else if (words.includes(word)) {
      state.found.push(word);
      if (state.found.length === words.length) { react("celebrate", "done", 0); S.sfx("win"); }
      else if (word.length === 6) { react("celebrate", "big", 3500); S.sfx("great"); setTimeout(() => S.sfx("quack2"), 350); }
      else { react("happy", word.length >= 5 ? "great" : "happy"); S.sfx(word.length >= 5 ? "great" : "good"); }
      S.showToast(word.length === 6 ? "The big one! +100 🦆" : `${word.length >= 5 ? "Great word!" : "Nice!"} +${wordPoints(word)}`);
      X.sfx("good");
      if (state.found.length === words.length) X.recordWin({ id: `${state.mode}:${state.index}`, clean: state.hints === 0 && !state.revealed });
      flashGuess("pop");
      clearGuess();
      persist();
      render();
      els.letters.classList.remove("splash");
      void els.letters.offsetWidth;
      els.letters.classList.add("splash");
      const el = els.board.querySelector(`[data-word="${word}"]`);
      if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
      if (state.found.length === words.length) setTimeout(showResult, 500);
      return;
    } else if (bonus.includes(word)) {
      state.bonus.push(word);
      react("happy", "bonus");
      S.sfx("bonus");
      S.showToast(`Bonus word: ${word.toUpperCase()} +${Math.round(wordPoints(word) / 2)}`);
      X.sfx("good");
      flashGuess("pop");
      clearGuess();
      persist();
      render();
      return;
    } else {
      react("sad", "wrong");
      S.sfx("wrong");
      flashGuess("shake");
      X.sfx("bad");
    }
    clearGuess();
  }

  // ---------- Extras: sound, Locker, Guided Look, newspaper print ----------
  const X = window.Extras;
  async function openJumblyGuide() {
    if (!state || isOver()) return;
    X.showGuide("Jumbly", `<p class="guide-note">Working it out…</p>`);
    let words;
    try {
      words = await X.loadWords();
    } catch (err) {
      X.showGuide("Guided Look", `<p class="guide-note">${S.escapeHtml(err.message)}</p>`);
      return;
    }
    state.hints += 1;
    persist();
    const typed = currentWord();
    const left = state.puzzle.words.filter((w) => !state.found.includes(w));
    const pool = typed ? left.filter((w) => w.startsWith(typed)) : left;
    const use = pool.length ? pool : left;
    const ranked = X.rank(use.map((w) => [w.toUpperCase(), words.z.get(w.toUpperCase()) || 2]));
    const show = Math.max(1, typed.length + 1);
    const rows = ranked.map(({ w, p }) => ({ w: w.slice(0, show) + "·".repeat(Math.max(0, w.length - show)), p, tag: `${w.length} letters${w.length === 6 ? " · the big one 🦆" : ""}` }));
    const byLen = {};
    left.forEach((w) => (byLen[w.length] = (byLen[w.length] || 0) + 1));
    X.showGuide(
      `Jumbly · ${left.length} word${left.length === 1 ? "" : "s"} left`,
      `${typed && !pool.length ? `<p class="guide-note">No word you still need starts with ${S.escapeHtml(typed.toUpperCase())}.</p>` : ""}
       ${X.guideList(rows, { have: (k) => k < show, max: 10 })}
       <div class="guide-starts">${Object.entries(byLen).sort((a, b) => a[0] - b[0]).map(([L, n]) => `<span><b>${L}-letter</b>&times;${n}</span>`).join("")}</div>
       <p class="guide-note">Most findable first. Odds lean toward more common words${typed ? `, among words starting ${S.escapeHtml(typed.toUpperCase())}` : ""}.</p>
       <p class="guide-cost">Counts as one hint.</p>`
    );
    X.sfx("reveal");
  }
  function printJumbly() {
    if (!state) return;
    const letters = state.order.map((c) => `<span class="pn-tile">${S.escapeHtml(c.toUpperCase())}</span>`).join("");
    const groups = {};
    state.puzzle.words.forEach((w) => (groups[w.length] = groups[w.length] || []).push(w));
    const blanks = Object.keys(groups).sort((a, b) => a - b).map((L) => `<div class="pn-jgroup"><b>${L} letters</b>${groups[L].map(() => `<span class="pn-blank">${"&#9633;".repeat(Number(L))}</span>`).join("")}</div>`).join("");
    const answers = Object.keys(groups).sort((a, b) => a - b).map((L) => `<div class="pn-jgroup"><b>${L} letters</b>${groups[L].map((w) => `<span class="pn-blank">${S.escapeHtml(w.toUpperCase())}</span>`).join("")}</div>`).join("");
    X.printPages([
      { title: "JUMBLY", by: "Unscramble the letters", bodyHtml: `<p class="pn-howto">Make as many words of three letters or more as you can from these letters. One word uses all six.</p><div class="pn-center pn-tiles">${letters}</div><div class="pn-jumbly">${blanks}</div>`, tag: state.date ? X.dateTag(new Date(`${state.date}T12:00:00`)) : "" },
      { title: "JUMBLY", by: "Answer", answer: true, bodyHtml: `<div class="pn-jumbly">${answers}</div>` },
    ]);
  }
  X.mount({ game: "jumbly", name: "Jumbly", guide: openJumblyGuide, print: printJumbly });

  function hint() {
    if (isOver()) return;
    const remaining = state.puzzle.words.filter((w) => !state.found.includes(w));
    // give another letter on the most-hinted word first, shortest words first
    remaining.sort((a, b) => (state.hinted[b] || 0) - (state.hinted[a] || 0) || a.length - b.length);
    const target = remaining.find((w) => (state.hinted[w] || 0) < w.length - 1);
    if (!target) {
      S.showToast("No more hints — try Show all answers");
      return;
    }
    state.hinted[target] = (state.hinted[target] || 0) + 1;
    react("think", "hint");
    S.sfx("hint");
    state.hints++;
    persist();
    renderBoard();
    const el = els.board.querySelector(`[data-word="${target}"]`);
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function reveal() {
    if (isOver()) return;
    if (!revealArmed) {
      revealArmed = true;
      els.reveal.textContent = "Tap again to show answers";
      setTimeout(() => {
        revealArmed = false;
        if (!isOver()) els.reveal.textContent = "Show all answers";
      }, 4000);
      return;
    }
    state.revealed = true;
    react("sad", "reveal", 0);
    S.sfx("lose");
    picked = [];
    persist();
    render();
    showResult();
  }

  function shareText() {
    const label = state.mode === "daily" ? `Jumbly ${state.date}` : "Jumbly (practice)";
    const all = state.found.length === state.puzzle.words.length && !state.revealed;
    return `${label} 🦆 Score ${score()}\n${all ? "Found every word" : `Found ${state.found.length}/${state.puzzle.words.length} words`}${state.bonus.length ? ` + ${state.bonus.length} bonus` : ""}${state.hints ? ` · ${state.hints} hint${state.hints === 1 ? "" : "s"}` : ""}\ncrossword.theduckynerdball.com/jumbly`;
  }

  function showResult() {
    const all = state.found.length === state.puzzle.words.length && !state.revealed;
    document.getElementById("result-title").textContent = all ? "You found them all! 🦆" : "Here are all the answers";
    document.getElementById("result-text").textContent = `Score ${score()} · ${state.found.length} of ${state.puzzle.words.length} words${
      state.bonus.length ? `, plus ${state.bonus.length} bonus word${state.bonus.length === 1 ? "" : "s"}` : ""
    }${state.hints ? ` · ${state.hints} hint${state.hints === 1 ? "" : "s"}` : ""}. The six-letter word was ${state.puzzle.root.toUpperCase()}.`;
    document.getElementById("play-again-btn").classList.toggle("hidden", state.mode !== "practice");
    S.openModal("result-modal");
  }

  // ---------- wiring ----------

  els.letters.addEventListener("click", (e) => {
    const b = e.target.closest(".jb-letter");
    if (b) addIndex(Number(b.dataset.i));
  });
  els.guess.addEventListener("click", removeLast);
  els.enter.addEventListener("click", submit);
  els.del.addEventListener("click", removeLast);
  els.clear.addEventListener("click", clearGuess);
  els.shuffle.addEventListener("click", mix);
  els.hint.addEventListener("click", hint);
  els.reveal.addEventListener("click", reveal);
  els.newGame.addEventListener("click", () => startPractice(true));
  document.getElementById("help-btn").addEventListener("click", () => S.openModal("help-modal"));
  document.getElementById("share-btn").addEventListener("click", () => S.shareText(shareText()));
  document.getElementById("play-again-btn").addEventListener("click", () => {
    S.closeModal("result-modal");
    startPractice(true);
  });

  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.mode === "daily") startDaily();
      else startPractice(false);
    });
  });

  document.addEventListener("keydown", (e) => {
    if (S.anyModalOpen() || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    if (e.key === "Enter") { e.preventDefault(); submit(); }
    else if (e.key === "Backspace") { e.preventDefault(); removeLast(); }
    else if (e.key === "Escape") clearGuess();
    else if (e.key === " ") { e.preventDefault(); mix(); }
    else if (/^[a-zA-Z]$/.test(e.key)) typeLetter(e.key.toLowerCase());
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state && state.mode === "daily" && state.date !== S.todayDateString() && dayNumber(state.date) === dayNumber(S.todayDateString()) - 1) {
      startDaily();
    }
  });

  S.initShell({});
  if (S.initArchive) {
    archiveCtrl = S.initArchive({
      epoch: EPOCH,
      getStatus(d) {
        const s = S.load(KEYS.daily(d));
        if (!s || !s.started) return { state: "none", detail: d };
        if (!s.over) return { state: "progress", detail: `${(s.found || []).length}/${s.total || ""} words` };
        return { state: "won", detail: `${(s.found || []).length}/${s.total || ""} words` };
      },
      onSelectDate(d) {
        startDaily(d);
      },
    });
  }

  let startMode = "daily";
  try {
    if (localStorage.getItem(KEYS.mode) === "practice") startMode = "practice";
  } catch { /* ignore */ }
  if (startMode === "practice") startPractice(false);
  else startDaily();
  setTimeout(() => {
    if (isOver()) react(state.revealed ? "idle" : "celebrate", state.revealed ? null : "done", 3500);
    else react("happy", "hello", 3500);
  }, 600);
})();
