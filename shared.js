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
  });

  const FONT_SIZE_MIN = 60;
  const FONT_SIZE_MAX = 200;

  const MESSAGES = Object.freeze({
    TRANSLATE: 'ust/translate',
    GET_STATUS: 'ust/getStatus',
  });

  const COMMANDS = Object.freeze({
    TOGGLE_DISPLAY_MODE: 'toggle-display-mode',
    TOGGLE_ENABLED: 'toggle-enabled',
  });

  /** Returns a complete, validated settings object. */
  function normalizeSettings(raw) {
    const s = { ...DEFAULTS, ...raw };
    if (!Object.values(DISPLAY_MODES).includes(s.displayMode)) {
      s.displayMode = DEFAULTS.displayMode;
    }
    const size = Number(s.fontSize);
    s.fontSize = Number.isFinite(size)
      ? Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, size))
      : DEFAULTS.fontSize;
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
    MESSAGES,
    COMMANDS,
    normalizeSettings,
    loadSettings,
    saveSettings,
  });
})(globalThis);
