// Word Pond engine: board, tiles, dictionary trie, move validation, scoring
// and Quackers' move generator. No DOM - also runs under node for tests.
(function (root) {
  "use strict";

  const N = 15;
  const CENTER = 7;
  const BINGO = 40; // bonus for playing all 7 tiles
  const RACK = 7;
  const A = 97; // 'a'

  // ---- tiles: [count, points]; "?" is a blank ----
  const TILESET = {
    a: [9, 1], b: [2, 4], c: [2, 4], d: [4, 2], e: [12, 1], f: [2, 4], g: [3, 3], h: [3, 3], i: [8, 1],
    j: [1, 10], k: [1, 5], l: [4, 2], m: [2, 3], n: [6, 1], o: [8, 1], p: [2, 3], q: [1, 10], r: [6, 1],
    s: [5, 1], t: [7, 1], u: [4, 2], v: [2, 5], w: [2, 4], x: [1, 8], y: [2, 3], z: [1, 10], "?": [2, 0],
  };
  const POINTS = {};
  for (const k of Object.keys(TILESET)) POINTS[k] = TILESET[k][1];

  // ---- bonus squares (Word Pond's own layout, 8-way symmetric) ----
  // TW = triple word, DW = double word, TL = triple letter, DL = double letter
  const OCTANT = {
    TW: [[0, 3]],
    TL: [[0, 6], [3, 3], [5, 5]],
    DW: [[1, 1], [1, 5], [3, 7], [7, 7]],
    DL: [[0, 0], [2, 4], [4, 6], [6, 6], [1, 7]],
  };
  const PREMIUM = Array.from({ length: N }, () => Array(N).fill(""));
  for (const [type, cells] of Object.entries(OCTANT)) {
    for (const [r, c] of cells) {
      const sym = [[r, c], [c, r], [r, N - 1 - c], [c, N - 1 - r], [N - 1 - r, c], [N - 1 - c, r], [N - 1 - r, N - 1 - c], [N - 1 - c, N - 1 - r]];
      for (const [y, x] of sym) PREMIUM[y][x] = type;
    }
  }

  // ---- dictionary: left-child/right-sibling trie in typed arrays (~4 MB) ----
  function buildTrie(wordString) {
    const words = wordString.split(" ");
    let cap = 1 << 19;
    let letter = new Uint8Array(cap);
    let end = new Uint8Array(cap);
    let child = new Int32Array(cap).fill(-1);
    let sib = new Int32Array(cap).fill(-1);
    let last = new Int32Array(cap).fill(-1); // last child, for appending
    let count = 1; // node 0 = root
    function grow() {
      cap *= 2;
      const g8 = (a) => { const b = new Uint8Array(cap); b.set(a); return b; };
      const g32 = (a) => { const b = new Int32Array(cap).fill(-1); b.set(a); return b; };
      letter = g8(letter); end = g8(end); child = g32(child); sib = g32(sib); last = g32(last);
    }
    for (const w of words) {
      let node = 0;
      for (let i = 0; i < w.length; i++) {
        const ch = w.charCodeAt(i) - A;
        let c = child[node];
        let found = -1;
        while (c !== -1) { if (letter[c] === ch) { found = c; break; } c = sib[c]; }
        if (found === -1) {
          if (count >= cap) grow();
          found = count++;
          letter[found] = ch;
          if (child[node] === -1) child[node] = found; else sib[last[node]] = found;
          last[node] = found;
        }
        node = found;
      }
      end[node] = 1;
    }
    return { letter, end, child, sib, nodes: count };
  }

  function makeDict(wordString, avoidString) {
    const t = buildTrie(wordString);
    const avoid = new Set((avoidString || "").split(" ").filter(Boolean));
    function next(node, ch) {
      let c = t.child[node];
      while (c !== -1) { if (t.letter[c] === ch) return c; c = t.sib[c]; }
      return -1;
    }
    function isWord(w) {
      let node = 0;
      for (let i = 0; i < w.length; i++) {
        node = next(node, w.charCodeAt(i) - A);
        if (node === -1) return false;
      }
      return t.end[node] === 1;
    }
    return { t, next, isWord, avoid };
  }

  // ---- bag / racks ----
  function newBag(rand) {
    const bag = [];
    for (const [k, [n]] of Object.entries(TILESET)) for (let i = 0; i < n; i++) bag.push(k);
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    return bag;
  }

  function emptyBoard() {
    return Array.from({ length: N }, () => Array(N).fill(null)); // cell: {l, blank}
  }

  // ---- scoring + validation of a set of placements ----
  // placements: [{r, c, l, blank}]
  function wordAt(board, extra, r, c, dr, dc) {
    const get = (y, x) => (y < 0 || x < 0 || y >= N || x >= N ? null : extra.get(y * N + x) || board[y][x]);
    let y = r, x = c;
    while (get(y - dr, x - dc)) { y -= dr; x -= dc; }
    const cells = [];
    while (get(y, x)) { cells.push({ r: y, c: x, t: get(y, x), isNew: extra.has(y * N + x) }); y += dr; x += dc; }
    return cells;
  }

  function scoreWord(cells) {
    let sum = 0, mult = 1;
    for (const { r, c, t, isNew } of cells) {
      let v = t.blank ? 0 : POINTS[t.l];
      if (isNew) {
        const p = PREMIUM[r][c];
        if (p === "DL") v *= 2; else if (p === "TL") v *= 3; else if (p === "DW") mult *= 2; else if (p === "TW") mult *= 3;
      }
      sum += v;
    }
    return sum * mult;
  }

  function boardEmpty(board) {
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (board[r][c]) return false;
    return true;
  }

  // Returns {ok, error} or {ok:true, score, words:[{word, score}], main}
  function evaluate(board, placements, dict) {
    if (!placements.length) return { ok: false, error: "Place some tiles first" };
    const extra = new Map();
    for (const p of placements) {
      if (p.r < 0 || p.c < 0 || p.r >= N || p.c >= N) return { ok: false, error: "Off the board" };
      if (board[p.r][p.c] || extra.has(p.r * N + p.c)) return { ok: false, error: "That square is taken" };
      extra.set(p.r * N + p.c, { l: p.l, blank: !!p.blank });
    }
    const rows = new Set(placements.map((p) => p.r));
    const cols = new Set(placements.map((p) => p.c));
    if (rows.size > 1 && cols.size > 1) return { ok: false, error: "Tiles must be in one straight line" };
    const horizontal = rows.size === 1 && (cols.size > 1 || placements.length === 1);
    let dr = horizontal ? 0 : 1, dc = horizontal ? 1 : 0;
    // a single tile: pick the direction that makes the longer word
    if (placements.length === 1) {
      const p = placements[0];
      const h = wordAt(board, extra, p.r, p.c, 0, 1).length;
      const v = wordAt(board, extra, p.r, p.c, 1, 0).length;
      if (v > h) { dr = 1; dc = 0; }
    }
    const first = placements[0];
    const main = wordAt(board, extra, first.r, first.c, dr, dc);
    for (const p of placements) {
      if (!main.some((m) => m.r === p.r && m.c === p.c)) return { ok: false, error: "Tiles must be connected with no gaps" };
    }
    const empty = boardEmpty(board);
    if (empty) {
      if (!placements.some((p) => p.r === CENTER && p.c === CENTER)) return { ok: false, error: "The first word must cover the center star" };
      if (main.length < 2) return { ok: false, error: "Words need at least 2 letters" };
    }
    const words = [];
    if (main.length >= 2) words.push(main);
    for (const p of placements) {
      const cross = wordAt(board, extra, p.r, p.c, dc, dr);
      if (cross.length >= 2) words.push(cross);
    }
    if (!words.length) return { ok: false, error: "Words need at least 2 letters" };
    if (!empty) {
      const touches = words.some((w) => w.some((cell) => !cell.isNew));
      if (!touches) return { ok: false, error: "Your word must connect to tiles on the board" };
    }
    const out = [];
    let total = 0;
    for (const w of words) {
      const text = w.map((x) => x.t.l).join("");
      if (!dict.isWord(text)) return { ok: false, error: `${text.toUpperCase()} isn't in the word list`, badWord: text };
      const s = scoreWord(w);
      out.push({ word: text, score: s });
      total += s;
    }
    const bingo = placements.length === RACK;
    if (bingo) total += BINGO;
    return { ok: true, score: total, words: out, bingo, main: out[0].word };
  }

  // ---- Quackers: Appel-Jacobson style move generator ----
  function rackCounts(rack) {
    const counts = new Int8Array(27);
    for (const t of rack) counts[t === "?" ? 26 : t.charCodeAt(0) - A]++;
    return counts;
  }

  function generateMoves(board, rack, dict, limit) {
    const moves = [];
    const counts = rackCounts(rack);
    const empty = boardEmpty(board);
    const maxMoves = limit || 60000;
    for (const across of [true, false]) {
      // view the board so that we always scan "rows"
      const at = (r, c) => (across ? board[r][c] : board[c][r]);
      // cross-check masks for each empty square (letters allowed vertically)
      const cross = Array.from({ length: N }, () => new Int32Array(N));
      for (let r = 0; r < N; r++) {
        for (let c = 0; c < N; c++) {
          if (at(r, c)) { cross[r][c] = 0; continue; }
          const up = r > 0 && at(r - 1, c);
          const down = r < N - 1 && at(r + 1, c);
          if (!up && !down) { cross[r][c] = (1 << 26) - 1; continue; }
          let pre = "";
          for (let y = r - 1; y >= 0 && at(y, c); y--) pre = at(y, c).l + pre;
          let suf = "";
          for (let y = r + 1; y < N && at(y, c); y++) suf += at(y, c).l;
          let mask = 0;
          for (let k = 0; k < 26; k++) if (dict.isWord(pre + String.fromCharCode(A + k) + suf)) mask |= 1 << k;
          cross[r][c] = mask;
        }
      }
      for (let r = 0; r < N; r++) {
        // anchors: empty squares next to a tile (or the center on an empty board)
        for (let c = 0; c < N; c++) {
          if (at(r, c)) continue;
          let anchor;
          if (empty) anchor = across && r === CENTER && c === CENTER;
          else anchor = (r > 0 && at(r - 1, c)) || (r < N - 1 && at(r + 1, c)) || (c > 0 && at(r, c - 1)) || (c < N - 1 && at(r, c + 1));
          if (!anchor) continue;
          const placed = [];
          const record = (startCol) => {
            if (moves.length >= maxMoves || !placed.length) return;
            moves.push({
              placements: placed.map((p) => (across ? { r, c: p.c, l: p.l, blank: p.blank } : { r: p.c, c: r, l: p.l, blank: p.blank })),
            });
          };
          const extendRight = (node, c2, anchorFilled) => {
            if (c2 >= N) {
              if (anchorFilled && dict.t.end[node]) record();
              return;
            }
            const tile = at(r, c2);
            if (tile) {
              const nx = dict.next(node, tile.l.charCodeAt(0) - A);
              if (nx !== -1) extendRight(nx, c2 + 1, anchorFilled);
              return;
            }
            if (anchorFilled && dict.t.end[node] && placed.length) record();
            const mask = cross[r][c2];
            let ch = dict.t.child[node];
            while (ch !== -1) {
              const k = dict.t.letter[ch];
              if (mask & (1 << k)) {
                if (counts[k] > 0) {
                  counts[k]--; placed.push({ c: c2, l: String.fromCharCode(A + k), blank: false });
                  extendRight(ch, c2 + 1, anchorFilled || c2 === c);
                  placed.pop(); counts[k]++;
                }
                if (counts[26] > 0) {
                  counts[26]--; placed.push({ c: c2, l: String.fromCharCode(A + k), blank: true });
                  extendRight(ch, c2 + 1, anchorFilled || c2 === c);
                  placed.pop(); counts[26]++;
                }
              }
              ch = dict.t.sib[ch];
            }
          };
          if (c > 0 && at(r, c - 1)) {
            // left part is already on the board: walk it in the trie
            let s = c - 1;
            while (s > 0 && at(r, s - 1)) s--;
            let node = 0;
            for (let x = s; x < c && node !== -1; x++) node = dict.next(node, at(r, x).l.charCodeAt(0) - A);
            if (node !== -1) extendRight(node, c, false);
          } else {
            // build left parts from the rack into empty, non-anchor squares
            let limitLeft = 0;
            for (let x = c - 1; x >= 0 && !at(r, x); x--) {
              const isAnchor = empty ? false : (r > 0 && at(r - 1, x)) || (r < N - 1 && at(r + 1, x)) || (x > 0 && at(r, x - 1));
              if (isAnchor) break;
              limitLeft++;
            }
            const leftPart = (node, len) => {
              // place left part ending at c-1, then extend from the anchor
              extendRightFromLeft(node, len);
              if (len >= limitLeft) return;
              let ch = dict.t.child[node];
              while (ch !== -1) {
                const k = dict.t.letter[ch];
                for (const useBlank of [false, true]) {
                  const idx = useBlank ? 26 : k;
                  if (counts[idx] <= 0) continue;
                  counts[idx]--;
                  placed.push({ c: -1, l: String.fromCharCode(A + k), blank: useBlank });
                  leftPart(ch, len + 1);
                  placed.pop();
                  counts[idx]++;
                }
                ch = dict.t.sib[ch];
              }
            };
            const extendRightFromLeft = (node, len) => {
              // assign real columns to the left part tiles
              for (let i = 0; i < len; i++) placed[i].c = c - len + i;
              extendRight(node, c, false);
            };
            leftPart(0, 0);
          }
        }
      }
    }
    // score + dedupe
    const seen = new Set();
    const out = [];
    for (const m of moves) {
      const key = m.placements.map((p) => `${p.r},${p.c},${p.l},${p.blank ? 1 : 0}`).sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      const ev = evaluate(board, m.placements, dict);
      if (!ev.ok) continue;
      if (ev.words.some((w) => dict.avoid.has(w.word))) continue;
      out.push({ placements: m.placements, score: ev.score, words: ev.words, main: ev.main, bingo: ev.bingo });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  // pick a move for a difficulty level
  function chooseMove(moves, level, rand) {
    if (!moves.length) return null;
    const best = moves[0].score;
    if (level === "hard") return moves[0];
    let lo, hi;
    if (level === "easy") { lo = 0.15; hi = 0.45; } else { lo = 0.55; hi = 0.85; }
    let pool = moves.filter((m) => m.score >= best * lo && m.score <= best * hi);
    if (level === "easy") pool = pool.filter((m) => m.placements.length <= 4 && !m.bingo);
    if (!pool.length) pool = level === "easy" ? moves.slice(Math.floor(moves.length * 0.6)) : moves.slice(0, Math.max(1, Math.ceil(moves.length * 0.3)));
    return pool[Math.floor(rand() * pool.length)];
  }

  const api = { N, CENTER, RACK, BINGO, TILESET, POINTS, PREMIUM, makeDict, newBag, emptyBoard, evaluate, generateMoves, chooseMove };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PondEngine = api;
})(this);
