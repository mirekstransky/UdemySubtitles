'use strict';

// Shared constants and settings helpers.
// Loaded by: background.js (importScripts), content scripts (manifest, before content.js)
// and popup.html (<script>). Exposes a single frozen namespace: globalThis.UST.

(function (root) {
  const DISPLAY_MODES = Object.freeze({
    BOTH: 'both',               // original caption + translation below it
    TRANSLATION: 'translation', // translation only
  });

  const DEFAULTS = Object.freeze({
    enabled: true,
    lang: 'cs',
    sourceLang: 'auto',
    fontSize: 110,
    displayMode: DISPLAY_MODES.BOTH,
    // Vertical shift in % of the video height; positive = up, 0 = Udemy's native position.
    verticalOffset: 0,
    // Subtitle timing shift in seconds; negative = show earlier, positive = later.
    // Only applies when subtitles are driven by the .vtt file (see content.js).
    timingOffset: 0,
  });

  const FONT_SIZE_MIN = 60;
  const FONT_SIZE_MAX = 200;
  const OFFSET_MIN = -10;
  const OFFSET_MAX = 80;
  const OFFSET_STEP = 5;
  const TIMING_MIN = -3;
  const TIMING_MAX = 3;
  const TIMING_STEP = 0.1;

  const clamp = (value, min, max, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };

  const MESSAGES = Object.freeze({
    TRANSLATE: 'ust/translate',
    TRANSLATE_BATCH: 'ust/translateBatch',
    FETCH_VTT: 'ust/fetchVtt',
    GET_STATUS: 'ust/getStatus',
  });

  const COMMANDS = Object.freeze({
    TOGGLE_DISPLAY_MODE: 'toggle-display-mode',
    TOGGLE_ENABLED: 'toggle-enabled',
    MOVE_UP: 'move-up',
    MOVE_DOWN: 'move-down',
  });

  /** Returns a complete, validated settings object. */
  function normalizeSettings(raw) {
    const s = { ...DEFAULTS, ...raw };
    if (!Object.values(DISPLAY_MODES).includes(s.displayMode)) {
      s.displayMode = DEFAULTS.displayMode;
    }
    s.fontSize = clamp(s.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX, DEFAULTS.fontSize);
    s.verticalOffset = clamp(s.verticalOffset, OFFSET_MIN, OFFSET_MAX, DEFAULTS.verticalOffset);
    s.timingOffset =
      Math.round(clamp(s.timingOffset, TIMING_MIN, TIMING_MAX, DEFAULTS.timingOffset) * 10) / 10;
    s.enabled = Boolean(s.enabled);
    return s;
  }

  async function loadSettings() {
    // Passing the defaults object returns stored values with defaults filled in.
    return normalizeSettings(await chrome.storage.sync.get(DEFAULTS));
  }

  function saveSettings(partial) {
    return chrome.storage.sync.set(partial);
  }

  // ─── Logging ─────────────────────────────────────────────────────────────────
  // Normal operation: errors, warnings and a few one-off info lines.
  // Debug mode (popup checkbox, stored per device in storage.local) adds details.
  const LOG_PREFIX = '[UdemySubtitles]';
  const DEBUG_KEY = 'debug';
  const LOG_LEVELS = Object.freeze({ error: 0, warn: 1, info: 2, debug: 3 });

  function createLogger() {
    let level = LOG_LEVELS.info;
    const apply = debug => (level = debug ? LOG_LEVELS.debug : LOG_LEVELS.info);

    // Logging must never break the extension – storage problems only disable debug mode.
    try {
      chrome.storage.local
        .get({ [DEBUG_KEY]: false })
        .then(r => apply(r[DEBUG_KEY]))
        .catch(() => {});
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && DEBUG_KEY in changes) apply(changes[DEBUG_KEY].newValue);
      });
    } catch {
      /* storage unavailable – stay at info level */
    }

    // Getters hand out console methods pre-bound with the prefix (or a no-op), so
    // DevTools shows the caller's file:line instead of this file.
    // console.debug is hidden in DevTools by default ("Verbose"), so debug uses log.
    const noop = () => {};
    const bound = (method, tag) => console[method].bind(console, tag ? `${LOG_PREFIX} ${tag}` : LOG_PREFIX);
    const methods = {
      error: bound('error'),
      warn: bound('warn'),
      info: bound('log'),
      debug: bound('log', '[debug]'),
    };
    const pick = lvl => (LOG_LEVELS[lvl] <= level ? methods[lvl] : noop);
    return Object.freeze({
      get error() { return pick('error'); },
      get warn() { return pick('warn'); },
      get info() { return pick('info'); },
      get debug() { return pick('debug'); },
    });
  }

  root.UST = Object.freeze({
    LOG_PREFIX,
    DEBUG_KEY,
    createLogger,
    DISPLAY_MODES,
    DEFAULTS,
    FONT_SIZE_MIN,
    FONT_SIZE_MAX,
    OFFSET_MIN,
    OFFSET_MAX,
    OFFSET_STEP,
    TIMING_MIN,
    TIMING_MAX,
    TIMING_STEP,
    MESSAGES,
    COMMANDS,
    normalizeSettings,
    loadSettings,
    saveSettings,
  });
})(globalThis);
