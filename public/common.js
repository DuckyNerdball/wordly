// Shared plumbing for every game page: themes, player name, modals, toasts,
// dates, seeded randomness, and small API helpers. Exposed as window.Shared.
window.Shared = (() => {
  "use strict";

  const THEMES = [
    { id: "ducky", name: "Ducky (Light)", swatch: "#ff7a2f" },
    { id: "ducky-night", name: "Ducky (Dark)", swatch: "#151515" },
    { id: "dark", name: "Dark", swatch: "#538d4e" },
    { id: "oled", name: "OLED Black", swatch: "#000000" },
    { id: "light", name: "Light", swatch: "#6aaa64" },
    { id: "neon-standard", name: "Standard Neon", swatch: "#39ff14" },
    { id: "neon-city", name: "Neon City", swatch: "#00e5ff" },
    { id: "synthwave", name: "Synthwave", swatch: "#ff2ec4" },
    { id: "bubblegum-3d", name: "Bubblegum 3D", swatch: "#6fdcc7" },
    { id: "ocean", name: "Ocean", swatch: "#2ea8b8" },
    { id: "sunset", name: "Sunset", swatch: "#f0643a" },
    { id: "forest", name: "Forest", swatch: "#f236c1" },
    { id: "halloween", name: "Halloween", swatch: "#f5891f" },
    { id: "christmas", name: "Christmas", swatch: "#c41e3a" },
    { id: "neon80s", name: "Neon 80s", swatch: "#ff6b00" },
    { id: "spooky", name: "Spooky", swatch: "#7cb342" },
    { id: "terminal", name: "Retro Terminal", swatch: "#33ff33" },
    { id: "bubblegum", name: "Bubblegum", swatch: "#ff8fc7" },
    { id: "art-deco", name: "Art Deco", swatch: "#d4af37" },
    { id: "tropical", name: "Tropical", swatch: "#1fc7b6" },
    { id: "desert", name: "Desert", swatch: "#e07a3a" },
    { id: "dessert", name: "Dessert", swatch: "#ff8fb4" },
  ];

  const THEME_KEY = "wordly:theme";
  const TEXT_SCALE_KEY = "wordly:textScale";
  const PLAYER_KEY = "wordly:playerName";
  const PIN_KEY = "wordly:playerPin";
  const OFFLINE_SCORES_KEY = "wordly:offlineScores";
  const SYNC_KEY_RE = /^(wordly|bee|boxed|connections|strands|wordsearch|mini|midi|crossword|tiles|sudoku):(daily:|theme|hardMode|length|difficulty)/;

  let syncDebounce = null;
  let deferredInstallPrompt = null;

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    const btn = document.getElementById("pwa-install-btn");
    if (btn) btn.classList.remove("hidden");
  });

  window.addEventListener("online", () => {
    flushOfflineScoreQueue();
    scheduleCloudSync();
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }

  // ---------- storage ----------

  function load(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      if (SYNC_KEY_RE.test(key)) scheduleCloudSync();
    } catch {
      // Storage full or blocked - progress just won't survive a reload.
    }
  }

  function collectSyncState() {
    const out = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && SYNC_KEY_RE.test(k)) {
          out[k] = localStorage.getItem(k);
        }
      }
    } catch {
      // ignore
    }
    return out;
  }

  function mergeLocalEntry(oldRaw, newRaw) {
    if (!oldRaw) return newRaw;
    if (!newRaw) return oldRaw;
    try {
      const a = JSON.parse(oldRaw);
      const b = JSON.parse(newRaw);
      if (a && typeof a === "object" && b && typeof b === "object") {
        const aDone = !!(a.over || a.solved);
        const bDone = !!(b.over || b.solved);
        if (aDone && !bDone) return oldRaw;
        if (bDone && !aDone) return newRaw;
        const aProg = (a.guesses?.length || 0) + (a.found?.length || 0) + (a.words?.length || 0) + (a.cleared || 0) + (a.filled || 0) + (a.activeMs || 0);
        const bProg = (b.guesses?.length || 0) + (b.found?.length || 0) + (b.words?.length || 0) + (b.cleared || 0) + (b.filled || 0) + (b.activeMs || 0);
        return bProg >= aProg ? newRaw : oldRaw;
      }
    } catch {
      // scalar
    }
    return newRaw;
  }

  function applySyncedState(remoteState) {
    if (!remoteState || typeof remoteState !== "object") return 0;
    let changed = 0;
    try {
      for (const [k, v] of Object.entries(remoteState)) {
        if (!SYNC_KEY_RE.test(k) || typeof v !== "string") continue;
        const cur = localStorage.getItem(k);
        const merged = mergeLocalEntry(cur, v);
        if (merged !== cur) {
          localStorage.setItem(k, merged);
          changed++;
        }
      }
    } catch {
      // ignore
    }
    return changed;
  }

  function getPlayerPin() {
    try {
      return localStorage.getItem(PIN_KEY) || "";
    } catch {
      return "";
    }
  }

  function setPlayerPin(pin) {
    try {
      localStorage.setItem(PIN_KEY, (pin || "").trim().slice(0, 16));
    } catch {
      // ignore
    }
  }

  async function syncProfile({ silent = false } = {}) {
    const name = getPlayerName();
    if (!name) return false;
    try {
      const res = await postJSON("/api/profile/sync", {
        name,
        pin: getPlayerPin(),
        state: collectSyncState(),
      });
      const updated = applySyncedState(res.state);
      if (!silent) {
        showToast(updated ? `Synced (${updated} updated)` : "Profile synced ☁️");
      }
      return updated > 0;
    } catch (err) {
      if (!silent) showToast(err.message || "Sync unavailable");
      return false;
    }
  }

  function scheduleCloudSync() {
    if (!getPlayerName()) return;
    clearTimeout(syncDebounce);
    syncDebounce = setTimeout(() => {
      syncProfile({ silent: true });
    }, 1800);
  }

  // ---------- dates & timers ----------

  function todayDateString(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function shiftDate(dateStr, days) {
    const [y, m, d] = dateStr.split("-").map(Number);
    return todayDateString(new Date(y, m - 1, d + days));
  }

  function msUntilNextMidnight() {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return next.getTime() - now.getTime();
  }

  function formatCountdown(ms, noun = "puzzle") {
    const totalMinutes = Math.max(0, Math.floor(ms / 60000));
    return `Next ${noun} in ${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
  }

  function formatDateLabel(dateStr) {
    if (dateStr === todayDateString()) return "Today";
    if (dateStr === shiftDate(todayDateString(), -1)) return "Yesterday";
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  // Archive modal so players can catch up on missed daily puzzles.
  // getStatus(dateStr) -> { state: "won" | "lost" | "progress" | "none", detail?: string }
  function initArchive({ activeDate, getStatus, onSelectDate, days = 30, epoch = "2026-11-02" } = {}) {
    const controlsRow = document.querySelector(".controls-row");
    let archiveBtn = document.getElementById("archive-btn");
    if (controlsRow && !archiveBtn) {
      archiveBtn = document.createElement("button");
      archiveBtn.id = "archive-btn";
      archiveBtn.className = "icon-btn archive-btn";
      archiveBtn.type = "button";
      archiveBtn.setAttribute("aria-label", "Past daily puzzles");
      archiveBtn.title = "Past daily puzzles";
      archiveBtn.className = "icon-btn archive-btn labeled-btn";
      archiveBtn.innerHTML = '<span class="btn-icon" aria-hidden="true">&#128197;</span><span class="btn-label">Past days</span>';
      const lbBtn = document.getElementById("leaderboard-btn");
      if (lbBtn) controlsRow.insertBefore(archiveBtn, lbBtn);
      else controlsRow.appendChild(archiveBtn);
    }

    if (!document.getElementById("archive-modal")) {
      document.body.insertAdjacentHTML(
        "beforeend",
        `<div id="archive-modal" class="modal-overlay hidden">
          <div class="modal modal-wide">
            <button class="modal-close" data-close="archive-modal" aria-label="Close">&times;</button>
            <h2>Daily Archive</h2>
            <p class="archive-sub">Catch up on any daily puzzle you missed.</p>
            <div id="archive-list" class="archive-grid"></div>
          </div>
        </div>`
      );
      document
        .querySelector('[data-close="archive-modal"]')
        .addEventListener("click", () => closeModal("archive-modal"));
      const overlay = document.getElementById("archive-modal");
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) closeModal("archive-modal");
      });
    }

    let currentActive = activeDate || todayDateString();

    function updateBadge(dateStr) {
      currentActive = dateStr || todayDateString();
      if (!archiveBtn) return;
      const isPast = currentActive !== todayDateString();
      archiveBtn.classList.toggle("is-past", isPast);
      archiveBtn.title = isPast ? `Playing ${currentActive} (tap to switch day)` : "Past daily puzzles";
      const dailyBtn = document.querySelector('.mode-btn[data-mode="daily"]');
      if (dailyBtn) {
        dailyBtn.textContent = isPast ? formatDateLabel(currentActive) : "Daily";
      }
    }

    function renderArchive() {
      const list = document.getElementById("archive-list");
      if (!list) return;
      const today = todayDateString();
      const items = [];
      for (let i = 0; i < days; i++) {
        const d = shiftDate(today, -i);
        if (epoch && d < epoch && i > 14) break;
        const st = (getStatus && getStatus(d)) || { state: "none" };
        const badge =
          st.state === "won"
            ? "✓"
            : st.state === "lost"
            ? "✗"
            : st.state === "progress"
            ? "•••"
            : "Play";
        items.push(`
          <button type="button" class="archive-day st-${st.state}${d === currentActive ? " active" : ""}" data-date="${d}">
            <span class="archive-day-top">
              <span class="archive-day-label">${escapeHtml(formatDateLabel(d))}</span>
              <span class="archive-day-badge">${escapeHtml(badge)}</span>
            </span>
            <span class="archive-day-meta">${escapeHtml(st.detail && st.detail !== d ? st.detail : new Date(d + "T12:00:00").toLocaleDateString(undefined, { weekday: "long" }))}</span>
          </button>`);
      }
      list.innerHTML = items.join("");
      list.querySelectorAll(".archive-day").forEach((btn) => {
        btn.addEventListener("click", () => {
          const picked = btn.dataset.date;
          updateBadge(picked);
          closeModal("archive-modal");
          if (onSelectDate) onSelectDate(picked);
        });
      });
    }

    if (archiveBtn) {
      archiveBtn.addEventListener("click", () => {
        renderArchive();
        openModal("archive-modal");
      });
    }

    updateBadge(currentActive);
    return { setDate: updateBadge, refresh: renderArchive };
  }

  function formatTimer(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = String(totalSeconds % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  }

  // ---------- seeded randomness ----------

  function hashString(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash * 33) ^ str.charCodeAt(i)) >>> 0;
    }
    return hash >>> 0;
  }

  // mulberry32: tiny deterministic PRNG so every device builds the same
  // daily puzzle from the same date string.
  function seededRandom(seedStr) {
    let a = hashString(seedStr);
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(arr, rand = Math.random) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function letterMask(word) {
    let mask = 0;
    for (let i = 0; i < word.length; i++) mask |= 1 << (word.charCodeAt(i) - 97);
    return mask;
  }

  function bitCount(n) {
    let c = 0;
    while (n) {
      n &= n - 1;
      c++;
    }
    return c;
  }

  // Active-play stopwatch: only counts while the page is visible, so leaving
  // a puzzle open in a background tab doesn't inflate your time.
  function createStopwatch(initialMs, onTick) {
    let accumulated = initialMs || 0;
    let runningSince = null;
    let interval = null;

    function current() {
      return accumulated + (runningSince ? Date.now() - runningSince : 0);
    }
    function pause() {
      if (runningSince) accumulated += Date.now() - runningSince;
      runningSince = null;
    }
    function resume() {
      if (!runningSince && !document.hidden) runningSince = Date.now();
    }
    function start() {
      resume();
      if (!interval) {
        interval = setInterval(() => onTick && onTick(current()), 250);
        document.addEventListener("visibilitychange", onVisibility);
      }
      onTick && onTick(current());
    }
    function stop() {
      pause();
      if (interval) clearInterval(interval);
      interval = null;
      document.removeEventListener("visibilitychange", onVisibility);
      return accumulated;
    }
    function onVisibility() {
      if (document.hidden) pause();
      else resume();
    }
    return { start, stop, current, get running() { return !!interval; } };
  }

  // ---------- player ----------

  function getPlayerName() {
    try {
      return localStorage.getItem(PLAYER_KEY) || "";
    } catch {
      return "";
    }
  }

  function setPlayerName(name) {
    try {
      localStorage.setItem(PLAYER_KEY, name);
    } catch {
      // ignore
    }
  }

  // ---------- UI helpers ----------

  function showToast(message, ms = 1300) {
    const container = document.getElementById("toast-container");
    if (!container) return;
    // One message at a time - rapid-fire input would otherwise stack a
    // column of toasts down the screen.
    container.innerHTML = "";
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    toast.style.animationDelay = `0s, ${Math.max(0, ms - 200) / 1000}s`;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), ms);
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = String(str);
    return div.innerHTML;
  }

  const closeHooks = {};
  function openModal(id) {
    document.getElementById(id).classList.remove("hidden");
  }
  function closeModal(id) {
    document.getElementById(id).classList.add("hidden");
    (closeHooks[id] || []).forEach((fn) => fn());
  }
  function onModalClose(id, fn) {
    (closeHooks[id] = closeHooks[id] || []).push(fn);
  }
  function anyModalOpen() {
    return !!document.querySelector(".modal-overlay:not(.hidden)");
  }

  // ---------- theme ----------

  function applyTheme(themeId) {
    document.documentElement.setAttribute("data-theme", themeId);
    try {
      localStorage.setItem(THEME_KEY, themeId);
      const bg = getComputedStyle(document.documentElement).getPropertyValue("--color-bg").trim();
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta && bg) meta.setAttribute("content", bg);
    } catch {
      // ignore
    }
    renderThemeList(themeId);
  }

  async function shareText(text) {
    try {
      await navigator.clipboard.writeText(text);
      showToast("Copied to clipboard");
    } catch {
      window.prompt("Copy your results:", text);
    }
  }

  function renderThemeList(activeId) {
    const list = document.getElementById("theme-list");
    if (!list) return;
    list.innerHTML = "";
    THEMES.forEach((theme) => {
      const btn = document.createElement("button");
      btn.className = "theme-option" + (theme.id === activeId ? " active" : "");
      btn.innerHTML = `<span class="theme-swatch" style="background:${theme.swatch}"></span><span>${theme.name}</span>`;
      btn.addEventListener("click", () => applyTheme(theme.id));
      list.appendChild(btn);
    });
  }

  // ---------- shell ----------

  // Injects the theme + player modals every page shares, and wires the
  // header buttons, close buttons, and click-outside-to-close behavior.
  function initShell({ onNameSaved } = {}) {
    if (!document.getElementById("theme-modal")) {
      document.body.insertAdjacentHTML(
        "beforeend",
        `<div id="theme-modal" class="modal-overlay hidden">
          <div class="modal">
            <button class="modal-close" data-close="theme-modal" aria-label="Close">&times;</button>
            <h2>Theme</h2>
            <div id="theme-list" class="theme-list"></div>
          </div>
        </div>
        <div id="name-modal" class="modal-overlay hidden">
          <div class="modal">
            <button class="modal-close" data-close="name-modal" aria-label="Close">&times;</button>
            <h2>Player Profile &amp; Sync</h2>
            <p>Your name is used for leaderboards and cross-device progress sync.</p>
            <input id="name-input" class="text-input" type="text" maxlength="40" placeholder="Your name" autocomplete="off" />
            <input id="pin-input" class="text-input" type="password" inputmode="numeric" maxlength="16" placeholder="Optional 4-digit sync PIN" autocomplete="off" />
            <button id="name-save-btn" class="primary-btn">Save &amp; Sync</button>
            <div class="profile-sync-box">
              <div class="profile-sync-row">
                <button id="sync-now-btn" class="pill-btn" type="button">Sync Now &#9729;</button>
                <button id="export-code-btn" class="pill-btn" type="button">Copy Backup Code</button>
                <button id="import-code-btn" class="pill-btn" type="button">Restore Code</button>
              </div>
              <button id="pwa-install-btn" class="pill-btn hidden" type="button" style="width:100%;margin-top:0.45rem">Install App to Home Screen &#128241;</button>
            </div>
          </div>
        </div>`
      );
    }

    let savedTheme = null;
    try {
      const params = new URLSearchParams(location.search);
      const qPlayer = params.get("player");
      if (qPlayer && qPlayer.trim()) setPlayerName(qPlayer.trim().slice(0, 40));
      const qTheme = params.get("theme");
      if (qTheme && THEMES.some((t) => t.id === qTheme)) {
        localStorage.setItem(THEME_KEY, qTheme);
      }
      savedTheme = localStorage.getItem(THEME_KEY);
    } catch {
      // ignore
    }
    if (savedTheme && THEMES.some((t) => t.id === savedTheme)) applyTheme(savedTheme);
    else applyTheme("ducky");

    const themeBtn = document.getElementById("theme-btn");
    if (themeBtn) themeBtn.addEventListener("click", () => openModal("theme-modal"));

    const playerBtn = document.getElementById("player-btn");
    if (playerBtn) {
      playerBtn.addEventListener("click", () => {
        document.getElementById("name-input").value = getPlayerName();
        const pinEl = document.getElementById("pin-input");
        if (pinEl) pinEl.value = getPlayerPin();
        openModal("name-modal");
      });
    }

    // ---------- comfort: labeled header buttons + text size ----------
    const LABELS = {
      "All games": "Games",
      "How to play": "Help",
      "Change theme": "Colors",
      "Leaderboard": "Scores",
      "New game": "New",
      "New puzzle": "New",
      "Player profile": "My name",
    };
    document.querySelectorAll(".app-header .icon-btn[title]").forEach((btn) => {
      const label = LABELS[btn.getAttribute("title")];
      if (!label || btn.classList.contains("labeled-btn")) return;
      btn.classList.add("labeled-btn");
      const icon = btn.id === "theme-btn" ? "&#127912;" : btn.innerHTML;
      btn.innerHTML = `<span class="btn-icon" aria-hidden="true">${icon}</span><span class="btn-label">${label}</span>`;
    });
    if (themeBtn && !document.getElementById("size-btn")) {
      const SIZES = [
        { v: "1.15", n: "Normal" },
        { v: "1.3", n: "Large" },
        { v: "1.5", n: "Extra large" },
      ];
      const sizeBtn = document.createElement("button");
      sizeBtn.id = "size-btn";
      sizeBtn.type = "button";
      sizeBtn.className = "icon-btn labeled-btn";
      sizeBtn.title = "Text size";
      sizeBtn.setAttribute("aria-label", "Change text size");
      sizeBtn.innerHTML = '<span class="btn-icon" aria-hidden="true"><b>A</b><small>A</small></span><span class="btn-label">Text size</span>';
      sizeBtn.addEventListener("click", () => {
        let cur = "1.15";
        try { cur = localStorage.getItem(TEXT_SCALE_KEY) || "1.15"; } catch { /* ignore */ }
        const i = SIZES.findIndex((s) => s.v === cur);
        const next = SIZES[(i + 1) % SIZES.length];
        document.documentElement.style.setProperty("--text-scale", next.v);
        try { localStorage.setItem(TEXT_SCALE_KEY, next.v); } catch { /* ignore */ }
        showToast(`Text size: ${next.n}`);
      });
      themeBtn.insertAdjacentElement("afterend", sizeBtn);
      if (document.body.classList.contains("has-sound") && !document.getElementById("sound-btn")) {
        const soundBtn = document.createElement("button");
        soundBtn.id = "sound-btn";
        soundBtn.type = "button";
        soundBtn.className = "icon-btn labeled-btn sound-btn";
        soundBtn.title = "Sound";
        soundBtn.setAttribute("aria-label", "Sound effects on or off");
        soundBtn.innerHTML = '<span class="btn-icon" aria-hidden="true"></span><span class="btn-label"></span>';
        soundBtn.addEventListener("click", () => {
          const on = !soundOn();
          setSound(on);
          if (on) sfx("quack");
          showToast(on ? "Sound effects on" : "Sound effects off");
        });
        sizeBtn.insertAdjacentElement("afterend", soundBtn);
        setSound(soundOn());
      }
    }

    const saveName = async () => {
      const input = document.getElementById("name-input");
      const pinEl = document.getElementById("pin-input");
      const name = input.value.trim();
      if (!name) {
        input.focus();
        return;
      }
      setPlayerName(name);
      if (pinEl) setPlayerPin(pinEl.value);
      closeModal("name-modal");
      const pulled = await syncProfile({ silent: false });
      if (onNameSaved) onNameSaved(name);
      if (pulled) location.reload();
    };
    document.getElementById("name-save-btn").addEventListener("click", saveName);
    document.getElementById("name-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") saveName();
    });

    document.getElementById("sync-now-btn")?.addEventListener("click", async () => {
      const input = document.getElementById("name-input");
      const pinEl = document.getElementById("pin-input");
      if (input && input.value.trim()) setPlayerName(input.value.trim());
      if (pinEl) setPlayerPin(pinEl.value);
      const pulled = await syncProfile({ silent: false });
      if (pulled) location.reload();
    });

    document.getElementById("export-code-btn")?.addEventListener("click", () => {
      const payload = {
        name: getPlayerName(),
        state: collectSyncState(),
      };
      const code = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
      shareText(code);
    });

    document.getElementById("import-code-btn")?.addEventListener("click", () => {
      const code = window.prompt("Paste your Ducky Dailies backup code:");
      if (!code || !code.trim()) return;
      try {
        const parsed = JSON.parse(decodeURIComponent(escape(atob(code.trim()))));
        if (parsed.name) setPlayerName(parsed.name);
        const count = applySyncedState(parsed.state || {});
        showToast(`Restored ${count} entries`);
        closeModal("name-modal");
        setTimeout(() => location.reload(), 350);
      } catch {
        showToast("Invalid backup code");
      }
    });

    document.getElementById("pwa-install-btn")?.addEventListener("click", async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice.catch(() => {});
      deferredInstallPrompt = null;
      document.getElementById("pwa-install-btn")?.classList.add("hidden");
    });

    // Background sync on page open if player name is already set.
    if (getPlayerName()) {
      setTimeout(() => {
        flushOfflineScoreQueue();
        syncProfile({ silent: true });
      }, 600);
    }

    document.querySelectorAll("[data-close]").forEach((btn) => {
      btn.addEventListener("click", () => closeModal(btn.dataset.close));
    });
    document.querySelectorAll(".modal-overlay").forEach((overlay) => {
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) closeModal(overlay.id);
      });
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const open = document.querySelector(".modal-overlay:not(.hidden)");
      if (open) closeModal(open.id);
    });
  }

  // Name gate shown before a Daily game when no player name is set yet.
  // Expects #name-gate, #gate-name-input, #gate-name-btn in the page.
  function wireNameGate(onSubmit) {
    const input = document.getElementById("gate-name-input");
    const btn = document.getElementById("gate-name-btn");
    btn.addEventListener("click", () => {
      const name = input.value.trim();
      if (!name) {
        input.focus();
        return;
      }
      setPlayerName(name);
      onSubmit(name);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") btn.click();
    });
  }

  // ---------- API ----------

  function enqueueOfflineScore(url, body) {
    try {
      const queue = load(OFFLINE_SCORES_KEY) || [];
      const key = `${url}|${body.date || ""}|${body.length || body.difficulty || ""}`;
      const filtered = queue.filter((item) => item.key !== key).slice(-60);
      filtered.push({ key, url, body, ts: Date.now() });
      localStorage.setItem(OFFLINE_SCORES_KEY, JSON.stringify(filtered));
    } catch {
      // ignore
    }
  }

  async function flushOfflineScoreQueue() {
    const queue = load(OFFLINE_SCORES_KEY);
    if (!Array.isArray(queue) || !queue.length) return;
    const remaining = [];
    for (const item of queue) {
      try {
        const res = await fetch(item.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(item.body),
        });
        if (!res.ok && res.status >= 500) remaining.push(item);
      } catch {
        remaining.push(item);
      }
    }
    try {
      if (remaining.length) localStorage.setItem(OFFLINE_SCORES_KEY, JSON.stringify(remaining));
      else localStorage.removeItem(OFFLINE_SCORES_KEY);
    } catch {
      // ignore
    }
  }

  async function postJSON(url, body, { keepalive = false } = {}) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        keepalive,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (url.endsWith("/score") && body && typeof body === "object") {
        enqueueOfflineScore(url, body);
      }
      throw err;
    }
  }

  async function getJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // Renders an array of row objects as the shared leaderboard table style.
  // columns: [{ label, value: (row) => string (already escaped/safe) }]
  function renderTable(container, rows, columns, emptyText) {
    if (!rows.length) {
      container.innerHTML = `<p class="lb-status">${escapeHtml(emptyText)}</p>`;
      return;
    }
    const me = getPlayerName();
    container.innerHTML = `
      <table class="lb-table">
        <thead><tr>${columns.map((c) => `<th>${c.label}</th>`).join("")}</tr></thead>
        <tbody>
          ${rows
            .map(
              (r) =>
                `<tr${r.name === me ? ' class="lb-me"' : ""}>${columns
                  .map((c) => `<td>${c.value(r)}</td>`)
                  .join("")}</tr>`
            )
            .join("")}
        </tbody>
      </table>`;
  }

  // ---------- sound effects: synthesized with Web Audio, no sound files ----------
  const SOUND_KEY = "wordly:sound";
  let actx = null;
  function soundOn() {
    try { return localStorage.getItem(SOUND_KEY) !== "off"; } catch { return true; }
  }
  function audio() {
    if (!actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      actx = new AC();
    }
    if (actx.state === "suspended") actx.resume();
    return actx;
  }
  function tone(c, t, freq, dur, opts = {}) {
    const { type = "sine", vol = 0.16, slideTo = null, attack = 0.008 } = opts;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  function noise(c, t, dur, vol, freq, q = 1) {
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = freq;
    f.Q.value = q;
    const g = c.createGain();
    g.gain.value = vol;
    src.connect(f).connect(g).connect(c.destination);
    src.start(t);
  }
  function quackAt(c, t, pitch = 1) {
    // a cartoon quack: buzzy sawtooth, pitch drops, shaped by two "beak" formants
    const o = c.createOscillator();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(520 * pitch, t);
    o.frequency.exponentialRampToValueAtTime(300 * pitch, t + 0.16);
    const f1 = c.createBiquadFilter(); f1.type = "bandpass"; f1.frequency.value = 1100; f1.Q.value = 3;
    const f2 = c.createBiquadFilter(); f2.type = "bandpass"; f2.frequency.value = 2400; f2.Q.value = 4;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.connect(f1).connect(g);
    o.connect(f2).connect(g);
    g.connect(c.destination);
    o.start(t);
    o.stop(t + 0.2);
  }
  const SFX = {
    tap: (c, t) => tone(c, t, 660, 0.06, { type: "triangle", vol: 0.08 }),
    place: (c, t) => { noise(c, t, 0.05, 0.5, 1800, 2); tone(c, t, 180, 0.07, { type: "triangle", vol: 0.12 }); },
    good: (c, t) => { tone(c, t, 660, 0.12, { vol: 0.14 }); tone(c, t + 0.09, 880, 0.18, { vol: 0.14 }); },
    great: (c, t) => [660, 830, 990, 1320].forEach((f, i) => tone(c, t + i * 0.07, f, 0.18, { vol: 0.13 })),
    bonus: (c, t) => [1320, 1760, 2090].forEach((f, i) => tone(c, t + i * 0.05, f, 0.12, { type: "triangle", vol: 0.09 })),
    wrong: (c, t) => { tone(c, t, 220, 0.14, { type: "square", vol: 0.06, slideTo: 160 }); tone(c, t + 0.12, 160, 0.2, { type: "square", vol: 0.06, slideTo: 120 }); },
    shuffle: (c, t) => { for (let i = 0; i < 4; i++) noise(c, t + i * 0.045, 0.05, 0.35, 2500 + i * 400, 3); },
    hint: (c, t) => { tone(c, t, 990, 0.1, { type: "triangle", vol: 0.1 }); tone(c, t + 0.1, 1320, 0.16, { type: "triangle", vol: 0.1 }); },
    win: (c, t) => { [523, 659, 784, 1047].forEach((f, i) => tone(c, t + i * 0.12, f, 0.22, { type: "triangle", vol: 0.16 })); tone(c, t + 0.5, 1047, 0.5, { vol: 0.12 }); quackAt(c, t + 0.75, 1.1); quackAt(c, t + 0.98, 1.2); },
    lose: (c, t) => [392, 349, 311, 262].forEach((f, i) => tone(c, t + i * 0.16, f, 0.24, { type: "triangle", vol: 0.12 })),
    quack: (c, t) => quackAt(c, t, 0.95 + Math.random() * 0.15),
    quack2: (c, t) => { quackAt(c, t, 1); quackAt(c, t + 0.2, 1.12); },
  };
  function sfx(name) {
    if (!soundOn() || !SFX[name]) return;
    const c = audio();
    if (!c) return;
    try { SFX[name](c, c.currentTime + 0.01); } catch { /* ignore audio errors */ }
  }
  function setSound(on) {
    try { localStorage.setItem(SOUND_KEY, on ? "on" : "off"); } catch { /* ignore */ }
    document.querySelectorAll(".sound-btn").forEach((b) => {
      b.querySelector(".btn-icon").innerHTML = on ? "&#128266;" : "&#128263;";
      b.querySelector(".btn-label").textContent = on ? "Sound on" : "Sound off";
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }


  return {
    sfx,
    soundOn,
    THEMES,
    load,
    save,
    todayDateString,
    shiftDate,
    msUntilNextMidnight,
    formatCountdown,
    formatDateLabel,
    formatTimer,
    hashString,
    seededRandom,
    shuffle,
    letterMask,
    bitCount,
    createStopwatch,
    getPlayerName,
    setPlayerName,
    showToast,
    escapeHtml,
    openModal,
    closeModal,
    onModalClose,
    anyModalOpen,
    applyTheme,
    shareText,
    syncProfile,
    initShell,
    initArchive,
    wireNameGate,
    postJSON,
    getJSON,
    renderTable,
  };
})();

// ---------------------------------------------------------------------------
// Extras: sound, the shared Locker (skins + effects earned in any game), the
// Guided Look shell and newspaper-style printing. Exposed as window.Extras.
// A game calls Extras.mount({ game, name, guide, print }) once, then the hooks:
//   Extras.sfx(event)            tap | erase | good | bad | reveal | win | lose | unlock
//   Extras.fxTap(el)             the "when you type/tap" effect on an element
//   Extras.fxGood(els)           the "when something is right" effect on elements
//   Extras.recordWin({ id, clean, ms, units }) -> newly unlocked items (plays win fx + sound)
// ---------------------------------------------------------------------------
window.Extras = (() => {
  "use strict";
  const S = window.Shared;
  let GAME = { game: "app", name: "Ducky Dailies" };

  // ---------- sound: tiny WebAudio synth, no audio files ----------
  const VOLUME_KEY = "ducky:volume";
  const VOLUMES = { high: 0.55, low: 0.2, mute: 0 };
  let volumeSetting = (() => {
    try {
      const v = localStorage.getItem(VOLUME_KEY) || localStorage.getItem("crossy:volume");
      return v in VOLUMES ? v : "low";
    } catch {
      return "low";
    }
  })();
  let actx = null;
  function audio() {
    if (!VOLUMES[volumeSetting]) return null;
    if (!actx) {
      try {
        actx = new (window.AudioContext || window.webkitAudioContext)();
      } catch {
        return null;
      }
    }
    if (actx.state === "suspended") actx.resume();
    return actx;
  }
  function tone(freq, dur, { type = "sine", gain = 1, at = 0, slide = 0, attack = 0.004 } = {}) {
    const ctx = audio();
    if (!ctx) return;
    const t = ctx.currentTime + at;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, VOLUMES[volumeSetting] * gain), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  function noise(dur, { gain = 1, at = 0, hp = 2000 } = {}) {
    const ctx = audio();
    if (!ctx) return;
    const t = ctx.currentTime + at;
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 3;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = "highpass";
    f.frequency.value = hp;
    const g = ctx.createGain();
    g.gain.value = VOLUMES[volumeSetting] * gain;
    src.connect(f).connect(g).connect(ctx.destination);
    src.start(t);
  }
  const notes = (list, step, opts) => list.forEach((f, i) => tone(f, opts.dur || 0.18, { ...opts, at: i * step }));
  const SOUND_PACKS = {
    classic: {
      tap: () => tone(720, 0.05, { type: "triangle", gain: 0.5 }),
      erase: () => tone(420, 0.05, { type: "triangle", gain: 0.35, slide: 0.8 }),
      good: () => notes([660, 990], 0.07, { type: "sine", gain: 0.6, dur: 0.16 }),
      bad: () => tone(170, 0.22, { type: "square", gain: 0.25, slide: 0.85 }),
      reveal: () => tone(520, 0.12, { type: "triangle", gain: 0.5, slide: 1.5 }),
      win: () => notes([523, 659, 784, 1047], 0.11, { type: "triangle", gain: 0.7, dur: 0.3 }),
      lose: () => notes([392, 330, 262], 0.16, { type: "triangle", gain: 0.45, dur: 0.3 }),
      unlock: () => notes([1047, 1319, 1568, 2093], 0.07, { type: "sine", gain: 0.45, dur: 0.22 }),
    },
    typewriter: {
      tap: () => { noise(0.03, { gain: 0.9, hp: 2500 }); tone(140, 0.03, { type: "square", gain: 0.12 }); },
      erase: () => noise(0.05, { gain: 0.5, hp: 900 }),
      good: () => tone(2100, 0.5, { type: "sine", gain: 0.35 }),
      bad: () => { noise(0.08, { gain: 0.8, hp: 300 }); tone(120, 0.12, { type: "square", gain: 0.2 }); },
      reveal: () => noise(0.12, { gain: 0.6, hp: 1500 }),
      win: () => { for (let i = 0; i < 6; i++) noise(0.03, { gain: 0.8, hp: 2200, at: i * 0.06 }); tone(2100, 0.9, { type: "sine", gain: 0.45, at: 0.42 }); },
      lose: () => noise(0.25, { gain: 0.6, hp: 400 }),
      unlock: () => [0, 0.18].forEach((at) => tone(2100, 0.5, { type: "sine", gain: 0.35, at })),
    },
    marimba: {
      tap: () => tone([523, 587, 659, 784, 880][Math.floor(Math.random() * 5)], 0.18, { type: "sine", gain: 0.45, attack: 0.002 }),
      erase: () => tone(392, 0.14, { type: "sine", gain: 0.3 }),
      good: () => notes([659, 784, 1047], 0.08, { type: "sine", gain: 0.5, dur: 0.3 }),
      bad: () => notes([311, 294], 0.1, { type: "sine", gain: 0.4, dur: 0.25 }),
      reveal: () => tone(880, 0.3, { type: "sine", gain: 0.4 }),
      win: () => notes([523, 659, 784, 880, 1047, 1319], 0.09, { type: "sine", gain: 0.55, dur: 0.5 }),
      lose: () => notes([440, 392, 330, 294], 0.12, { type: "sine", gain: 0.4, dur: 0.4 }),
      unlock: () => notes([1319, 1568, 2093], 0.08, { type: "sine", gain: 0.45, dur: 0.4 }),
    },
    chiptune: {
      tap: () => tone(990, 0.04, { type: "square", gain: 0.18 }),
      erase: () => tone(330, 0.06, { type: "square", gain: 0.15, slide: 0.6 }),
      good: () => notes([784, 1047, 1568], 0.05, { type: "square", gain: 0.2, dur: 0.08 }),
      bad: () => tone(110, 0.25, { type: "sawtooth", gain: 0.2, slide: 0.7 }),
      reveal: () => tone(440, 0.15, { type: "square", gain: 0.18, slide: 2 }),
      win: () => notes([523, 659, 784, 1047, 784, 1047, 1319, 1568], 0.075, { type: "square", gain: 0.22, dur: 0.12 }),
      lose: () => notes([392, 311, 262, 196], 0.12, { type: "square", gain: 0.2, dur: 0.14 }),
      unlock: () => notes([1568, 2093, 2637, 3136], 0.05, { type: "square", gain: 0.16, dur: 0.1 }),
    },
  };
  const LEGACY_EVENTS = { type: "tap", word: "good", wrong: "bad", solve: "win" };
  // Jumbly and Word Pond have their own quacky sound set (Shared.sfx + the header Sound button, body.has-sound).
  // There the Locker only adds its unlock chime, and it follows that page's on/off switch.
  const ownSound = () => document.body && document.body.classList.contains("has-sound");
  function sharedSoundOff() {
    try {
      return localStorage.getItem("wordly:sound") === "off";
    } catch {
      return false;
    }
  }
  function sfx(event) {
    if (ownSound()) {
      if (event === "unlock" && S.sfx && !sharedSoundOff()) S.sfx("bonus");
      return;
    }
    if (volumeSetting === "mute") return;
    try {
      const pack = SOUND_PACKS[locker.fx.sound] || SOUND_PACKS.classic;
      const fn = pack[event] || pack[LEGACY_EVENTS[event]];
      if (fn) fn();
    } catch {
      // audio is best-effort
    }
  }

  // ---------- the shared Locker ----------
  const LOCKER_KEY = "ducky:locker";
  const PACE = { quick: 4000, fast: 2500, blazing: 1600 }; // ms per unit (square / letter / tile)
  const defaults = () => ({
    solves: 0, clean: 0, quick: 0, fast: 0, blazing: 0, pbs: 0,
    best: {}, done: {}, games: {}, streak: { last: "", cur: 0, max: 0 },
    skin: "classic", fx: { type: "none", word: "none", solve: "none", sound: "classic" },
  });
  function loadLocker() {
    const d = defaults();
    let s = S.load(LOCKER_KEY);
    if (!s) {
      // carry over progress from the Crossy-only Locker
      const old = S.load("crossy:locker");
      s = old
        ? { ...old, games: { crossy: old.solves || 0 }, done: Object.fromEntries(Object.keys(old.done || {}).map((k) => [`crossy:${k}`, 1])) }
        : {};
    }
    return {
      ...d, ...s,
      best: { ...(s.best || {}) }, done: { ...(s.done || {}) }, games: { ...(s.games || {}) },
      streak: { ...d.streak, ...(s.streak || {}) }, fx: { ...d.fx, ...(s.fx || {}) },
    };
  }
  let locker = loadLocker();
  const saveLocker = () => S.save(LOCKER_KEY, locker);
  const gameCount = (p) => Object.values(p.games).filter((n) => n > 0).length;

  const SKINS = [
    { id: "classic", name: "Classic", desc: "The look you started with", req: () => [1, 1] },
    { id: "newsprint", name: "Newsprint", desc: "Win 1 game", req: (p) => [p.solves, 1] },
    { id: "pond", name: "Lily Pond", desc: "Win 5 games with no hints", req: (p) => [p.clean, 5] },
    { id: "chalk", name: "Chalkboard", desc: "Win 10 games", req: (p) => [p.solves, 10] },
    { id: "blueprint", name: "Blueprint", desc: "A Quick win (under 4s per square/letter, no hints)", req: (p) => [p.quick, 1] },
    { id: "neon", name: "Neon", desc: "Play 3 days in a row", req: (p) => [p.streak.max, 3] },
    { id: "mosaic", name: "Mosaic", desc: "Win in 5 different games", req: (p) => [gameCount(p), 5] },
    { id: "typewriter", name: "Typewriter", desc: "Win 25 games", req: (p) => [p.solves, 25] },
    { id: "midnight", name: "Midnight Gold", desc: "Play 7 days in a row", req: (p) => [p.streak.max, 7] },
    { id: "arcade", name: "Arcade", desc: "A Blazing win (under 1.6s per square/letter, no hints)", req: (p) => [p.blazing, 1] },
    { id: "sakura", name: "Sakura", desc: "Beat your own best time 5 times", req: (p) => [p.pbs, 5] },
    { id: "gilded", name: "Gilded", desc: "Win 100 games", req: (p) => [p.solves, 100] },
    { id: "aurora", name: "Aurora", desc: "Play 30 days in a row", req: (p) => [p.streak.max, 30] },
  ];
  const FX = {
    type: [
      { id: "none", name: "Off", desc: "", req: () => [1, 1] },
      { id: "pop", name: "Pop", desc: "Win 3 games", req: (p) => [p.solves, 3] },
      { id: "ink", name: "Ink drop", desc: "Win 10 games with no hints", req: (p) => [p.clean, 10] },
      { id: "spark", name: "Sparks", desc: "A Fast win (under 2.5s per square/letter, no hints)", req: (p) => [p.fast, 1] },
    ],
    word: [
      { id: "none", name: "Off", desc: "", req: () => [1, 1] },
      { id: "sweep", name: "Glow sweep", desc: "Win 5 games", req: (p) => [p.solves, 5] },
      { id: "wave", name: "Wave", desc: "Play 3 days in a row", req: (p) => [p.streak.max, 3] },
      { id: "stamp", name: "Ink stamp", desc: "Win 15 games with no hints", req: (p) => [p.clean, 15] },
    ],
    solve: [
      { id: "none", name: "Off", desc: "", req: () => [1, 1] },
      { id: "confetti", name: "Confetti", desc: "Win 1 game", req: (p) => [p.solves, 1] },
      { id: "extra", name: "EXTRA! EXTRA!", desc: "Win 25 games with no hints", req: (p) => [p.clean, 25] },
      { id: "fireworks", name: "Fireworks", desc: "Play 7 days in a row", req: (p) => [p.streak.max, 7] },
      { id: "ducks", name: "Duck parade", desc: "Win 50 games", req: (p) => [p.solves, 50] },
    ],
    sound: [
      { id: "classic", name: "Classic", desc: "", req: () => [1, 1] },
      { id: "typewriter", name: "Typewriter", desc: "Win 10 games", req: (p) => [p.solves, 10] },
      { id: "marimba", name: "Marimba", desc: "Play 3 days in a row", req: (p) => [p.streak.max, 3] },
      { id: "chiptune", name: "Chiptune", desc: "Win in 3 different games", req: (p) => [gameCount(p), 3] },
    ],
  };
  const SLOT_LABEL = { type: "When you type or tap", word: "When something is right", solve: "When you win", sound: "Sound pack" };
  const isUnlocked = (item) => { const [c, g] = item.req(locker); return c >= g; };
  const allItems = () => [
    ...SKINS.filter((x) => x.id !== "classic").map((x) => ({ ...x, kind: "skin" })),
    ...Object.entries(FX).flatMap(([slot, list]) => list.slice(1).map((x) => ({ ...x, kind: "fx", slot }))),
  ];
  const itemKey = (x) => (x.kind === "skin" ? `skin:${x.id}` : `fx:${x.slot}:${x.id}`);
  const reducedMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function applySkin() {
    const skin = SKINS.some((s) => s.id === locker.skin && isUnlocked(s)) ? locker.skin : "classic";
    SKINS.forEach((s) => {
      document.body.classList.toggle(`dx-skin-${s.id}`, s.id === skin);
      document.body.classList.toggle(`cw-skin-${s.id}`, s.id === skin); // Crossy board skins
    });
  }
  const dayDiff = (a, b) => Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 86400000);

  // A win in any game. id: unique per puzzle (counted once); units: squares/letters/tiles for the speed tiers.
  function recordWin({ id, clean = false, ms = 0, units = 0, sizeKey = "" } = {}) {
    const key = `${GAME.game}:${id}`;
    if (locker.done[key]) {
      fxWin();
      sfx("win");
      return [];
    }
    const before = new Set(allItems().filter(isUnlocked).map(itemKey));
    locker.done[key] = 1;
    locker.solves += 1;
    locker.games[GAME.game] = (locker.games[GAME.game] || 0) + 1;
    if (clean) locker.clean += 1;
    if (clean && ms > 0 && units > 0) {
      const pace = ms / units;
      if (pace <= PACE.quick) locker.quick += 1;
      if (pace <= PACE.fast) locker.fast += 1;
      if (pace <= PACE.blazing) locker.blazing += 1;
      const bk = `${GAME.game}:${sizeKey || units}`;
      if (locker.best[bk] && ms < locker.best[bk]) locker.pbs += 1;
      if (!locker.best[bk] || ms < locker.best[bk]) locker.best[bk] = ms;
    }
    const today = S.todayDateString();
    const st = locker.streak;
    if (st.last !== today) {
      st.cur = st.last && dayDiff(st.last, today) === 1 ? st.cur + 1 : 1;
      st.last = today;
      st.max = Math.max(st.max, st.cur);
    }
    const fresh = allItems().filter((x) => isUnlocked(x) && !before.has(itemKey(x)));
    fresh.forEach((x) => {
      if (x.kind === "skin" && locker.skin === "classic") locker.skin = x.id;
      if (x.kind === "fx" && x.slot !== "sound" && locker.fx[x.slot] === "none") locker.fx[x.slot] = x.id;
    });
    saveLocker();
    applySkin();
    fxWin();
    sfx("win");
    if (fresh.length) {
      setTimeout(() => sfx("unlock"), 900);
      unlockChip(fresh);
    }
    lastUnlocks = fresh;
    return fresh;
  }
  let lastUnlocks = [];

  // ---------- effects ----------
  function retrigger(el, cls, ms) {
    if (!el || !el.classList) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), ms);
  }
  function fxTap(el) {
    const kind = locker.fx.type;
    if (!el || kind === "none" || reducedMotion()) return;
    if (kind === "pop") retrigger(el, "fx-pop", 260);
    if (kind === "ink") retrigger(el, "fx-ink", 520);
    if (kind === "spark") {
      retrigger(el, "fx-spark", 420);
      burst(el.getBoundingClientRect(), 7, ["#ffd34d", "#ff9f1c", "#fff3b0"], 0.6);
    }
  }
  function fxGood(els) {
    const kind = locker.fx.word;
    if (kind === "none" || reducedMotion() || !els) return;
    Array.from(els).forEach((el, k) => setTimeout(() => retrigger(el, `fx-${kind}`, 600), k * 45));
  }
  let fxCanvas = null;
  let fxParts = [];
  let fxRaf = 0;
  function fxLoop() {
    const ctx = fxCanvas.getContext("2d");
    ctx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
    fxParts = fxParts.filter((p) => p.life > 0);
    fxParts.forEach((p) => {
      p.vy += p.g; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.life -= 1; p.rot += p.vr;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life / 40));
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.c;
      if (p.shape === "dot") { ctx.beginPath(); ctx.arc(0, 0, p.s / 2, 0, 6.283); ctx.fill(); }
      else ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
      ctx.restore();
    });
    if (fxParts.length) fxRaf = requestAnimationFrame(fxLoop);
    else { fxCanvas.remove(); fxCanvas = null; fxRaf = 0; }
  }
  function ensureCanvas() {
    if (!fxCanvas) {
      fxCanvas = document.createElement("canvas");
      fxCanvas.className = "fx-canvas";
      document.body.appendChild(fxCanvas);
    }
    fxCanvas.width = window.innerWidth;
    fxCanvas.height = window.innerHeight;
    if (!fxRaf) fxRaf = requestAnimationFrame(fxLoop);
  }
  function burst(rect, n, colors, power = 1) {
    ensureCanvas();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.283;
      const v = (1.5 + Math.random() * 3.5) * power;
      fxParts.push({ x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 1.5 * power, g: 0.12, life: 30 + Math.random() * 25, c: colors[i % colors.length], s: 3 + Math.random() * 3, rot: 0, vr: 0, shape: "dot" });
    }
  }
  function confetti() {
    ensureCanvas();
    const colors = ["#f94144", "#f8961e", "#f9c74f", "#90be6d", "#43aa8b", "#577590", "#c77dff"];
    for (let i = 0; i < 160; i++) {
      fxParts.push({ x: Math.random() * window.innerWidth, y: -20 - Math.random() * 200, vx: (Math.random() - 0.5) * 2.5, vy: 2 + Math.random() * 3, g: 0.05, life: 150 + Math.random() * 80, c: colors[i % colors.length], s: 7 + Math.random() * 6, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3, shape: "rect" });
    }
  }
  function fireworks() {
    const palette = [["#ff4d6d", "#ffb3c1"], ["#4cc9f0", "#bde0fe"], ["#ffd60a", "#fff3b0"], ["#80ffdb", "#c7f9cc"], ["#c77dff", "#e0aaff"]];
    for (let k = 0; k < 6; k++) {
      setTimeout(() => {
        const x = window.innerWidth * (0.2 + Math.random() * 0.6);
        const y = window.innerHeight * (0.15 + Math.random() * 0.35);
        burst({ left: x, top: y, width: 0, height: 0 }, 70, palette[k % palette.length], 1.8);
      }, k * 380);
    }
  }
  function overlayFx(cls, html, ms) {
    const el = document.createElement("div");
    el.className = `fx-overlay ${cls}`;
    el.innerHTML = html;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }
  function fxWin() {
    const kind = locker.fx.solve;
    if (kind === "none" || reducedMotion()) return;
    if (kind === "confetti") confetti();
    if (kind === "fireworks") fireworks();
    if (kind === "extra") overlayFx("fx-extra", `<div class="fx-extra-paper"><div class="fx-extra-kicker">EXTRA! EXTRA!</div><div class="fx-extra-head">${S.escapeHtml(GAME.name).toUpperCase()} SOLVED</div></div>`, 2600);
    if (kind === "ducks") overlayFx("fx-ducks", Array.from({ length: 7 }, (_, i) => `<span style="animation-delay:${i * 0.22}s">${i === 0 ? "🦆" : "🐥"}</span>`).join(""), 4200);
  }

  function itemLabel(x) {
    return x.kind === "skin" ? "Skin" : { type: "Typing effect", word: "Word effect", solve: "Win effect", sound: "Sound pack" }[x.slot];
  }
  function unlockBlurb(items) {
    if (!items || !items.length) return "";
    return `<div class="locker-new"><div class="locker-new-title">&#127873; New unlock${items.length > 1 ? "s" : ""}</div>${items
      .map((x) => `<div class="locker-new-item">${itemLabel(x)}: <b>${S.escapeHtml(x.name)}</b></div>`)
      .join("")}<button type="button" class="pill-btn locker-open-btn">Open Locker</button></div>`;
  }
  function unlockChip(items) {
    S.showToast(`🎁 Unlocked: ${items.map((x) => x.name).join(", ")}`, 2600);
    const old = document.getElementById("dx-unlock-chip");
    if (old) old.remove();
    const chip = document.createElement("button");
    chip.id = "dx-unlock-chip";
    chip.type = "button";
    chip.className = "dx-unlock-chip";
    chip.innerHTML = `&#127873; ${items.length} new unlock${items.length > 1 ? "s" : ""} &middot; Open Locker`;
    chip.addEventListener("click", () => {
      chip.remove();
      document.querySelectorAll(".modal-overlay:not(.hidden)").forEach((m) => S.closeModal(m.id));
      openLocker();
    });
    document.body.appendChild(chip);
    setTimeout(() => chip.remove(), 12000);
  }

  // ---------- Locker modal ----------
  function lockerHtml() {
    const e = S.escapeHtml;
    const bar = (item) => {
      const [c, g] = item.req(locker);
      return `<div class="locker-bar"><span style="width:${Math.min(100, (100 * c) / g)}%"></span></div><div class="locker-req">${e(item.desc)} &middot; ${Math.min(c, g)}/${g}</div>`;
    };
    const skins = SKINS.map((s) => {
      const open = isUnlocked(s);
      const on = locker.skin === s.id;
      return `<button type="button" class="locker-skin ${open ? "" : "locked"} ${on ? "on" : ""}" data-skin="${s.id}" ${open ? "" : "disabled"}>
          <span class="locker-swatch cw-swatch-${s.id}"><i></i><i></i><i class="b"></i><i></i></span>
          <span class="locker-name">${open ? "" : "&#128274; "}${e(s.name)}${on ? " &#10003;" : ""}</span>
          ${open ? "" : bar(s)}
        </button>`;
    }).join("");
    const slots = Object.entries(FX).map(([slot, list]) => `<div class="locker-slot"><h4>${SLOT_LABEL[slot]}</h4><div class="locker-chips">${list
      .map((x) => {
        const open = isUnlocked(x);
        const on = locker.fx[slot] === x.id;
        return `<button type="button" class="locker-chip ${on ? "on" : ""} ${open ? "" : "locked"}" data-slot="${slot}" data-fx="${x.id}" ${open ? "" : "disabled"} title="${e(x.desc)}">${open ? "" : "&#128274; "}${e(x.name)}</button>`;
      })
      .join("")}</div>${list.filter((x) => !isUnlocked(x)).map((x) => `<div class="locker-req">&#128274; ${e(x.name)}: ${e(x.desc)} &middot; ${Math.min(...x.req(locker))}/${x.req(locker)[1]}</div>`).join("")}</div>`).join("");
    const st = locker.streak;
    const cur = st.last && dayDiff(st.last, S.todayDateString()) <= 1 ? st.cur : 0;
    return `
      <div class="locker-stats">
        <div><b>${locker.solves}</b><span>wins</span></div>
        <div><b>${locker.clean}</b><span>no-hint</span></div>
        <div><b>${cur}&#128293;</b><span>day streak</span></div>
        <div><b>${st.max}</b><span>best streak</span></div>
        <div><b>${gameCount(locker)}</b><span>games won</span></div>
      </div>
      <h3>Skins</h3><div class="locker-skins">${skins}</div>
      <h3>Effects &amp; sound</h3>${slots}
      <p class="locker-note">One Locker for every game on this device. Speed tiers count only no-hint wins: Quick under 4s per square or letter, Fast under 2.5s, Blazing under 1.6s. Each puzzle counts once. Skins restyle the board frame in every game and the whole grid in Crossy.</p>`;
  }
  function renderLocker() {
    const body = document.getElementById("locker-body");
    if (!body) return;
    body.innerHTML = lockerHtml();
    body.querySelectorAll("[data-skin]").forEach((b) => b.addEventListener("click", () => {
      locker.skin = b.dataset.skin;
      saveLocker();
      applySkin();
      renderLocker();
    }));
    body.querySelectorAll("[data-fx]").forEach((b) => b.addEventListener("click", () => {
      locker.fx[b.dataset.slot] = b.dataset.fx;
      saveLocker();
      renderLocker();
      if (b.dataset.slot === "solve") fxWin();
      if (b.dataset.slot === "sound") sfx("win");
    }));
  }
  function openLocker() {
    renderLocker();
    S.openModal("locker-modal");
  }

  // ---------- word frequencies for Guided Look (lazy-loaded once) ----------
  let freqWords = null;
  let freqLoading = null;
  function loadWords() {
    if (freqWords) return Promise.resolve(freqWords);
    if (freqLoading) return freqLoading;
    freqLoading = new Promise((resolve, reject) => {
      const done = () => {
        const raw = window.CROSSY_GUIDE_WORDS || {};
        freqWords = { byLen: {}, z: new Map() };
        Object.entries(raw).forEach(([len, buckets]) => {
          freqWords.byLen[len] = [];
          buckets.forEach(([z, words]) => words.split(" ").forEach((w) => {
            const W = w.toUpperCase();
            freqWords.byLen[len].push([W, z / 10]);
            freqWords.z.set(W, z / 10);
          }));
        });
        resolve(freqWords);
      };
      if (window.CROSSY_GUIDE_WORDS) return done();
      const s = document.createElement("script");
      s.src = "/words-guide.js?v=1";
      s.onload = done;
      s.onerror = () => {
        freqLoading = null;
        reject(new Error("Couldn't load the word list"));
      };
      document.head.appendChild(s);
    });
    return freqLoading;
  }
  // [{w, p}] from [[word, zipf, multiplier?]]
  function rank(list) {
    const total = list.reduce((s, [, z, m = 1]) => s + 10 ** z * m, 0) || 1;
    return list.map(([w, z, m = 1]) => ({ w, p: (10 ** z * m) / total })).sort((a, b) => b.p - a.p);
  }
  const pct = (p) => (p >= 0.995 ? "99%" : p < 0.005 ? "<1%" : `${Math.round(p * 100)}%`);
  // ranked rows as the shared Guided Look list
  function guideList(rows, { have = () => false, max = 8 } = {}) {
    // identical-looking rows (e.g. masked words with the same start and length) are merged and their odds added
    const merged = [];
    const at = new Map();
    rows.forEach((r) => {
      const k = `${r.w}|${r.tag || ""}`;
      if (at.has(k)) merged[at.get(k)].p += r.p;
      else { at.set(k, merged.length); merged.push({ ...r }); }
    });
    const counts = new Map();
    rows.forEach((r) => { const k = `${r.w}|${r.tag || ""}`; counts.set(k, (counts.get(k) || 0) + 1); });
    merged.forEach((m) => { const c = counts.get(`${m.w}|${m.tag || ""}`); if (c > 1) m.tag = `${m.tag ? `${m.tag} · ` : ""}${c} words`; });
    merged.sort((x, y) => y.p - x.p);
    return `<ol class="guide-list">${merged.slice(0, max).map(({ w, p, tag }) => `<li><span class="guide-word">${String(w).split("").map((ch, k) => `<i class="${have(k, ch) ? "have" : ""}">${S.escapeHtml(ch)}</i>`).join("")}</span><span class="guide-bar"><span style="width:${Math.max(2, Math.round(p * 100))}%"></span></span><span class="guide-p">${pct(p)}</span>${tag ? `<span class="guide-tag">${tag}</span>` : ""}</li>`).join("")}</ol>`;
  }

  // ---------- Guided Look shell ----------
  function showGuide(title, html) {
    document.getElementById("guide-title").textContent = title;
    document.getElementById("guide-body").innerHTML = html;
    S.openModal("guide-modal");
  }

  // ---------- newspaper-style printing ----------
  // pages: [{ title, by, bodyHtml, tag, answer: bool }]
  function printPages(pages) {
    const e = S.escapeHtml;
    let sheet = document.getElementById("print-sheet");
    if (!sheet) {
      sheet = document.createElement("div");
      sheet.id = "print-sheet";
      document.body.appendChild(sheet);
    }
    sheet.className = "pn";
    sheet.innerHTML = pages
      .map((p) => `<div class="ps-page pn-page ${p.answer ? "pn-answers" : ""}">
          <div class="pn-head"><div class="pn-title">${e(p.title)}</div>${p.by ? `<div class="pn-by">${e(p.by)}</div>` : ""}${p.answer ? "" : `<div class="pn-name">Name ______________________</div>`}</div>
          ${p.bodyHtml}
          ${p.tag ? `<div class="pn-foot"><span class="pn-tag">${e(p.tag)}</span></div>` : ""}
        </div>`)
      .join("");
    setTimeout(() => window.print(), 60);
  }
  const dateTag = (d = new Date()) => `${d.getMonth() + 1}-${d.getDate()}`;

  // ---------- buttons + modals ----------
  function addButton(row, id, icon, label, title, onClick, before) {
    if (document.getElementById(id)) return document.getElementById(id);
    const btn = document.createElement("button");
    btn.id = id;
    btn.type = "button";
    btn.className = "icon-btn labeled-btn";
    btn.title = title;
    btn.setAttribute("aria-label", title);
    btn.innerHTML = `<span class="btn-icon" aria-hidden="true">${icon}</span><span class="btn-label">${label}</span>`;
    btn.addEventListener("click", onClick);
    const ref = before && document.getElementById(before);
    if (ref && ref.parentNode === row) row.insertBefore(btn, ref);
    else row.appendChild(btn);
    return btn;
  }
  function modalShell(id, inner, wide) {
    if (document.getElementById(id)) return;
    document.body.insertAdjacentHTML("beforeend", `<div id="${id}" class="modal-overlay hidden"><div class="modal ${wide ? "modal-wide" : ""}">
      <button class="modal-close" data-close="${id}" aria-label="Close">&times;</button>${inner}</div></div>`);
    const modal = document.getElementById(id);
    modal.querySelector(".modal-close").addEventListener("click", () => S.closeModal(id));
    modal.addEventListener("click", (ev) => { if (ev.target === modal) S.closeModal(id); });
  }
  function paintVolume(btn) {
    const label = { high: "Loud", low: "Quiet", mute: "Muted" }[volumeSetting];
    const icon = { high: "&#128266;", low: "&#128265;", mute: "&#128263;" }[volumeSetting];
    btn.innerHTML = `<span class="btn-icon" aria-hidden="true">${icon}</span><span class="btn-label">${label}</span>`;
    btn.title = `Sound: ${label} (click to change)`;
    btn.setAttribute("aria-label", `Sound ${label}`);
  }

  // opts: { game, name, guide?: () => void, guideLabel?, print?: () => void }
  function mount(opts = {}) {
    GAME = { ...GAME, ...opts };
    applySkin();
    modalShell("locker-modal", `<div class="locker-modal"><h2>&#127912; Locker</h2><p class="archive-sub">Skins, effects and sounds you earn by winning any game.</p><div id="locker-body"></div></div>`, true);
    modalShell("guide-modal", `<div class="guide-modal"><h2>&#128269; Guided Look</h2><p id="guide-title" class="archive-sub"></p><div id="guide-body"></div></div>`);
    if (!mount.wired) {
      mount.wired = true;
      document.addEventListener("click", (ev) => {
        if (ev.target.closest && ev.target.closest(".locker-open-btn")) {
          document.querySelectorAll(".modal-overlay:not(.hidden)").forEach((m) => S.closeModal(m.id));
          openLocker();
        }
      });
    }
    const row = document.querySelector(".controls-row");
    if (!row) return;
    const vol = ownSound() ? null : addButton(row, "volume-btn", "", "", "Sound", () => {
      volumeSetting = { low: "high", high: "mute", mute: "low" }[volumeSetting];
      try {
        localStorage.setItem(VOLUME_KEY, volumeSetting);
      } catch {
        // ignore
      }
      paintVolume(vol);
      sfx("good");
    });
    if (vol) paintVolume(vol);
    addButton(row, "locker-btn", "&#127912;", "Locker", "Skins and effects", openLocker);
    if (typeof opts.guide === "function") addButton(row, "dx-guide-btn", "&#128269;", opts.guideLabel || "Guide", "Guided Look", opts.guide);
    if (typeof opts.print === "function") addButton(row, "dx-print-btn", "&#128424;&#65039;", "Print", "Print a newspaper-style copy", opts.print);
  }

  return {
    mount, sfx, fxTap, fxGood, fxWin, recordWin, unlockBlurb, openLocker, showGuide, printPages, dateTag,
    loadWords, rank, pct, guideList,
    get lastUnlocks() { return lastUnlocks; },
    get volume() { return volumeSetting; },
  };
})();
