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
  });

  const FONT_SIZE_MIN = 60;
  const FONT_SIZE_MAX = 200;
  const OFFSET_MIN = -10;
  const OFFSET_MAX = 80;
  const OFFSET_STEP = 5;

  const clamp = (value, min, max, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };

  const MESSAGES = Object.freeze({
    TRANSLATE: 'ust/translate',
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

  root.UST = Object.freeze({
    LOG_PREFIX: '[UST]',
    DISPLAY_MODES,
    DEFAULTS,
    FONT_SIZE_MIN,
    FONT_SIZE_MAX,
    OFFSET_MIN,
    OFFSET_MAX,
    OFFSET_STEP,
    MESSAGES,
    COMMANDS,
    normalizeSettings,
    loadSettings,
    saveSettings,
  });
})(globalThis);
