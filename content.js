'use strict';

// Content script for udemy.com.
//
// Flow:
//   1. A MutationObserver notices caption changes (coalesced into one sync per tick).
//   2. sync() reads the native caption text (hidden via content.css while active).
//   3. The extension renders its own overlay with the original line and/or the
//      translation, depending on settings.displayMode.
//   4. Translations are fetched via the background worker and cached per tab.

(() => {
  if (globalThis.__UST_CONTENT_LOADED) return;
  globalThis.__UST_CONTENT_LOADED = true;

  const { LOG_PREFIX, DEFAULTS, MESSAGES, normalizeSettings, loadSettings } = globalThis.UST;

  // ─── Constants ───────────────────────────────────────────────────────────────
  // Udemy uses CSS modules with hashed class names. The data-purpose attribute is
  // the most stable hook; the class-based selectors are fallbacks.
  const CAPTION_SELECTORS = [
    '[data-purpose="captions-cue-text"]',
    '[class*="captions-cue-text"]',
    '[class^="well--text--"]',
    '[class*=" well--text--"]',
  ];
  const ACTIVE_CLASS = 'ust-active';
  const OVERLAY_CLASS = 'ust-overlay';
  const NATIVE_ATTR = 'data-ust-native'; // hidden by content.css while active
  const SYNC_DELAY_MS = 50;
  const CACHE_LIMIT = 500;

  // ─── State ───────────────────────────────────────────────────────────────────
  const state = {
    cfg: { ...DEFAULTS },
    original: '',      // caption text currently displayed
    translation: '',   // translation of `original` ('' while pending)
    href: location.href,
    overlay: null,
    syncScheduled: false,
  };

  const cache = new Map();     // key -> translation (insertion order = LRU order)
  const inFlight = new Set();  // keys being translated right now

  // ─── Helpers ─────────────────────────────────────────────────────────────────
  const normalizeText = text => (text ?? '').replace(/\s+/g, ' ').trim();

  const cacheKey = text => `${state.cfg.sourceLang}|${state.cfg.lang}|${text}`;

  function cacheGet(key) {
    if (!cache.has(key)) return undefined;
    const value = cache.get(key);
    cache.delete(key); // refresh LRU position
    cache.set(key, value);
    return value;
  }

  function cacheSet(key, value) {
    cache.set(key, value);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  }

  function findCaption() {
    for (const selector of CAPTION_SELECTORS) {
      const el = document.querySelector(selector);
      if (el?.textContent.trim()) return el;
    }
    return null;
  }

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  // ─── Translation ─────────────────────────────────────────────────────────────
  async function translate(text) {
    const res = await chrome.runtime.sendMessage({
      type: MESSAGES.TRANSLATE,
      text,
      sourceLang: state.cfg.sourceLang,
      targetLang: state.cfg.lang,
    });
    if (!res) throw new Error('No response from background worker');
    if (res.error) throw new Error(res.error);
    return res.translated ?? '';
  }

  async function requestTranslation(text) {
    const key = cacheKey(text);
    if (inFlight.has(key)) return;
    inFlight.add(key);

    try {
      const translated = await translate(text);
      if (!translated) return;
      cacheSet(key, translated);
      // Ignore stale responses: caption or language may have changed meanwhile.
      if (state.original === text && cacheKey(text) === key) {
        state.translation = translated;
        render(findCaption());
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} translation error:`, err.message);
    } finally {
      inFlight.delete(key);
    }
  }

  // ─── Overlay ─────────────────────────────────────────────────────────────────
  // The overlay lives next to the native caption, inside Udemy's caption container,
  // which is already positioned over the video and not clipped. If Udemy re-renders
  // that container, the overlay is re-attached on the next sync.
  function ensureOverlay(host) {
    if (state.overlay?.parentElement === host) return state.overlay;

    state.overlay?.remove();
    const overlay = document.createElement('div');
    overlay.className = OVERLAY_CLASS;

    const original = document.createElement('div');
    original.className = 'ust-line ust-line--original';
    const translation = document.createElement('div');
    translation.className = 'ust-line ust-line--translation';

    overlay.append(original, translation);
    host.append(overlay);
    state.overlay = overlay;
    return overlay;
  }

  function removeOverlay() {
    state.overlay?.remove();
    state.overlay = null;
  }

  function render(captionEl) {
    if (!captionEl?.parentElement || !state.original) {
      if (state.overlay) state.overlay.hidden = true;
      return;
    }

    const overlay = ensureOverlay(captionEl.parentElement);
    const [originalEl, translationEl] = overlay.children;

    overlay.dataset.mode = state.cfg.displayMode;
    overlay.style.setProperty('--ust-font-size', `${state.cfg.fontSize}%`);
    setText(originalEl, state.original);
    setText(translationEl, state.translation);
    overlay.hidden = false;
  }

  // ─── Sync loop ───────────────────────────────────────────────────────────────
  function resetCaption() {
    state.original = '';
    state.translation = '';
  }

  function sync() {
    state.syncScheduled = false;

    // Udemy is a SPA – lecture changes don't reload the page.
    if (location.href !== state.href) {
      state.href = location.href;
      resetCaption();
      removeOverlay();
    }

    const { enabled } = state.cfg;
    document.documentElement.classList.toggle(ACTIVE_CLASS, enabled);

    if (!enabled) {
      resetCaption();
      removeOverlay();
      return;
    }

    const captionEl = findCaption();
    const text = normalizeText(captionEl?.textContent);
    // Mark the native caption so content.css hides it (no-op if already marked).
    if (captionEl && !captionEl.hasAttribute(NATIVE_ATTR)) captionEl.setAttribute(NATIVE_ATTR, '');

    if (text !== state.original) {
      state.original = text;
      state.translation = text ? cacheGet(cacheKey(text)) ?? '' : '';
      if (text && !state.translation) requestTranslation(text);
    }

    render(captionEl);
  }

  // Coalesce bursts of mutations (the player mutates the DOM constantly) into a
  // single sync. Unlike a reset-on-every-event debounce, this cannot starve.
  function scheduleSync() {
    if (state.syncScheduled) return;
    state.syncScheduled = true;
    setTimeout(sync, SYNC_DELAY_MS);
  }

  // ─── Settings ────────────────────────────────────────────────────────────────
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;

    const next = { ...state.cfg };
    for (const [key, { newValue }] of Object.entries(changes)) next[key] = newValue;
    state.cfg = normalizeSettings(next);

    // Language change → force re-translation of the current caption.
    if ('lang' in changes || 'sourceLang' in changes) resetCaption();

    scheduleSync();
  });

  // ─── Popup status ────────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== MESSAGES.GET_STATUS) return false;
    sendResponse({
      enabled: state.cfg.enabled,
      displayMode: state.cfg.displayMode,
      captionFound: Boolean(findCaption()),
    });
    return false; // responded synchronously
  });

  // ─── Init ────────────────────────────────────────────────────────────────────
  // Settings are loaded before observing, so the first caption already uses the
  // user's language and display mode.
  loadSettings()
    .then(cfg => {
      state.cfg = cfg;
      new MutationObserver(scheduleSync).observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      scheduleSync();
      console.log(`${LOG_PREFIX} Udemy Subtitle Translate v${chrome.runtime.getManifest().version} loaded`);
    })
    .catch(err => console.warn(`${LOG_PREFIX} init failed:`, err.message));
})();
