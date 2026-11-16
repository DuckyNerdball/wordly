// Shared engine for Mini Crossy (/mini) and Crossy (/crossword).
// Reads window.CROSSWORD_CONFIG = { key, name, epoch, puzzles } set by the page.
(() => {
  "use strict";

  const S = Shared;
  const CFG = window.CROSSWORD_CONFIG;

  const KEYS = {
    mode: `${CFG.key}:mode`,
    daily: (date) => `${CFG.key}:daily:${date}`,
    practice: `${CFG.key}:practice`,
  };

  const KEYBOARD_ROWS = [
    ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
    ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
    ["dir", "z", "x", "c", "v", "b", "n", "m", "backspace"],
  ];

  const els = {
    game: document.getElementById("cw-game"),
    gate: document.getElementById("name-gate"),
    byline: document.getElementById("cw-byline"),
    timer: document.getElementById("cw-timer"),
    board: document.getElementById("cw-board"),
    cluePrev: document.getElementById("cw-clue-prev"),
    clueNext: document.getElementById("cw-clue-next"),
    clueBar: document.getElementById("cw-clue-bar"),
    clueNum: document.getElementById("cw-clue-num"),
    clueText: document.getElementById("cw-clue-text"),
    checkWord: document.getElementById("cw-check"),
    revealCell: document.getElementById("cw-reveal-cell"),
    revealWord: document.getElementById("cw-reveal-word"),
    extra: document.getElementById("cw-extra"),
    acrossList: document.getElementById("cw-across-list"),
    downList: document.getElementById("cw-down-list"),
    keyboard: document.getElementById("keyboard"),
    newGame: document.getElementById("new-game-btn"),
  };

  let state = null;
  let stopwatch = null;
  let countdownTimer = null;
  let lastPersistSecond = -1;

  // ---------- puzzle indexing & geometry ----------

  function dayNumber(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const [ey, em, ed] = CFG.epoch.split("-").map(Number);
    return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ey, em - 1, ed)) / 86400000);
  }

  function puzzleIndexFor(dateStr) {
    const n = CFG.puzzles.length;
    return ((dayNumber(dateStr) % n) + n) % n;
  }

  // Build rich geometry from a compact puzzle entry.
  function hydratePuzzle(raw) {
    const { rows, cols, grid } = raw;
    const total = rows * cols;
    const cellNums = new Array(total).fill(0);
    const acrossWords = [];
    const downWords = [];
    // Some archived clues are double-encoded UTF-8 ("sÃ©ance"); repair them.
    const fixText = (s) => {
      if (typeof s !== "string" || !/[\u00c2\u00c3]/.test(s)) return s;
      try { return decodeURIComponent(escape(s)); } catch { return s; }
    };
    const acrossMap = new Map(raw.across.map(([n, c]) => [n, fixText(c)]));
    const downMap = new Map(raw.down.map(([n, c]) => [n, fixText(c)]));
    const cellAcross = new Array(total).fill(-1);
    const cellDown = new Array(total).fill(-1);

    let num = 1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        if (grid[idx] === ".") continue;
        const startsAcross = (c === 0 || grid[idx - 1] === ".") && c + 1 < cols && grid[idx + 1] !== ".";
        const startsDown = (r === 0 || grid[idx - cols] === ".") && r + 1 < rows && grid[idx + cols] !== ".";
        if (startsAcross || startsDown) {
          cellNums[idx] = num;
          if (startsAcross) {
            const cells = [];
            for (let cc = c; cc < cols && grid[r * cols + cc] !== "."; cc++) {
              const i = r * cols + cc;
              cells.push(i);
              cellAcross[i] = acrossWords.length;
            }
            acrossWords.push({ dir: "across", num, clue: acrossMap.get(num) || "", cells });
          }
          if (startsDown) {
            const cells = [];
            for (let rr = r; rr < rows && grid[rr * cols + c] !== "."; rr++) {
              const i = rr * cols + c;
              cells.push(i);
              cellDown[i] = downWords.length;
            }
            downWords.push({ dir: "down", num, clue: downMap.get(num) || "", cells });
          }
          num++;
        }
      }
    }

    const whiteCount = grid.split("").filter((ch) => ch !== ".").length;
    return {
      ...raw,
      total,
      whiteCount,
      cellNums,
      acrossWords,
      downWords,
      cellAcross,
      cellDown,
    };
  }

  // ---------- lifecycle ----------

  function setMode(mode) {
    try {
      localStorage.setItem(KEYS.mode, mode);
    } catch {
      // ignore
    }
    document.querySelectorAll(".mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    els.newGame.style.visibility = mode === "practice" ? "visible" : "hidden";
    els.extra.textContent = mode === "daily" ? "Yesterday's answers" : "Show answers";
  }

  function teardown() {
    if (stopwatch && state && state.puzzle) {
      state.activeMs = stopwatch.stop();
      persist();
    }
    stopwatch = null;
  }

  function startDaily(dateStr) {
    teardown();
    setMode("daily");
    const date = dateStr || (state && state.date) || S.todayDateString();
    if (archiveCtrl) archiveCtrl.setDate(date);
    if (!S.getPlayerName()) {
      state = { mode: "daily", date };
      showGate();
      return;
    }
    hideGate();
    const index = puzzleIndexFor(date);
    const saved = S.load(KEYS.daily(date)) || {};
    loadPuzzle("daily", date, index, saved);
  }

  function startPractice(forceNew) {
    teardown();
    setMode("practice");
    hideGate();
    const saved = !forceNew && S.load(KEYS.practice);
    if (saved && Number.isInteger(saved.index) && saved.index >= 0 && saved.index < CFG.puzzles.length && !saved.over) {
      loadPuzzle("practice", null, saved.index, saved);
      return;
    }
    const avoid = state && Number.isInteger(state.index) ? state.index : -1;
    let index = Math.floor(Math.random() * CFG.puzzles.length);
    if (CFG.puzzles.length > 1 && index === avoid) index = (index + 1) % CFG.puzzles.length;
    loadPuzzle("practice", null, index, {});
  }

  function loadPuzzle(mode, date, index, saved) {
    const puzzle = hydratePuzzle(CFG.puzzles[index]);
    const total = puzzle.total;

    const entries =
      Array.isArray(saved.entries) && saved.entries.length === total
        ? saved.entries.map((c) => (typeof c === "string" && /^[A-Z]$/.test(c) ? c : ""))
        : new Array(total).fill("");

    const hinted =
      Array.isArray(saved.hinted) && saved.hinted.length === total
        ? saved.hinted.map(Boolean)
        : new Array(total).fill(false);

    const wrong =
      Array.isArray(saved.wrong) && saved.wrong.length === total
        ? saved.wrong.map(Boolean)
        : new Array(total).fill(false);

    let firstWhite = 0;
    while (firstWhite < total && puzzle.grid[firstWhite] === ".") firstWhite++;

    state = {
      mode,
      date,
      index,
      puzzle,
      entries,
      hinted,
      wrong,
      hints: Number.isInteger(saved.hints) && saved.hints >= 0 ? saved.hints : 0,
      cursor: Number.isInteger(saved.cursor) && puzzle.grid[saved.cursor] !== "." ? saved.cursor : firstWhite,
      dir: saved.dir === "down" ? "down" : "across",
      started: !!saved.started,
      activeMs: saved.activeMs || 0,
      over: !!saved.over,
      submitted: !!saved.submitted,
    };

    // Ensure current direction has a word at cursor; otherwise flip.
    if (wordAt(state.cursor, state.dir) === null && wordAt(state.cursor, otherDir(state.dir)) !== null) {
      state.dir = otherDir(state.dir);
    }

    stopwatch = S.createStopwatch(state.activeMs, onTick);
    els.timer.textContent = S.formatTimer(state.activeMs);
    els.timer.classList.toggle("hidden", !state.started);
    els.byline.textContent = `${puzzle.title} · by ${puzzle.author}`;

    buildBoardDOM();
    buildClueListsDOM();
    render();
    persist();

    if (state.started && !state.over) stopwatch.start();
    if (state.over) {
      if (mode === "daily" && !state.submitted) submitResult();
      showResult();
    }
  }

  function onTick(ms) {
    state.activeMs = ms;
    els.timer.textContent = S.formatTimer(ms);
    const sec = Math.floor(ms / 1000);
    if (sec !== lastPersistSecond) {
      lastPersistSecond = sec;
      persist();
    }
  }

  function ensureStarted() {
    if (!state.started) {
      state.started = true;
      els.timer.classList.remove("hidden");
    }
    if (stopwatch && !stopwatch.running && !state.over) stopwatch.start();
  }

  function persist() {
    if (!state || !state.puzzle) return;
    const filled = state.entries.filter((ch, i) => state.puzzle.grid[i] !== "." && ch !== "").length;
    const data = {
      id: state.puzzle.id,
      entries: state.entries,
      hinted: state.hinted,
      wrong: state.wrong,
      hints: state.hints,
      filled,
      total: state.puzzle.whiteCount,
      cursor: state.cursor,
      dir: state.dir,
      started: state.started,
      activeMs: state.activeMs,
      over: state.over,
      won: state.over,
      submitted: state.submitted,
    };
    if (state.mode === "daily") S.save(KEYS.daily(state.date), data);
    else S.save(KEYS.practice, { index: state.index, ...data });
  }

  function showGate() {
    els.game.classList.add("hidden");
    if (els.keyboard && els.keyboard.parentElement) els.keyboard.parentElement.classList.add("hidden");
    els.gate.classList.remove("hidden");
    document.getElementById("gate-name-input").value = "";
  }

  function hideGate() {
    els.game.classList.remove("hidden");
    if (els.keyboard && els.keyboard.parentElement) els.keyboard.parentElement.classList.remove("hidden");
    els.gate.classList.add("hidden");
  }

  // ---------- word & cursor helpers ----------

  function otherDir(dir) {
    return dir === "across" ? "down" : "across";
  }

  function wordAt(cellIdx, dir) {
    const p = state.puzzle;
    const wIdx = dir === "across" ? p.cellAcross[cellIdx] : p.cellDown[cellIdx];
    if (wIdx < 0) return null;
    return dir === "across" ? p.acrossWords[wIdx] : p.downWords[wIdx];
  }

  function activeWord() {
    return wordAt(state.cursor, state.dir) || wordAt(state.cursor, otherDir(state.dir));
  }

  function allWords() {
    return [...state.puzzle.acrossWords, ...state.puzzle.downWords];
  }

  function isWordFilled(word) {
    return word.cells.every((i) => state.entries[i] !== "");
  }

  function selectCell(idx) {
    if (state.puzzle.grid[idx] === ".") return;
    if (idx === state.cursor) {
      flipDirection();
      return;
    }
    state.cursor = idx;
    if (!wordAt(idx, state.dir) && wordAt(idx, otherDir(state.dir))) {
      state.dir = otherDir(state.dir);
    }
    render();
    persist();
  }

  function flipDirection() {
    const alt = otherDir(state.dir);
    if (wordAt(state.cursor, alt)) {
      state.dir = alt;
      render();
      persist();
    }
  }

  function stepClue(delta) {
    const words = allWords();
    if (!words.length) return;
    const cur = activeWord();
    let idx = cur ? words.findIndex((w) => w.dir === cur.dir && w.num === cur.num) : 0;
    for (let step = 1; step <= words.length; step++) {
      const next = words[(idx + delta * step + words.length * 2) % words.length];
      if (!isWordFilled(next) || step === words.length) {
        state.dir = next.dir;
        const emptyCell = next.cells.find((i) => state.entries[i] === "");
        state.cursor = emptyCell !== undefined ? emptyCell : next.cells[0];
        render();
        persist();
        return;
      }
    }
  }

  function moveByArrow(dr, dc) {
    const { rows, cols, grid } = state.puzzle;
    const wantDir = dr !== 0 ? "down" : "across";
    if (state.dir !== wantDir && wordAt(state.cursor, wantDir)) {
      state.dir = wantDir;
      render();
      persist();
      return;
    }
    let r = Math.floor(state.cursor / cols);
    let c = state.cursor % cols;
    for (let i = 0; i < rows * cols; i++) {
      r = (r + dr + rows) % rows;
      c = (c + dc + cols) % cols;
      const next = r * cols + c;
      if (grid[next] !== ".") {
        state.cursor = next;
        if (!wordAt(next, state.dir) && wordAt(next, otherDir(state.dir))) {
          state.dir = otherDir(state.dir);
        }
        render();
        persist();
        return;
      }
    }
  }

  // ---------- input & solving ----------

  function typeLetter(ch) {
    if (!state || !state.puzzle || state.over) return;
    const letter = ch.toUpperCase();
    if (!/^[A-Z]$/.test(letter)) return;
    ensureStarted();

    const idx = state.cursor;
    const wasDone = completedWordsAt(idx).map((w) => w.dir);
    // Revealed cells are locked to the correct letter.
    if (!(state.hinted[idx] && state.entries[idx] === state.puzzle.grid[idx])) {
      state.entries[idx] = letter;
      state.wrong[idx] = false;
    }
    X.fxTap(cellEl(idx));
    const newlyDone = completedWordsAt(idx).filter((w) => !wasDone.includes(w.dir));
    newlyDone.forEach((w) => X.fxGood(w.cells.map(cellEl)));
    sfx(newlyDone.length ? "word" : "type");

    if (checkSolved()) return;

    // Advance within current word to the next empty cell, or next cell in word, or next clue.
    const word = activeWord();
    if (word) {
      const pos = word.cells.indexOf(idx);
      let nextEmpty = -1;
      for (let k = pos + 1; k < word.cells.length; k++) {
        if (state.entries[word.cells[k]] === "") {
          nextEmpty = word.cells[k];
          break;
        }
      }
      if (nextEmpty >= 0) {
        state.cursor = nextEmpty;
      } else if (pos + 1 < word.cells.length) {
        state.cursor = word.cells[pos + 1];
      } else {
        stepClue(1);
        return;
      }
    }

    render();
    persist();
  }

  function handleBackspace() {
    if (!state || !state.puzzle || state.over) return;
    const idx = state.cursor;
    const isLocked = (i) => state.hinted[i] && state.entries[i] === state.puzzle.grid[i];

    if (state.entries[idx] !== "" && !isLocked(idx)) {
      state.entries[idx] = "";
      state.wrong[idx] = false;
      sfx("erase");
      render();
      persist();
      return;
    }

    const word = activeWord();
    if (word) {
      const pos = word.cells.indexOf(idx);
      if (pos > 0) {
        const prev = word.cells[pos - 1];
        state.cursor = prev;
        if (!isLocked(prev)) {
          state.entries[prev] = "";
          state.wrong[prev] = false;
        }
        render();
        persist();
      }
    }
  }

  function checkCurrentWord() {
    if (!state || !state.puzzle || state.over) return;
    const word = activeWord();
    if (!word) return;
    const filledCells = word.cells.filter((i) => state.entries[i] !== "");
    if (!filledCells.length) {
      S.showToast("Type some letters first");
      return;
    }
    ensureStarted();
    state.hints += 1;
    let errors = 0;
    for (const i of filledCells) {
      state.hinted[i] = true;
      if (state.entries[i] !== state.puzzle.grid[i]) {
        state.wrong[i] = true;
        errors++;
      } else {
        state.wrong[i] = false;
      }
    }
    S.showToast(errors ? `${errors} wrong letter${errors === 1 ? "" : "s"} marked` : "Word looks good!");
    sfx(errors ? "wrong" : "word");
    render();
    persist();
  }

  function revealCurrentCell() {
    if (!state || !state.puzzle || state.over) return;
    const idx = state.cursor;
    if (state.entries[idx] === state.puzzle.grid[idx] && state.hinted[idx]) {
      S.showToast("Already revealed");
      return;
    }
    ensureStarted();
    state.hints += 1;
    state.entries[idx] = state.puzzle.grid[idx];
    state.hinted[idx] = true;
    state.wrong[idx] = false;
    sfx("reveal");
    if (!checkSolved()) {
      render();
      persist();
    }
  }

  function revealCurrentWord() {
    if (!state || !state.puzzle || state.over) return;
    const word = activeWord();
    if (!word) return;
    ensureStarted();
    state.hints += 1;
    for (const i of word.cells) {
      state.entries[i] = state.puzzle.grid[i];
      state.hinted[i] = true;
      state.wrong[i] = false;
    }
    sfx("reveal");
    if (!checkSolved()) {
      render();
      persist();
    }
  }

  function checkSolved() {
    const { grid, total } = state.puzzle;
    for (let i = 0; i < total; i++) {
      if (grid[i] === ".") continue;
      if (state.entries[i] === "") return false;
    }
    // Every white square is filled - verify correctness.
    for (let i = 0; i < total; i++) {
      if (grid[i] !== "." && state.entries[i] !== grid[i]) {
        S.showToast("Almost! At least one square isn't quite right.");
        sfx("wrong");
        render();
        persist();
        return false;
      }
    }

    state.over = true;
    if (stopwatch) state.activeMs = stopwatch.stop();
    render();
    persist();
    const pz = state.puzzle;
    state.newUnlocks = X.recordWin({
      id: `${CFG.key}:${pz.id || state.index}`,
      clean: state.hints === 0,
      ms: Math.round(state.activeMs || 0),
      units: pz.whiteCount,
      sizeKey: `${CFG.key}:${pz.rows}x${pz.cols}`,
    });
    if (state.mode === "daily" && !state.submitted) submitResult();
    setTimeout(showResult, 350);
    return true;
  }

  // ---------- rendering ----------

  function buildBoardDOM() {
    const { rows, cols, grid, cellNums } = state.puzzle;
    els.board.style.setProperty("--cw-rows", rows);
    els.board.style.setProperty("--cw-cols", cols);
    els.board.classList.toggle("cw-midi", cols > 7 && cols <= 11);
    els.board.classList.toggle("cw-large", cols > 11);
    els.board.innerHTML = "";

    for (let i = 0; i < rows * cols; i++) {
      const cell = document.createElement("div");
      if (grid[i] === ".") {
        cell.className = "cw-cell block";
      } else {
        cell.className = "cw-cell";
        cell.dataset.idx = String(i);
        const num = cellNums[i];
        cell.innerHTML = `${num ? `<span class="cw-num">${num}</span>` : ""}<span class="cw-letter"></span>`;
        cell.addEventListener("click", () => selectCell(i));
      }
      els.board.appendChild(cell);
    }
  }

  function buildClueListsDOM() {
    if (!els.acrossList || !els.downList) return;
    const renderList = (container, words) => {
      container.innerHTML = "";
      words.forEach((w) => {
        const li = document.createElement("li");
        li.className = "cw-clue-item";
        li.dataset.dir = w.dir;
        li.dataset.num = String(w.num);
        li.innerHTML = `<span class="cw-clue-item-num">${w.num}.</span> <span class="cw-clue-item-text">${S.escapeHtml(w.clue)} <span class="cw-clue-len">(${w.cells.length})</span></span>`;
        li.addEventListener("click", () => {
          state.dir = w.dir;
          const empty = w.cells.find((i) => state.entries[i] === "");
          state.cursor = empty !== undefined ? empty : w.cells[0];
          render();
          persist();
        });
        container.appendChild(li);
      });
    };
    renderList(els.acrossList, state.puzzle.acrossWords);
    renderList(els.downList, state.puzzle.downWords);
  }

  function render() {
    if (!state || !state.puzzle) return;
    const word = activeWord();
    const inWord = new Set(word ? word.cells : []);

    const cells = els.board.querySelectorAll(".cw-cell:not(.block)");
    cells.forEach((cell) => {
      const i = Number(cell.dataset.idx);
      const letterEl = cell.querySelector(".cw-letter");
      letterEl.textContent = state.entries[i] || "";
      cell.classList.toggle("active", !state.over && i === state.cursor);
      cell.classList.toggle("in-word", !state.over && i !== state.cursor && inWord.has(i));
      cell.classList.toggle("hinted", !!state.hinted[i]);
      cell.classList.toggle("wrong", !!state.wrong[i]);
      cell.classList.toggle("solved", !!state.over);
    });

    if (word) {
      els.clueNum.textContent = `${word.num}${word.dir === "across" ? "A" : "D"}`;
      els.clueText.innerHTML = `${S.escapeHtml(word.clue)} <span class="cw-clue-len">(${word.cells.length})</span>`;
    }

    // Update desktop clue lists if present.
    if (els.acrossList && els.downList) {
      document.querySelectorAll(".cw-clue-item").forEach((li) => {
        const d = li.dataset.dir;
        const n = Number(li.dataset.num);
        const w = (d === "across" ? state.puzzle.acrossWords : state.puzzle.downWords).find((x) => x.num === n);
        const isCurrent = word && word.dir === d && word.num === n;
        li.classList.toggle("active", !!isCurrent);
        li.classList.toggle("done", !!(w && isWordFilled(w)));
        if (isCurrent) li.scrollIntoView({ block: "nearest" });
      });
    }

    const dirKey = els.keyboard && els.keyboard.querySelector('[data-key="dir"]');
    if (dirKey) dirKey.textContent = state.dir === "across" ? "ACR ⇄" : "DWN ⇅";
  }

  // ---------- keyboard ----------

  function buildKeyboard() {
    els.keyboard.innerHTML = "";
    KEYBOARD_ROWS.forEach((row) => {
      const rowEl = document.createElement("div");
      rowEl.className = "keyboard-row";
      row.forEach((key) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "key" + (key.length > 1 ? " wide" : "");
        btn.dataset.key = key;
        btn.textContent = key === "backspace" ? "⌫" : key === "dir" ? "ACR ⇄" : key;
        btn.addEventListener("click", () => {
          if (key === "backspace") handleBackspace();
          else if (key === "dir") flipDirection();
          else typeLetter(key);
        });
        rowEl.appendChild(btn);
      });
      els.keyboard.appendChild(rowEl);
    });
  }

  document.addEventListener("keydown", (e) => {
    if (S.anyModalOpen()) return;
    if (!state || !state.puzzle || !els.gate.classList.contains("hidden")) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === " ") {
      e.preventDefault();
      flipDirection();
    } else if (e.key === "Tab" || e.key === "Enter") {
      e.preventDefault();
      stepClue(e.shiftKey ? -1 : 1);
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      handleBackspace();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      moveByArrow(0, 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      moveByArrow(0, -1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      moveByArrow(1, 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveByArrow(-1, 0);
    } else if (/^[a-zA-Z]$/.test(e.key)) {
      e.preventDefault();
      typeLetter(e.key);
    }
  });

  // ---------- end of game, answers & share ----------

  async function submitResult() {
    const name = S.getPlayerName();
    if (!name || state.mode !== "daily" || !state.over) return;
    try {
      await S.postJSON(`/api/${CFG.key}/score`, {
        name,
        date: state.date,
        hints: state.hints,
        timeMs: Math.round(state.activeMs),
      });
      state.submitted = true;
      persist();
    } catch {
      // Kept unsubmitted so a reload can retry.
    }
  }

  function shareText() {
    const { rows, cols, grid } = state.puzzle;
    const head =
      state.mode === "daily"
        ? `${CFG.name} ${state.date} · ${S.formatTimer(state.activeMs)}${state.hints === 0 ? " ★" : ` (${state.hints} hint${state.hints === 1 ? "" : "s"})`}`
        : `${CFG.name} (practice) · ${S.formatTimer(state.activeMs)}`;

    // For mini grids (<=7x7), include an emoji representation of the board.
    if (cols <= 7) {
      const lines = [];
      for (let r = 0; r < rows; r++) {
        let rowStr = "";
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          rowStr += grid[i] === "." ? "⬛" : state.hinted[i] ? "🟦" : "🟩";
        }
        lines.push(rowStr);
      }
      return [head, ...lines].join("\n");
    }
    return `${head}\n"${state.puzzle.title}" by ${state.puzzle.author}`;
  }

  function showResult() {
    document.getElementById("result-title").textContent = state.hints === 0 ? "Flawless! ★" : "Solved!";
    document.getElementById("result-number").textContent = `${state.puzzle.title} · by ${state.puzzle.author}`;
    document.getElementById("result-stats").innerHTML = `
      <div class="result-stat">
        <span class="result-stat-label">Time</span>
        <span class="result-stat-value">${S.formatTimer(state.activeMs)}</span>
      </div>
      <div class="result-stat">
        <span class="result-stat-label">Hints</span>
        <span class="result-stat-value">${state.hints === 0 ? "0 ★" : state.hints}</span>
      </div>`;
    let unl = document.getElementById("locker-result");
    if (!unl) {
      unl = document.createElement("div");
      unl.id = "locker-result";
      document.getElementById("result-stats").insertAdjacentElement("afterend", unl);
    }
    unl.innerHTML = X.unlockBlurb(state.newUnlocks || []);

    const cd = document.getElementById("result-countdown");
    const again = document.getElementById("play-again-btn");
    if (countdownTimer) clearInterval(countdownTimer);
    if (state.mode === "daily") {
      const tick = () => (cd.textContent = S.formatCountdown(S.msUntilNextMidnight(), "puzzle"));
      tick();
      cd.classList.remove("hidden");
      again.classList.add("hidden");
      countdownTimer = setInterval(tick, 30000);
    } else {
      cd.classList.add("hidden");
      again.classList.remove("hidden");
      again.onclick = () => {
        S.closeModal("result-modal");
        startPractice(true);
      };
    }
    S.openModal("result-modal");
  }

  document.getElementById("share-btn").addEventListener("click", async () => {
    const text = shareText();
    try {
      await navigator.clipboard.writeText(text);
      S.showToast("Copied to clipboard");
    } catch {
      window.prompt("Copy your results:", text);
    }
  });

  function showAnswers(index, modalTitle, yours) {
    const p = hydratePuzzle(CFG.puzzles[index]);
    document.getElementById("answers-title").textContent = modalTitle;
    document.getElementById("answers-byline").textContent = `${p.title} · by ${p.author}`;
    const gridEl = document.getElementById("answers-grid");
    gridEl.style.setProperty("--cw-rows", p.rows);
    gridEl.style.setProperty("--cw-cols", p.cols);
    gridEl.classList.toggle("cw-large", p.cols > 7);
    gridEl.innerHTML = "";
    for (let i = 0; i < p.total; i++) {
      const cell = document.createElement("div");
      if (p.grid[i] === ".") {
        cell.className = "cw-cell block";
      } else {
        cell.className = "cw-cell";
        const n = p.cellNums[i];
        cell.innerHTML = `${n ? `<span class="cw-num">${n}</span>` : ""}<span class="cw-letter">${p.grid[i]}</span>`;
      }
      gridEl.appendChild(cell);
    }
    document.getElementById("answers-yours").textContent = yours;
    S.openModal("answers-modal");
  }

  els.extra.addEventListener("click", () => {
    if (!state || !state.puzzle) return;
    if (state.mode === "daily") {
      const yesterday = S.shiftDate(state.date, -1);
      const saved = S.load(KEYS.daily(yesterday)) || {};
      const yours = saved.over
        ? `You solved it in ${S.formatTimer(saved.activeMs || 0)}${saved.hints ? ` (${saved.hints} hint${saved.hints === 1 ? "" : "s"})` : " ★"}.`
        : "";
      showAnswers(puzzleIndexFor(yesterday), "Yesterday's Answers", yours);
    } else {
      showAnswers(state.index, "Answers", "");
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state && state.mode === "daily" && state.date !== S.todayDateString()) {
      startDaily();
    }
  });

  // ---------- leaderboard ----------

  let lbView = "today";
  let lbData = null;

  function renderLeaderboard() {
    const content = document.getElementById("leaderboard-content");
    if (!lbData) return;
    const t = (ms) => (Number.isFinite(ms) ? S.formatTimer(ms) : "—");
    const e = S.escapeHtml;
    if (lbView === "today") {
      S.renderTable(
        content,
        lbData.today,
        [
          { label: "Player", value: (r) => e(r.name) },
          { label: "Time", value: (r) => t(r.timeMs) },
          { label: "Hints", value: (r) => (r.hints === 0 ? "0 ★" : r.hints) },
        ],
        "Nobody has finished today's crossword yet — be the first!"
      );
    } else {
      S.renderTable(
        content,
        lbData.overall,
        [
          { label: "Player", value: (r) => e(r.name) },
          { label: "Solved", value: (r) => r.solved },
          { label: "Flawless ★", value: (r) => r.clean },
          { label: "Best Time", value: (r) => t(r.bestTimeMs) },
          { label: "Avg Time", value: (r) => t(r.avgTimeMs) },
          { label: "Streak", value: (r) => r.currentStreak },
          { label: "Best", value: (r) => r.maxStreak },
        ],
        "No games yet — be the first!"
      );
    }
  }

  async function loadLeaderboard() {
    const content = document.getElementById("leaderboard-content");
    content.innerHTML = '<p class="lb-status">Loading…</p>';
    try {
      lbData = await S.getJSON(`/api/${CFG.key}/leaderboard?date=${S.todayDateString()}`);
      renderLeaderboard();
    } catch {
      content.innerHTML = '<p class="lb-status">Leaderboard unavailable right now.</p>';
    }
  }

  document.getElementById("leaderboard-btn").addEventListener("click", () => {
    S.openModal("leaderboard-modal");
    loadLeaderboard();
  });

  document.querySelectorAll(".lb-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      lbView = btn.dataset.lbView;
      document.querySelectorAll(".lb-tab").forEach((b) => b.classList.toggle("active", b === btn));
      renderLeaderboard();
    });
  });

  // ---------- controls & wiring ----------

  els.cluePrev.addEventListener("click", () => stepClue(-1));
  els.clueNext.addEventListener("click", () => stepClue(1));
  els.clueBar.addEventListener("click", () => flipDirection());
  els.checkWord.addEventListener("click", () => checkCurrentWord());
  els.revealCell.addEventListener("click", () => revealCurrentCell());
  els.revealWord.addEventListener("click", () => revealCurrentWord());

  document.getElementById("help-btn").addEventListener("click", () => S.openModal("help-modal"));

  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (state && btn.dataset.mode === state.mode) return;
      if (btn.dataset.mode === "daily") startDaily();
      else startPractice(false);
    });
  });

  els.newGame.addEventListener("click", () => {
    if (state && state.mode === "practice") startPractice(true);
  });

  buildKeyboard();

  let archiveCtrl = null;
  S.initShell({
    onNameSaved() {
      if (state && state.mode === "daily" && !els.gate.classList.contains("hidden")) startDaily(state.date);
    },
  });
  if (S.initArchive) {
    archiveCtrl = S.initArchive({
      epoch: CFG.epoch,
      getStatus(d) {
        const s = S.load(KEYS.daily(d));
        if (!s || (!s.started && !s.over)) return { state: "none", detail: d };
        if (!s.over) return { state: "progress", detail: `${s.filled || 0}/${s.total || ""} filled` };
        return {
          state: "won",
          detail: `${S.formatTimer(s.activeMs || 0)}${s.hints ? ` · ${s.hints} hint${s.hints === 1 ? "" : "s"}` : " ★"}`,
        };
      },
      onSelectDate(d) {
        startDaily(d);
      },
    });
  }

  // ---------- puzzle library: browse every puzzle by its original publish date ----------
  function puzzlePublished(p) {
    const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(p.id || "");
    if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);
    const us = /\((\d{1,2})\/(\d{1,2})\/(\d{4})\)/.exec(p.title || "");
    if (us) return new Date(+us[3], +us[1] - 1, +us[2]);
    return null;
  }

  function startLibrary(index) {
    teardown();
    setMode("practice");
    hideGate();
    const saved = S.load(KEYS.practice);
    loadPuzzle("practice", null, index, saved && saved.index === index && !saved.over ? saved : {});
  }

  (function initLibrary() {
    const row = document.querySelector(".controls-row");
    if (!row || document.getElementById("library-btn")) return;
    const e = S.escapeHtml;
    const items = CFG.puzzles
      .map((p, i) => ({ i, p, d: puzzlePublished(p) }))
      .sort((a, b) => (b.d ? b.d.getTime() : -Infinity) - (a.d ? a.d.getTime() : -Infinity) || a.i - b.i);
    const fmt = (d) => d.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    items.forEach((it) => {
      it.dateText = it.d ? fmt(it.d) : `Puzzle #${it.i + 1}`;
      it.search = `${it.dateText} ${it.p.title || ""} ${it.p.author || ""}`.toLowerCase();
    });

    document.body.insertAdjacentHTML(
      "beforeend",
      `<div id="library-modal" class="modal-overlay hidden">
        <div class="modal modal-wide">
          <button class="modal-close" data-close="library-modal" aria-label="Close">&times;</button>
          <h2>Puzzle Library</h2>
          <p class="archive-sub">All ${items.length} puzzles in this collection${items.some((x) => x.d) ? ", newest first, with the date each was first published" : ""}. Tap one to play it.</p>
          <input id="library-search" class="library-search" type="search" placeholder="Search by date, title or author" autocomplete="off">
          <div id="library-list" class="library-list"></div>
        </div>
      </div>`
    );
    const modal = document.getElementById("library-modal");
    const list = document.getElementById("library-list");
    const search = document.getElementById("library-search");
    modal.querySelector(".modal-close").addEventListener("click", () => S.closeModal("library-modal"));
    modal.addEventListener("click", (ev) => {
      if (ev.target === modal) S.closeModal("library-modal");
    });

    function render() {
      const q = search.value.trim().toLowerCase();
      const shown = q ? items.filter((it) => it.search.includes(q)) : items;
      list.innerHTML = shown.length
        ? shown
            .map(
              (it) => `<button type="button" class="library-item${state && state.index === it.i ? " active" : ""}" data-i="${it.i}">
                <span class="library-date">${e(it.dateText)}</span>
                <span class="library-title">${e(it.p.title || "")}${it.p.author ? ` &middot; by ${e(it.p.author)}` : ""}</span>
              </button>`
            )
            .join("")
        : `<p class="lb-status">No puzzles match &ldquo;${e(q)}&rdquo;.</p>`;
    }
    search.addEventListener("input", render);
    list.addEventListener("click", (ev) => {
      const btn = ev.target.closest(".library-item");
      if (!btn) return;
      S.closeModal("library-modal");
      startLibrary(Number(btn.dataset.i));
    });

    const btn = document.createElement("button");
    btn.id = "library-btn";
    btn.type = "button";
    btn.className = "icon-btn labeled-btn";
    btn.title = "Puzzle library";
    btn.setAttribute("aria-label", "Puzzle library by publish date");
    btn.innerHTML = '<span class="btn-icon" aria-hidden="true">&#128218;</span><span class="btn-label">Library</span>';
    btn.addEventListener("click", () => {
      search.value = "";
      render();
      S.openModal("library-modal");
      const active = list.querySelector(".library-item.active");
      if (active) active.scrollIntoView({ block: "center" });
    });
    const lb = document.getElementById("leaderboard-btn");
    if (lb && lb.parentNode === row) row.insertBefore(btn, lb);
    else row.appendChild(btn);
  })();


  // ---------- printing: clean paper copy of the current puzzle (+ optional answer key) ----------
  function gridSvg(puzzle, withAnswers, maxIn) {
    const { rows, cols, grid, cellNums } = puzzle;
    const cs = 40;
    const w = cols * cs;
    const h = rows * cs;
    let out = `<svg class="ps-grid" viewBox="-2 -2 ${w + 4} ${h + 4}" style="width:min(100%, ${maxIn}in)" xmlns="http://www.w3.org/2000/svg">`;
    for (let r = 0; r < rows; r++) {
      for (let col = 0; col < cols; col++) {
        const i = r * cols + col;
        const x = col * cs;
        const y = r * cs;
        const block = grid[i] === ".";
        out += `<rect x="${x}" y="${y}" width="${cs}" height="${cs}" fill="${block ? "#000" : "#fff"}" stroke="#000" stroke-width="1.5"/>`;
        if (!block && cellNums[i]) out += `<text x="${x + 2.5}" y="${y + 11}" font-size="10.5" font-family="Arial, sans-serif" fill="#000">${cellNums[i]}</text>`;
        if (!block && withAnswers) out += `<text x="${x + cs / 2}" y="${y + cs * 0.78}" font-size="22" font-weight="700" text-anchor="middle" font-family="Arial, sans-serif" fill="#000">${grid[i]}</text>`;
      }
    }
    out += `<rect x="0" y="0" width="${w}" height="${h}" fill="none" stroke="#000" stroke-width="3"/></svg>`;
    return out;
  }

  // Newspaper-style grid: hairline cells, heavy outer rule, small Helvetica numbers, solid blocks.
  function newsGridSvg(puzzle, withAnswers, maxIn) {
    const { rows, cols, grid, cellNums } = puzzle;
    const cs = 40;
    const w = cols * cs;
    const h = rows * cs;
    let out = `<svg class="pn-grid" viewBox="-2 -2 ${w + 4} ${h + 4}" style="width:min(100%, ${maxIn}in)" xmlns="http://www.w3.org/2000/svg">`;
    for (let r = 0; r < rows; r++) {
      for (let col = 0; col < cols; col++) {
        const i = r * cols + col;
        const x = col * cs;
        const y = r * cs;
        if (grid[i] === ".") {
          out += `<rect x="${x}" y="${y}" width="${cs}" height="${cs}" fill="#000"/>`;
          continue;
        }
        out += `<rect x="${x}" y="${y}" width="${cs}" height="${cs}" fill="#fff" stroke="#000" stroke-width="1"/>`;
        if (cellNums[i] && !withAnswers) out += `<text x="${x + 2}" y="${y + 10}" font-size="9.5" font-family="Helvetica, Arial, sans-serif" fill="#000">${cellNums[i]}</text>`;
        if (withAnswers) out += `<text x="${x + cs / 2}" y="${y + cs * 0.76}" font-size="24" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" fill="#000">${grid[i]}</text>`;
      }
    }
    out += `<rect x="0" y="0" width="${w}" height="${h}" fill="none" stroke="#000" stroke-width="3.5"/></svg>`;
    return out;
  }

  function newsDateTag(d) {
    return d ? `${d.getMonth() + 1}-${d.getDate()}` : "";
  }

  function newspaperSheet(pz, withAnswers, pub) {
    const e = S.escapeHtml;
    const author = (pz.author || "").toUpperCase();
    const clueList = (words) => words.map((wd) => `<li><b>${wd.num}</b><span>${e(wd.clue)}</span></li>`).join("");
    const big = pz.cols > 9;
    const tag = newsDateTag(pub);
    let html = `
      <div class="ps-page pn-page">
        <div class="pn-head">
          <div class="pn-title">CROSSWORD</div>
          ${author ? `<div class="pn-by">By ${e(author)}</div>` : ""}
          <div class="pn-name">Name ______________________</div>
        </div>
        <div class="pn-clues">
          <h3>ACROSS</h3><ol>${clueList(pz.acrossWords)}</ol>
          <h3>DOWN</h3><ol>${clueList(pz.downWords)}</ol>
        </div>
        <div class="pn-gridwrap">${newsGridSvg(pz, false, big ? 6.6 : 4.6)}<div class="pn-tag">${e(tag)}</div></div>
      </div>`;
    if (withAnswers) {
      html += `
      <div class="ps-page pn-page pn-answers">
        <div class="pn-head"><div class="pn-title">CROSSWORD</div>${author ? `<div class="pn-by">By ${e(author)}</div>` : ""}</div>
        <div class="pn-gridwrap pn-keywrap">${newsGridSvg(pz, true, big ? 6.6 : 4.6)}
          <div class="pn-keycap">${pub ? `${e(pub.toLocaleDateString(undefined, { weekday: "long" }))}'s answer` : "Answer"}</div>
        </div>
      </div>`;
    }
    return html;
  }

  function printStyle() {
    try {
      return localStorage.getItem("crossy:printStyle") === "classic" ? "classic" : "newspaper";
    } catch {
      return "newspaper";
    }
  }

  function printPuzzle(withAnswers) {
    if (!state || !state.puzzle) return;
    const pz = state.puzzle;
    const e = S.escapeHtml;
    if (printStyle() === "newspaper") {
      const pubN = typeof puzzlePublished === "function" ? puzzlePublished(pz) : null;
      let sheetN = document.getElementById("print-sheet");
      if (!sheetN) {
        sheetN = document.createElement("div");
        sheetN.id = "print-sheet";
        document.body.appendChild(sheetN);
      }
      sheetN.className = "pn";
      sheetN.innerHTML = newspaperSheet(pz, withAnswers, pubN);
      S.closeModal("print-modal");
      setTimeout(() => window.print(), 50);
      return;
    }
    const pub = typeof puzzlePublished === "function" ? puzzlePublished(pz) : null;
    const pubText = pub ? pub.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" }) : "";
    const big = pz.cols > 9;
    const clueList = (words) =>
      words.map((wd) => `<li><b>${wd.num}</b> ${e(wd.clue)} <span class="ps-len">(${wd.cells.length})</span></li>`).join("");
    let sheet = document.getElementById("print-sheet");
    if (!sheet) {
      sheet = document.createElement("div");
      sheet.id = "print-sheet";
      document.body.appendChild(sheet);
    }
    sheet.className = "";
    sheet.innerHTML = `
      <div class="ps-page">
        <div class="ps-head">
          <div class="ps-brand">Ducky Dailies &middot; ${e(CFG.name || "Crossword")}</div>
          <div class="ps-title">${e(pz.title || "")}${pz.author ? ` &middot; by ${e(pz.author)}` : ""}</div>
          ${pubText ? `<div class="ps-pub">First published ${e(pubText)}</div>` : ""}
          <div class="ps-name">Name: ______________________ &nbsp; Date: ____________</div>
        </div>
        <div class="ps-gridwrap">${gridSvg(pz, false, big ? 6.4 : 4.2)}</div>
        <div class="ps-clues">
          <div class="ps-col"><h3>Across</h3><ol>${clueList(pz.acrossWords)}</ol></div>
          <div class="ps-col"><h3>Down</h3><ol>${clueList(pz.downWords)}</ol></div>
        </div>
      </div>
      ${
        withAnswers
          ? `<div class="ps-page ps-answers">
              <div class="ps-head"><div class="ps-brand">Answer key</div><div class="ps-title">${e(pz.title || "")}</div></div>
              <div class="ps-gridwrap">${gridSvg(pz, true, big ? 6.4 : 4.2)}</div>
            </div>`
          : ""
      }`;
    S.closeModal("print-modal");
    setTimeout(() => window.print(), 50);
  }

  (function initPrint() {
    const row = document.querySelector(".controls-row");
    if (!row || document.getElementById("print-btn")) return;
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div id="print-modal" class="modal-overlay hidden">
        <div class="modal">
          <button class="modal-close" data-close="print-modal" aria-label="Close">&times;</button>
          <h2>Print this puzzle</h2>
          <p class="archive-sub">Prints a clean copy of the puzzle on screen: big grid, all the clues, room for your name.</p>
          <div class="print-choices">
            <button id="print-plain" class="donate-btn print-choice" type="button">&#128424;&#65039; Print puzzle</button>
            <button id="print-key" class="pill-btn print-choice" type="button">Print puzzle + answer key</button>
          </div>
          <p class="donate-note">The answer key prints on its own page, so you can keep it separate.</p>
          <label class="print-style-row"><input id="print-style-news" type="checkbox" /> Newspaper style (like the Salem News page)</label>
        </div>
      </div>`
    );
    const styleBox = document.getElementById("print-style-news");
    styleBox.checked = printStyle() === "newspaper";
    styleBox.addEventListener("change", () => {
      try {
        localStorage.setItem("crossy:printStyle", styleBox.checked ? "newspaper" : "classic");
      } catch {
        // ignore
      }
    });
    const modal = document.getElementById("print-modal");
    modal.querySelector(".modal-close").addEventListener("click", () => S.closeModal("print-modal"));
    modal.addEventListener("click", (ev) => {
      if (ev.target === modal) S.closeModal("print-modal");
    });
    document.getElementById("print-plain").addEventListener("click", () => printPuzzle(false));
    document.getElementById("print-key").addEventListener("click", () => printPuzzle(true));

    const btn = document.createElement("button");
    btn.id = "print-btn";
    btn.type = "button";
    btn.className = "icon-btn labeled-btn";
    btn.title = "Print";
    btn.setAttribute("aria-label", "Print this puzzle");
    btn.innerHTML = '<span class="btn-icon" aria-hidden="true">&#128424;&#65039;</span><span class="btn-label">Print</span>';
    btn.addEventListener("click", () => {
      if (!state || !state.puzzle) {
        S.showToast("Enter your name first to load a puzzle");
        return;
      }
      S.openModal("print-modal");
    });
    const lib = document.getElementById("library-btn");
    if (lib && lib.parentNode === row) row.insertBefore(btn, lib);
    else row.appendChild(btn);
  })();

  // Sound, effects and the Locker live in common.js (window.Extras), shared by every game.
  const X = window.Extras;
  X.mount({ game: "crossy", name: CFG.name || "Crossy" });
  const sfx = (ev) => X.sfx(ev);
  function cellEl(i) {
    return els.board.querySelector(`.cw-cell[data-idx="${i}"]`);
  }
  // words containing idx that are fully and correctly filled
  function completedWordsAt(idx) {
    return [wordAt(idx, "across"), wordAt(idx, "down")].filter(
      (w) => w && w.cells.every((i) => state.entries[i] === state.puzzle.grid[i])
    );
  }

  // ---------- Guided Look: ranked fills for the current word from the letters you have ----------
  let guideWords = null;
  let guideLoading = null;
  function loadGuideWords() {
    if (guideWords) return Promise.resolve(guideWords);
    if (guideLoading) return guideLoading;
    guideLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "/words-guide.js?v=1";
      s.onload = () => {
        const raw = window.CROSSY_GUIDE_WORDS || {};
        guideWords = {};
        Object.entries(raw).forEach(([len, buckets]) => {
          guideWords[len] = [];
          buckets.forEach(([z, words]) => words.split(" ").forEach((w) => guideWords[len].push([w.toUpperCase(), z / 10])));
        });
        resolve(guideWords);
      };
      s.onerror = () => {
        guideLoading = null;
        reject(new Error("Couldn't load the word list"));
      };
      document.head.appendChild(s);
    });
    return guideLoading;
  }

  // Answers (and their clues) from every other puzzle in this collection: crossword vocabulary repeats a lot.
  let pastIndex = null;
  function buildPastIndex() {
    if (pastIndex) return pastIndex;
    pastIndex = new Map();
    const curId = state.puzzle.id;
    CFG.puzzles.forEach((raw) => {
      if (!raw || raw.id === curId) return;
      let pz;
      try {
        pz = hydratePuzzle(raw);
      } catch {
        return;
      }
      [...pz.acrossWords, ...pz.downWords].forEach((w) => {
        const ans = w.cells.map((i) => pz.grid[i]).join("");
        if (!pastIndex.has(ans)) pastIndex.set(ans, []);
        pastIndex.get(ans).push(w.clue);
      });
    });
    return pastIndex;
  }
  const clueWords = (c) => new Set(String(c).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((t) => t.length > 2));
  function clueSimilarity(a, b) {
    const A = clueWords(a);
    const B = clueWords(b);
    if (!A.size || !B.size) return 0;
    let n = 0;
    A.forEach((t) => B.has(t) && n++);
    return n / Math.min(A.size, B.size);
  }

  function guideFor(word) {
    const pattern = word.cells.map((i) => state.entries[i] || "");
    const answer = word.cells.map((i) => state.puzzle.grid[i]).join("");
    const fits = (w) => pattern.every((ch, k) => !ch || w[k] === ch);
    const list = (guideWords[String(pattern.length)] || []).filter(([w]) => fits(w));
    const seen = new Set(list.map(([w]) => w));
    // The real fill can be a phrase or proper noun the dictionary lacks; if your letters allow it, give it a middling score.
    if (fits(answer) && !seen.has(answer)) {
      const mid = list.length ? list[Math.floor(list.length / 2)][1] : 2.5;
      list.push([answer, Math.max(2, mid)]);
    }
    const past = buildPastIndex();
    const weigh = ([w, z]) => {
      let m = 1;
      let tag = "";
      const clues = past.get(w);
      if (clues) {
        const sim = Math.max(...clues.map((c) => clueSimilarity(c, word.clue)));
        if (sim >= 0.5) { m = 60; tag = "similar clue before"; }
        else { m = 4; tag = "past answer"; }
      }
      return { w, raw: 10 ** z * m, tag };
    };
    const scored = list.map(weigh);
    const total = scored.reduce((s, x) => s + x.raw, 0) || 1;
    const ranked = scored.map((x) => ({ ...x, p: x.raw / total })).sort((a, b) => b.p - a.p);
    let top = ranked.slice(0, 8);
    if (fits(answer) && !top.some((x) => x.w === answer)) top = [...top.slice(0, 7), ranked.find((x) => x.w === answer)].sort((a, b) => b.p - a.p);
    // letter odds for each empty square across every candidate
    const odds = pattern.map((ch, k) => {
      if (ch) return null;
      const m = {};
      ranked.forEach(({ w, p }) => (m[w[k]] = (m[w[k]] || 0) + p));
      const best = Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 3);
      const sum = Object.values(m).reduce((s, v) => s + v, 0) || 1;
      return best.map(([l, v]) => [l, v / sum]);
    });
    return { pattern, top, odds, count: ranked.length, answerFits: fits(answer) };
  }

  function guideKey(word) {
    return `${word.dir}:${word.num}`;
  }

  async function openGuide() {
    if (!state || !state.puzzle || state.over) return;
    const word = activeWord();
    if (!word) return;
    const body = document.getElementById("guide-body");
    document.getElementById("guide-title").textContent = `${word.num} ${word.dir === "across" ? "Across" : "Down"}: ${word.clue}`;
    body.innerHTML = `<p class="guide-note">Loading word list…</p>`;
    S.openModal("guide-modal");
    try {
      await loadGuideWords();
    } catch (err) {
      body.innerHTML = `<p class="guide-note">${S.escapeHtml(err.message)}</p>`;
      return;
    }
    state.guided = state.guided || {};
    if (!state.guided[guideKey(word)]) {
      state.guided[guideKey(word)] = true;
      state.hints += 1;
      persist();
    }
    const g = guideFor(word);
    const e = S.escapeHtml;
    const pct = (p) => (p >= 0.995 ? "99%" : p < 0.005 ? "<1%" : `${Math.round(p * 100)}%`);
    const patternHtml = g.pattern.map((ch) => `<span class="guide-sq ${ch ? "have" : ""}">${ch || ""}</span>`).join("");
    const oddsHtml = g.odds
      .map((o) => `<span class="guide-odd">${o ? o.map(([l, p]) => `<b>${l}</b>${pct(p)}`).join("<br>") : "&nbsp;"}</span>`)
      .join("");
    const rows = g.top
      .map(({ w, p, tag }) => `<li><span class="guide-word">${w.split("").map((ch, k) => `<i class="${g.pattern[k] ? "have" : ""}">${ch}</i>`).join("")}</span><span class="guide-bar"><span style="width:${Math.max(2, Math.round(p * 100))}%"></span></span><span class="guide-p">${pct(p)}</span>${tag ? `<span class="guide-tag">&#128240; ${tag}</span>` : ""}</li>`)
      .join("");
    const filled = g.pattern.filter(Boolean).length;
    body.innerHTML = `
      <div class="guide-pattern">${patternHtml}</div>
      ${g.count ? `<div class="guide-odds">${oddsHtml}</div>` : ""}
      ${g.count ? `<ol class="guide-list">${rows}</ol>` : ""}
      <p class="guide-note">${
        !g.count
          ? "Nothing in the word list fits those letters. One of them is probably wrong. Check the crossings."
          : !g.answerFits
            ? `${g.count} word${g.count === 1 ? "" : "s"} fit your letters, but none may be the answer: a letter you've entered could be wrong.`
            : `${g.count.toLocaleString()} word${g.count === 1 ? "" : "s"} fit the ${filled} letter${filled === 1 ? "" : "s"} you have. If your letters are right, the answer is always somewhere in this list. Odds blend how common each word is with answers from your other puzzles (&#128240;); they don't read the clue.${filled === 0 ? " Fill in a crossing or two and the list gets much sharper." : ""}`
      }</p>
      <p class="guide-cost">Guided Look counts as one hint for this word (opening it again is free).</p>`;
    sfx("reveal");
  }

  (function initGuide() {
    const btn = document.createElement("button");
    btn.id = "guide-btn";
    btn.type = "button";
    btn.textContent = "Guided Look";
    btn.title = "Ranked words that fit the letters you have (counts as a hint)";
    btn.addEventListener("click", openGuide);
    const anchor = els.revealWord || els.checkWord;
    if (anchor && anchor.parentNode) {
      btn.className = anchor.className;
      anchor.parentNode.insertBefore(btn, anchor.nextSibling);
    } else {
      const row = document.querySelector(".controls-row");
      btn.className = "icon-btn labeled-btn";
      if (row) row.appendChild(btn);
    }
  })();

  S.wireNameGate(() => startDaily(state && state.date));

  let startMode = "daily";
  try {
    const qMode = new URLSearchParams(window.location.search).get("mode");
    if (qMode === "practice" || qMode === "daily") startMode = qMode;
    else startMode = localStorage.getItem(KEYS.mode) === "practice" ? "practice" : "daily";
  } catch {
    // ignore
  }
  if (startMode === "practice") startPractice(false);
  else startDaily();
})();
