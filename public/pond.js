// Word Pond: crossword-style word game against Quackers.
(() => {
  "use strict";

  const S = Shared;
  const E = PondEngine;
  const N = E.N;
  const SAVE_KEY = "pond:game";
  const STATS_KEY = "pond:stats";
  const HINTS_PER_GAME = 3;

  const $ = (id) => document.getElementById(id);
  const els = {
    board: $("wp-board"), rack: $("wp-rack"), status: $("wp-status"),
    you: $("wp-you"), ai: $("wp-ai"), level: $("wp-level"),
    cardYou: $("wp-score-you"), cardAi: $("wp-score-ai"),
    play: $("wp-play"), recall: $("wp-recall"), shuffle: $("wp-shuffle"),
    hint: $("wp-hint"), swap: $("wp-swap"), pass: $("wp-pass"),
    bag: $("wp-bag"), log: $("wp-log"),
  };

  let dict = null;
  let G = null; // saved game
  let pending = []; // [{r, c, l, blank, rackIndex}]
  let selRack = -1; // selected rack index
  let cursor = null; // {r, c, across}
  let busy = false; // Quackers is thinking

  // ---------- Quackers ----------
  const mascotEl = $("jb-mascot");
  const bubbleEl = $("jb-bubble");
  let moodTimer = null, talkTimer = null;
  function say(mood, line, ms = 3200) {
    if (!mascotEl) return;
    mascotEl.className = `jb-mascot wp-mascot mood-${mood}`;
    void mascotEl.offsetWidth;
    mascotEl.classList.add("bump");
    if (line) {
      bubbleEl.textContent = line;
      bubbleEl.classList.remove("hidden");
      mascotEl.classList.add("talking");
      clearTimeout(talkTimer);
      talkTimer = setTimeout(() => mascotEl.classList.remove("talking"), Math.min(2400, 450 + line.length * 45));
    }
    clearTimeout(moodTimer);
    if (ms) moodTimer = setTimeout(() => { mascotEl.className = "jb-mascot wp-mascot mood-idle"; bubbleEl.classList.add("hidden"); }, ms);
  }
  const pickOne = (a) => a[Math.floor(Math.random() * a.length)];

  // ---------- game state ----------
  function rng() { return Math.random(); }

  function newGame(level) {
    const bag = E.newBag(rng);
    G = {
      level,
      board: E.emptyBoard(),
      bag,
      racks: { you: bag.splice(0, 7), ai: bag.splice(0, 7) },
      scores: { you: 0, ai: 0 },
      turn: "you",
      scoreless: 0,
      hints: HINTS_PER_GAME,
      log: [],
      lastMove: [],
      over: false,
      started: Date.now(),
    };
    pending = []; selRack = -1; cursor = null;
    save();
    render();
    say("happy", pickOne(["Quack! Let's play!", "Good luck! You'll need it!", "My turn's after yours!"]));
  }

  function save() { S.save(SAVE_KEY, G); }

  function loadSaved() {
    const g = S.load(SAVE_KEY);
    if (!g || !g.board || !g.racks) return false;
    G = g;
    if (G.hints === undefined) G.hints = HINTS_PER_GAME;
    return true;
  }

  function rackValue(rack) { return rack.reduce((t, l) => t + (E.POINTS[l] || 0), 0); }

  // ---------- rendering ----------
  function cellTile(r, c) {
    const p = pending.find((x) => x.r === r && x.c === c);
    if (p) return { l: p.l, blank: p.blank, pending: true };
    return G.board[r][c];
  }

  function tileHtml(t) {
    const pts = t.blank ? "" : E.POINTS[t.l];
    return `<span class="wp-l">${t.l.toUpperCase()}</span><span class="wp-p">${pts}</span>`;
  }

  function renderBoard() {
    const last = new Set((G.lastMove || []).map((p) => p.r * N + p.c));
    let html = "";
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const t = cellTile(r, c);
        const prem = E.PREMIUM[r][c];
        const isCenter = r === E.CENTER && c === E.CENTER;
        const cls = ["wp-cell"];
        if (t) {
          cls.push("has-tile");
          if (t.pending) cls.push("pending");
          if (t.blank) cls.push("blank-tile");
          if (last.has(r * N + c)) cls.push("last");
        } else if (prem) cls.push(`p-${prem}`);
        if (isCenter && !t) cls.push("center");
        if (cursor && cursor.r === r && cursor.c === c) cls.push(cursor.across ? "cursor-a" : "cursor-d");
        const label = t ? "" : isCenter ? "&#9733;" : prem;
        html += `<button type="button" class="${cls.join(" ")}" data-r="${r}" data-c="${c}">${t ? tileHtml(t) : `<span class="wp-prem">${label}</span>`}</button>`;
      }
    }
    els.board.innerHTML = html;
  }

  function renderRack() {
    const used = new Set(pending.map((p) => p.rackIndex));
    els.rack.innerHTML = G.racks.you
      .map((l, i) => {
        const cls = ["wp-tile"];
        if (used.has(i)) cls.push("used");
        if (i === selRack) cls.push("selected");
        if (l === "?") cls.push("blank-tile");
        return `<button type="button" class="${cls.join(" ")}" data-i="${i}" ${used.has(i) ? "disabled" : ""} aria-label="${l === "?" ? "blank" : l.toUpperCase()}">${
          l === "?" ? `<span class="wp-l">&nbsp;</span>` : tileHtml({ l })
        }</button>`;
      })
      .join("");
  }

  function renderScores() {
    els.you.textContent = G.scores.you;
    els.ai.textContent = G.scores.ai;
    els.level.textContent = `(${G.level})`;
    els.cardYou.classList.toggle("active", !G.over && G.turn === "you");
    els.cardAi.classList.toggle("active", !G.over && G.turn === "ai");
    els.bag.textContent = `${G.bag.length} tile${G.bag.length === 1 ? "" : "s"} left in the bag · Quackers has ${G.racks.ai.length} tiles`;
  }

  function renderLog() {
    els.log.innerHTML = G.log
      .slice(-6)
      .reverse()
      .map((e) => `<li>${S.escapeHtml(e)}</li>`)
      .join("");
  }

  function renderControls() {
    const myTurn = !G.over && G.turn === "you" && !busy;
    let ev = null;
    if (pending.length) ev = E.evaluate(G.board, pending, dict);
    els.play.disabled = !myTurn || !ev || !ev.ok;
    els.play.textContent = ev && ev.ok ? `Play ${ev.main.toUpperCase()} · ${ev.score} pts` : "Play";
    els.recall.disabled = !pending.length;
    els.shuffle.disabled = !myTurn;
    els.hint.disabled = !myTurn || G.hints <= 0;
    els.hint.textContent = `💡 Hint (${G.hints} left)`;
    els.swap.disabled = !myTurn || G.bag.length < 7;
    els.pass.disabled = !myTurn;
    if (G.over) els.status.textContent = "Game over — tap ↻ New game to play again.";
    else if (busy) els.status.textContent = "Quackers is thinking…";
    else if (pending.length && ev && !ev.ok) els.status.textContent = ev.error;
    else if (pending.length && ev && ev.ok) els.status.textContent = `${ev.words.map((w) => `${w.word.toUpperCase()} (${w.score})`).join(" + ")}${ev.bingo ? " + 40 bonus!" : ""}`;
    else if (selRack >= 0) els.status.textContent = "Now tap a square on the board.";
    else els.status.textContent = "Your turn — tap a tile, then a square.";
  }

  function render() {
    renderBoard();
    renderRack();
    renderScores();
    renderLog();
    renderControls();
  }

  // ---------- placing tiles ----------
  let blankTarget = null;
  function placeAt(r, c, rackIndex) {
    const l = G.racks.you[rackIndex];
    if (l === "?") {
      blankTarget = { r, c, rackIndex };
      S.openModal("blank-modal");
      return;
    }
    pending.push({ r, c, l, blank: false, rackIndex });
    S.sfx("place");
    afterPlace(r, c);
  }

  function afterPlace(r, c) {
    selRack = -1;
    X.sfx("tap");
    if (cursor && cursor.r === r && cursor.c === c) {
      // move the typing cursor along to the next empty square
      let { r: y, c: x } = cursor;
      do { if (cursor.across) x++; else y++; } while (y < N && x < N && cellTile(y, x));
      cursor = y < N && x < N ? { r: y, c: x, across: cursor.across } : null;
    }
    render();
  }

  function takeBack(r, c) {
    const i = pending.findIndex((p) => p.r === r && p.c === c);
    if (i >= 0) { pending.splice(i, 1); S.sfx("tap"); }
    render();
  }

  function recallAll() {
    pending = [];
    selRack = -1;
    render();
  }

  els.board.addEventListener("click", (e) => {
    const cell = e.target.closest(".wp-cell");
    if (!cell || G.over || busy || G.turn !== "you") return;
    const r = +cell.dataset.r, c = +cell.dataset.c;
    if (pending.some((p) => p.r === r && p.c === c)) { takeBack(r, c); return; }
    if (G.board[r][c]) return;
    if (selRack >= 0) { placeAt(r, c, selRack); return; }
    // no tile selected: set / flip the typing cursor
    if (cursor && cursor.r === r && cursor.c === c) cursor.across = !cursor.across;
    else cursor = { r, c, across: true };
    renderBoard();
    els.status.textContent = "Tap one of your tiles to put it here" + (window.matchMedia("(pointer: fine)").matches ? ", or type a letter." : ".");
  });

  els.rack.addEventListener("click", (e) => {
    const t = e.target.closest(".wp-tile");
    if (!t || G.over || busy || G.turn !== "you") return;
    const i = +t.dataset.i;
    if (cursor && !cellTile(cursor.r, cursor.c)) { placeAt(cursor.r, cursor.c, i); return; }
    selRack = selRack === i ? -1 : i;
    S.sfx("tap");
    renderRack();
    renderControls();
  });

  // blank letter picker
  $("wp-blank-grid").innerHTML = "abcdefghijklmnopqrstuvwxyz"
    .split("")
    .map((ch) => `<button type="button" class="wp-tile" data-l="${ch}"><span class="wp-l">${ch.toUpperCase()}</span></button>`)
    .join("");
  $("wp-blank-grid").addEventListener("click", (e) => {
    const b = e.target.closest("[data-l]");
    if (!b || !blankTarget) return;
    const { r, c, rackIndex } = blankTarget;
    blankTarget = null;
    S.closeModal("blank-modal");
    pending.push({ r, c, l: b.dataset.l, blank: true, rackIndex });
    S.sfx("place");
    afterPlace(r, c);
  });

  // keyboard (computers)
  document.addEventListener("keydown", (e) => {
    if (S.anyModalOpen() || e.ctrlKey || e.metaKey || e.altKey || !G || G.over || busy || G.turn !== "you") return;
    if (e.key === "Enter") { if (!els.play.disabled) { e.preventDefault(); playTurn(); } return; }
    if (e.key === "Escape") { recallAll(); return; }
    if (e.key === "Backspace") {
      e.preventDefault();
      const last = pending[pending.length - 1];
      if (last) { pending.pop(); cursor = { r: last.r, c: last.c, across: cursor ? cursor.across : true }; render(); }
      return;
    }
    if (!cursor || !/^[a-zA-Z]$/.test(e.key)) return;
    const ch = e.key.toLowerCase();
    const used = new Set(pending.map((p) => p.rackIndex));
    let i = G.racks.you.findIndex((l, idx) => l === ch && !used.has(idx));
    let blank = false;
    if (i < 0) { i = G.racks.you.findIndex((l, idx) => l === "?" && !used.has(idx)); blank = i >= 0; }
    if (i < 0) { S.showToast(`You don't have a ${ch.toUpperCase()}`); return; }
    if (cellTile(cursor.r, cursor.c)) return;
    pending.push({ r: cursor.r, c: cursor.c, l: ch, blank, rackIndex: i });
    S.sfx("place");
    afterPlace(cursor.r, cursor.c);
  });

  // ---------- turns ----------
  function drawTiles(who) {
    const rack = G.racks[who];
    while (rack.length < E.RACK && G.bag.length) rack.push(G.bag.pop());
  }

  function applyMove(who, placements) {
    const rack = G.racks[who];
    for (const p of placements) {
      G.board[p.r][p.c] = { l: p.l, blank: !!p.blank };
      const idx = rack.indexOf(p.blank ? "?" : p.l);
      if (idx >= 0) rack.splice(idx, 1);
    }
    G.lastMove = placements.map((p) => ({ r: p.r, c: p.c }));
    drawTiles(who);
  }

  function playTurn() {
    if (G.turn !== "you" || busy || !pending.length) return;
    const ev = E.evaluate(G.board, pending, dict);
    if (!ev.ok) {
      S.sfx("wrong");
      say("sad", ev.badWord ? `Hmm, I don't think ${ev.badWord.toUpperCase()} is a word…` : ev.error);
      return;
    }
    // remove by rack index (highest first) so blanks/duplicates come off correctly
    const placed = pending.map((p) => ({ r: p.r, c: p.c, l: p.l, blank: p.blank }));
    const idxs = pending.map((p) => p.rackIndex).sort((a, b) => b - a);
    for (const p of placed) G.board[p.r][p.c] = { l: p.l, blank: p.blank };
    for (const i of idxs) G.racks.you.splice(i, 1);
    G.lastMove = placed.map((p) => ({ r: p.r, c: p.c }));
    drawTiles("you");
    pending = []; selRack = -1; cursor = null;
    G.scores.you += ev.score;
    G.scoreless = 0;
    X.sfx("good");
    setTimeout(() => X.fxGood(placed.map((p) => els.board.querySelector(`[data-r="${p.r}"][data-c="${p.c}"]`))), 50);
    G.log.push(`You played ${ev.main.toUpperCase()} for ${ev.score}${ev.bingo ? " (all 7 tiles!)" : ""}`);
    S.sfx(ev.bingo ? "win" : ev.score >= 30 ? "great" : "good");
    if (ev.bingo) say("celebrate", "ALL SEVEN TILES?! +40 bonus! Wow!", 3500);
    else if (ev.score >= 30) say("celebrate", pickOne([`${ev.score} points! Show-off!`, "Ooh, that's a big one!", "Holy quack!"]), 3200);
    else say("happy", pickOne(["Nice word!", `${ev.main.toUpperCase()}! Good one.`, "Not bad, not bad…", "Hmm, my turn…"]));
    endTurn();
  }

  function endTurn() {
    if (checkGameOver()) return;
    G.turn = G.turn === "you" ? "ai" : "you";
    save();
    render();
    if (G.turn === "ai") aiTurn();
  }

  function checkGameOver() {
    const youOut = !G.racks.you.length && !G.bag.length;
    const aiOut = !G.racks.ai.length && !G.bag.length;
    if (!youOut && !aiOut && G.scoreless < 4) return false;
    const yv = rackValue(G.racks.you), av = rackValue(G.racks.ai);
    G.scores.you -= yv; G.scores.ai -= av;
    if (youOut) G.scores.you += av;
    if (aiOut) G.scores.ai += yv;
    G.over = true;
    G.turn = "none";
    const won = G.scores.you > G.scores.ai, tie = G.scores.you === G.scores.ai;
    const stats = S.load(STATS_KEY) || {};
    const st = stats[G.level] || { w: 0, l: 0, t: 0, best: 0 };
    if (won) st.w++; else if (tie) st.t++; else st.l++;
    st.best = Math.max(st.best || 0, G.scores.you);
    stats[G.level] = st;
    S.save(STATS_KEY, stats);
    G.log.push(`Game over: you ${G.scores.you}, Quackers ${G.scores.ai}`);
    save();
    render();
    if (won) X.recordWin({ id: `${G.level}:${Date.now()}`, clean: !G.guided && G.hints === HINTS_PER_GAME, sizeKey: G.level });
    else X.sfx("lose");
    $("result-title").textContent = won ? "You win! 🎉" : tie ? "It's a tie!" : "Quackers wins this time";
    $("result-text").textContent = `You ${G.scores.you} · Quackers ${G.scores.ai} (${G.level}). ${
      yv || av ? `Leftover tiles: you −${yv}, Quackers −${av}. ` : ""
    }Your record on ${G.level}: ${st.w} won, ${st.l} lost${st.t ? `, ${st.t} tied` : ""}. Best score: ${st.best}.`;
    S.sfx(won ? "win" : "lose");
    if (won) say("sad", pickOne(["You beat me fair and square! Rematch?", "Aw, nuts. Good game!"]), 0);
    else if (tie) say("think", "A tie! Rematch?", 0);
    else say("celebrate", pickOne(["I win! Quack quack! Rematch?", "Good game! Want another?"]), 0);
    setTimeout(() => S.openModal("result-modal"), 900);
    return true;
  }

  function aiTurn() {
    busy = true;
    renderControls();
    say("think", pickOne(["Hmm, let me think…", "Ooh, what to play…", "Thinking…"]), 0);
    setTimeout(() => {
      const moves = E.generateMoves(G.board, G.racks.ai, dict);
      const move = E.chooseMove(moves, G.level, rng);
      busy = false;
      if (move) {
        applyMove("ai", move.placements);
        move.placements.forEach((_, k) => setTimeout(() => S.sfx("place"), k * 90));
        setTimeout(() => S.sfx(move.bingo ? "quack2" : "quack"), move.placements.length * 90 + 120);
        G.scores.ai += move.score;
        G.scoreless = 0;
        G.log.push(`Quackers played ${move.main.toUpperCase()} for ${move.score}${move.bingo ? " (all 7 tiles!)" : ""}`);
        say(move.score >= 30 ? "celebrate" : "happy", move.bingo ? `ALL SEVEN! ${move.main.toUpperCase()} for ${move.score}!` : `I played ${move.main.toUpperCase()} for ${move.score}!`, 3800);
      } else if (G.bag.length >= 7) {
        // swap the clunkiest tiles
        const rack = G.racks.ai;
        const out = rack.filter((l) => "qzxjkvw".includes(l)).slice(0, 4);
        const back = out.length ? out : rack.slice(0, 3);
        for (const l of back) rack.splice(rack.indexOf(l), 1);
        G.bag.push(...back);
        shuffleArr(G.bag);
        drawTiles("ai");
        G.scoreless++;
        G.lastMove = [];
        G.log.push(`Quackers swapped ${back.length} tiles`);
        say("think", "Ugh, bad letters. I'll swap some.", 3200);
      } else {
        G.scoreless++;
        G.lastMove = [];
        G.log.push("Quackers passed");
        say("sad", "I can't find anything… I pass!", 3200);
      }
      endTurn();
    }, 900 + Math.random() * 700);
  }

  function shuffleArr(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  // ---------- buttons ----------
  els.play.addEventListener("click", playTurn);
  els.recall.addEventListener("click", recallAll);
  els.shuffle.addEventListener("click", () => {
    if (pending.length) recallAll();
    shuffleArr(G.racks.you);
    S.sfx("shuffle");
    save();
    renderRack();
  });
  els.pass.addEventListener("click", () => {
    if (G.turn !== "you" || busy) return;
    if (els.pass.dataset.armed !== "1") {
      els.pass.dataset.armed = "1";
      els.pass.textContent = "Tap again to pass";
      setTimeout(() => { els.pass.dataset.armed = ""; els.pass.textContent = "Pass"; }, 3500);
      return;
    }
    els.pass.dataset.armed = ""; els.pass.textContent = "Pass";
    recallAll();
    G.scoreless++;
    G.lastMove = [];
    G.log.push("You passed");
    endTurn();
  });
  els.hint.addEventListener("click", () => {
    if (G.turn !== "you" || busy || G.hints <= 0) return;
    recallAll();
    const moves = E.generateMoves(G.board, G.racks.you, dict);
    if (!moves.length) { say("think", "Hmm… I don't see a move. Try swapping!"); return; }
    const m = moves[0];
    const used = new Set();
    pending = m.placements.map((p) => {
      const i = G.racks.you.findIndex((l, idx) => !used.has(idx) && l === (p.blank ? "?" : p.l));
      used.add(i);
      return { r: p.r, c: p.c, l: p.l, blank: p.blank, rackIndex: i };
    });
    G.hints--;
    S.sfx("hint");
    save();
    render();
    say("think", `Psst… try ${m.main.toUpperCase()} for ${m.score}!`, 3800);
  });

  // ---------- Extras: sound, Locker, Guided Look ----------
  const X = window.Extras;
  function openPondGuide() {
    if (!G || G.over || G.turn !== "you" || busy) {
      S.showToast("Guided Look works on your turn");
      return;
    }
    const moves = E.generateMoves(G.board, G.racks.you, dict).slice().sort((a, b) => b.score - a.score);
    G.guided = true;
    save();
    if (!moves.length) {
      X.showGuide("Word Pond", `<p class="guide-note">No playable word with this rack. Swapping tiles is your best bet.</p>`);
      return;
    }
    const seen = new Set();
    const top = moves.filter((m) => !seen.has(m.main) && seen.add(m.main)).slice(0, 8); // best placement of each word
    const total = top.reduce((s, m) => s + m.score, 0) || 1;
    const rack = G.racks.you.map((l) => (l === "?" ? "_" : l.toUpperCase())).join(" ");
    const rows = top.map((m) => ({ w: m.main.toUpperCase(), p: m.score / total, tag: `${m.score} points${m.placements.length === 7 ? " · uses all 7 tiles!" : ""} · ${m.placements.length} tile${m.placements.length === 1 ? "" : "s"} from your rack` }));
    X.showGuide(
      `Word Pond · your rack: ${rack}`,
      `${X.guideList(rows, { max: 8 })}
       <p class="guide-note">The highest-scoring plays Quackers can see for your rack (${moves.length.toLocaleString()} legal plays in all). Bars show each play's share of the points among these eight.</p>
       <p class="guide-cost">Using Guided Look means a win this game won't count as a no-hint win in the Locker. Your 💡 hints are untouched.</p>`
    );
    X.sfx("reveal");
  }
  X.mount({ game: "pond", name: "Word Pond", guide: openPondGuide });

  // swap
  let swapSel = new Set();
  els.swap.addEventListener("click", () => {
    if (G.turn !== "you" || busy || G.bag.length < 7) return;
    recallAll();
    swapSel = new Set();
    renderSwap();
    S.openModal("swap-modal");
  });
  function renderSwap() {
    $("wp-swap-rack").innerHTML = G.racks.you
      .map((l, i) => `<button type="button" class="wp-tile${swapSel.has(i) ? " selected" : ""}${l === "?" ? " blank-tile" : ""}" data-i="${i}">${l === "?" ? '<span class="wp-l">&nbsp;</span>' : tileHtml({ l })}</button>`)
      .join("");
    $("wp-swap-go").disabled = !swapSel.size;
  }
  $("wp-swap-rack").addEventListener("click", (e) => {
    const t = e.target.closest(".wp-tile");
    if (!t) return;
    const i = +t.dataset.i;
    if (swapSel.has(i)) swapSel.delete(i); else swapSel.add(i);
    renderSwap();
  });
  $("wp-swap-go").addEventListener("click", () => {
    if (!swapSel.size) return;
    const idxs = [...swapSel].sort((a, b) => b - a);
    const back = idxs.map((i) => G.racks.you.splice(i, 1)[0]);
    drawTiles("you");
    G.bag.push(...back);
    shuffleArr(G.bag);
    G.scoreless++;
    G.lastMove = [];
    G.log.push(`You swapped ${back.length} tile${back.length === 1 ? "" : "s"}`);
    S.sfx("shuffle");
    S.closeModal("swap-modal");
    endTurn();
  });

  // new game
  function openNewGame() {
    const stats = S.load(STATS_KEY) || {};
    const parts = ["easy", "medium", "hard"].filter((k) => stats[k]).map((k) => `${k}: ${stats[k].w}–${stats[k].l}`);
    $("wp-record").textContent = parts.length ? `Your record (won–lost) · ${parts.join(" · ")}` : "";
    S.openModal("newgame-modal");
  }
  $("new-game-btn").addEventListener("click", () => {
    if (G && !G.over && G.log.length && !confirmNew()) return;
    openNewGame();
  });
  function confirmNew() {
    const b = $("new-game-btn");
    if (b.dataset.armed === "1") { b.dataset.armed = ""; return true; }
    b.dataset.armed = "1";
    S.showToast("Tap ↻ again to quit this game and start a new one");
    setTimeout(() => { b.dataset.armed = ""; }, 3500);
    return false;
  }
  document.querySelectorAll(".wp-level-btn").forEach((b) =>
    b.addEventListener("click", () => {
      S.closeModal("newgame-modal");
      newGame(b.dataset.level);
    })
  );
  $("play-again-btn").addEventListener("click", () => { S.closeModal("result-modal"); openNewGame(); });
  $("help-btn").addEventListener("click", () => S.openModal("help-modal"));
  if (mascotEl) mascotEl.addEventListener("click", () => S.sfx("quack"));
  if (mascotEl) mascotEl.addEventListener("click", () => say("happy", pickOne(["Quack!", "Don't let me win!", "I know a LOT of words.", "Psst — try the Hint button!"])));

  // ---------- start ----------
  S.initShell({});
  setTimeout(() => {
    dict = E.makeDict(POND_WORDS, POND_AI_AVOID);
    if (loadSaved()) {
      render();
      if (G.over) say("happy", "Ready for another game? Tap ↻ New game.", 4000);
      else if (G.turn === "ai") aiTurn();
      else say("happy", "Welcome back! Your turn.", 3000);
    } else {
      G = { board: E.emptyBoard(), racks: { you: [], ai: [] }, scores: { you: 0, ai: 0 }, bag: [], log: [], turn: "none", over: true, hints: 0, level: "" };
      render();
      els.status.textContent = "Pick how tough Quackers should be to start.";
      openNewGame();
    }
  }, 30);
})();
