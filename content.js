'use strict';

// Content script for udemy.com.
//
// Subtitle sources (first available wins), one renderer:
//
//   1. Udemy REST API – the lecture's caption list (all languages + .vtt URLs) is
//      requested from /api-2.0/... as soon as the lecture opens, independent of the
//      player state. The language selected in the player is preferred.
//   2. Player request – a PerformanceObserver spots the .vtt file the player itself
//      downloads (used when the REST call is not possible / fails).
//   3. DOM – until a .vtt file is available, the native caption element is read via
//      a MutationObserver and each new line is translated on demand.
//
// With 1 and 2 the .vtt file is fetched via the background worker, parsed and
// translated AHEAD of playback in batches. Subtitles are then shown by
// video.currentTime on every animation frame, so the translation appears together
// with the speech and can be shifted in time.
//
// While the extension is enabled, Udemy's native caption text is hidden (content.css)
// and the extension renders its own overlay with the original and/or translation.

(() => {
  if (globalThis.__UST_CONTENT_LOADED) return;
  globalThis.__UST_CONTENT_LOADED = true;

  const { DEFAULTS, MESSAGES, SYNC_MODES, EXPORT_FORMATS, normalizeSettings, loadSettings, createLogger } =
    globalThis.UST;
  const log = createLogger();

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
  const FLOATING_CLASS = 'ust-overlay--floating';
  const NATIVE_ATTR = 'data-ust-native'; // hidden by content.css while active
  const SYNC_DELAY_MS = 50;
  const CACHE_LIMIT = 500;

  // Translate-ahead batching (one request per batch).
  // The background worker splits a batch further if a single request would be too long.
  const BATCH_MAX_CHARS = 4500;
  const BATCH_MAX_CUES = 100;
  const BATCH_MAX_FAILURES = 5;
  const BATCH_RETRY_DELAY_MS = 2000;  // doubled after each consecutive failure
  const RATE_LIMIT_DELAY_MS = 15000;  // after HTTP 429
  const SINGLE_RETRY_DELAY_MS = 5000; // on-demand translation of one line after a failure

  // Floating overlay (VTT mode): position and font scale relative to the video.
  const FLOATING_BASE_BOTTOM_PCT = 12;
  const FLOATING_FONT_PER_VIDEO_HEIGHT = 0.04; // 450 px video → 18 px at 100 %

  // ─── State ───────────────────────────────────────────────────────────────────
  const state = {
    cfg: { ...DEFAULTS },
    context: null, // identity of the current lecture / video – see contextKey()
    overlay: null,
    syncScheduled: false,
    rafId: 0,
    // DOM fallback
    dom: { original: '', display: '', translation: '' }, // display = text shown as original
    // VTT source: { id, url, context, locale, label, origin, cues: [{ start, end, text, translation, pending }], translating }
    vtt: null,
    vttId: null,          // identity (lecture|locale) of the file loaded or loading
    playerLocale: null,   // locale of the last .vtt the player downloaded (= player selection)
    playerVtt: null,      // { url, context } of that file (fallback source)
    courseIdFromRequests: null,
    courseIdCache: null,  // { slug, id }
    captionList: null,    // { key: 'courseId/lectureId', items: [{ url, locale, label, auto }] }
    captionListLoading: null,
    // Video tracking
    video: null,
    videoHeight: 0,
    lastError: null, // { code, message, at } of the last failed translation (cleared on success)
  };

  const cache = new Map();     // DOM mode: key -> translation (insertion order = LRU)
  const inFlight = new Set();  // DOM mode: keys being translated

  // ─── Helpers ─────────────────────────────────────────────────────────────────
  const normalizeText = text => (text ?? '').replace(/\s+/g, ' ').trim();
  /** Udemy locale (en_US, zh_CN, pt_BR) → Google language code (en, zh-CN, pt). */
  function localeToLang(locale) {
    if (!locale) return null;
    const [lang, region] = locale.split(/[_-]/);
    return lang === 'zh' && region ? `zh-${region.toUpperCase()}` : lang.toLowerCase();
  }

  /** "Auto" source language is resolved from the subtitle file's locale when known. */
  const sourceLang = () =>
    state.cfg.sourceLang === 'auto' ? localeToLang(state.vtt?.locale) ?? 'auto' : state.cfg.sourceLang;

  const langKey = () => `${sourceLang()}|${state.cfg.lang}`;
  const cacheKey = text => `${langKey()}|${text}`;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

  async function sendMessage(message) {
    const res = await chrome.runtime.sendMessage(message);
    if (!res) throw new Error('No response from background worker');
    if (res.error) throw Object.assign(new Error(res.error), { code: res.code ?? 'other' });
    return res.result;
  }

  function recordError(err) {
    state.lastError = { code: err.code ?? 'other', message: err.message, at: Date.now() };
  }

  const clearError = () => (state.lastError = null);
  const retryDelay = err => (err.code === 'rate_limit' ? RATE_LIMIT_DELAY_MS : SINGLE_RETRY_DELAY_MS);

  const translationRequest = extra => ({
    sourceLang: sourceLang(),
    targetLang: state.cfg.lang,
    ...extra,
  });

  // ─── Video tracking ──────────────────────────────────────────────────────────
  // Height is kept up to date by a ResizeObserver (normal / theatre / fullscreen)
  // so the render loop never has to force a layout.
  const resizeObserver = new ResizeObserver(entries => {
    for (const entry of entries) {
      if (entry.target === state.video) state.videoHeight = entry.contentRect.height;
    }
    scheduleSync();
  });

  // A new source in the same <video> element (e.g. next video in a preview) does
  // not necessarily mutate the DOM, so media events also trigger a sync.
  const VIDEO_EVENTS = ['loadstart', 'emptied'];

  function trackVideo(video) {
    if (video === state.video) return video;
    if (state.video) {
      resizeObserver.unobserve(state.video);
      VIDEO_EVENTS.forEach(type => state.video.removeEventListener(type, scheduleSync));
    }
    state.video = video;
    state.videoHeight = video?.getBoundingClientRect().height ?? 0;
    if (video) {
      resizeObserver.observe(video);
      VIDEO_EVENTS.forEach(type => video.addEventListener(type, scheduleSync));
    }
    return video;
  }

  /** Nearest <video> sharing an ancestor with `el` (i.e. the same player). */
  function findVideoFor(el) {
    for (let node = el.parentElement; node; node = node.parentElement) {
      const video = node.querySelector('video');
      if (video) return video;
    }
    return null;
  }

  // ─── Overlay ─────────────────────────────────────────────────────────────────
  function ensureOverlay(host, floating) {
    let overlay = state.overlay;
    if (overlay?.parentElement !== host) {
      overlay?.remove();
      overlay = document.createElement('div');
      overlay.className = OVERLAY_CLASS;

      const original = document.createElement('div');
      original.className = 'ust-line ust-line--original';
      const translation = document.createElement('div');
      translation.className = 'ust-line ust-line--translation';

      overlay.append(original, translation);
      host.append(overlay);
      state.overlay = overlay;
    }
    overlay.classList.toggle(FLOATING_CLASS, floating);
    return overlay;
  }

  function hideOverlay() {
    if (state.overlay) state.overlay.hidden = true;
  }

  function removeOverlay() {
    state.overlay?.remove();
    state.overlay = null;
  }

  function hexToRgba(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  /**
   * @param {object} p
   * @param {Element} p.host       element the overlay is appended to
   * @param {boolean} p.floating   VTT mode: absolutely positioned over the video
   * @param {string}  p.original
   * @param {string}  p.translation
   */
  function renderOverlay({ host, floating, original, translation }) {
    const { cfg, videoHeight } = state;
    const overlay = ensureOverlay(host, floating);
    const [originalEl, translationEl] = overlay.children;

    overlay.dataset.mode = cfg.displayMode;
    overlay.style.setProperty('--ust-color', cfg.textColor);
    overlay.style.setProperty('--ust-original-color', cfg.originalColor);
    overlay.style.setProperty('--ust-bg', hexToRgba(cfg.bgColor, cfg.bgOpacity / 100));
    if (floating) {
      // Bottom offset and font size are relative to the video, so the layout is
      // identical in a small player and in fullscreen.
      const fontPx = videoHeight * FLOATING_FONT_PER_VIDEO_HEIGHT * (cfg.fontSize / 100);
      overlay.style.setProperty('--ust-bottom', `${FLOATING_BASE_BOTTOM_PCT + cfg.verticalOffset}%`);
      overlay.style.setProperty('--ust-font-size', `${Math.max(12, Math.round(fontPx))}px`);
      overlay.style.setProperty('--ust-offset', '0px');
    } else {
      // Inside Udemy's caption container: shift relative to its native position.
      const offsetPx = Math.round((-cfg.verticalOffset / 100) * videoHeight); // negative = up
      overlay.style.setProperty('--ust-font-size', `${cfg.fontSize}%`);
      overlay.style.setProperty('--ust-offset', `${offsetPx}px`);
    }
    setText(originalEl, original);
    setText(translationEl, translation);
    overlay.hidden = false;
  }

  // ─── Caption source: identification ─────────────────────────────────────────
  const LECTURE_PATH_RE = /\/learn\/lecture\/(\d+)/;
  const COURSE_API_RE = /\/api-2\.0\/(?:users\/me\/subscribed-courses|courses)\/(\d+)(?:[/?]|$)/;

  const lectureIdFromUrl = () => LECTURE_PATH_RE.exec(location.pathname)?.[1] ?? null;

  /** Source of the current video – changes when the player switches to another video. */
  function videoFingerprint() {
    const video = document.querySelector('video');
    if (!video) return '';
    return video.querySelector('source')?.getAttribute('src') || video.currentSrc || video.getAttribute('src') || '';
  }

  /**
   * Identity of what is being watched. Subtitles, translations and the overlay
   * belong to one context and are dropped when it changes.
   *
   * - Lecture page: the lecture id. Deliberately NOT the full URL – switching the
   *   tabs under the video (Overview, Q&A, Notes…) changes the hash/query but not
   *   the lecture, and must not reload the subtitles.
   * - Other pages (e.g. course preview): path + video source, so switching to
   *   another video on the same page is detected too.
   */
  function contextKey() {
    const lectureId = lectureIdFromUrl();
    return lectureId ? `lecture:${lectureId}` : `page:${location.pathname}|video:${videoFingerprint()}`;
  }

  const courseSlug = () => /\/course\/([^/]+)/.exec(location.pathname)?.[1] ?? null;

  /** Course id (cached per course) – see lookupCourseId. */
  function findCourseId() {
    const slug = courseSlug();
    if (state.courseIdCache?.slug === slug) return state.courseIdCache.id;
    const id = lookupCourseId();
    if (id) state.courseIdCache = { slug, id };
    return id;
  }

  /** Course id from page bootstrap data, page attributes or the page's own API calls. */
  function lookupCourseId() {
    for (const el of document.querySelectorAll('[data-module-args]')) {
      try {
        const id = JSON.parse(el.dataset.moduleArgs)?.courseId;
        if (id) return String(id);
      } catch {
        /* not JSON – ignore */
      }
    }
    const attr = document.querySelector('[data-clp-course-id]')?.dataset.clpCourseId;
    return attr || state.courseIdFromRequests;
  }

  function isUdemyCdnVtt(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname.endsWith('.udemycdn.com') && url.pathname.endsWith('.vtt');
    } catch {
      return false;
    }
  }

  /** Player subtitle files live on vtt-*.udemycdn.com (thumbnail sprites are .vtt too, elsewhere). */
  const isPlayerSubtitleUrl = value =>
    isUdemyCdnVtt(value) && /^vtt-[\w-]*\.udemycdn\.com$/i.test(new URL(value).hostname);

  /** Locale from a subtitle URL path: …/47433894/en_US/<uuid>.vtt → en_US */
  const localeFromVttUrl = value =>
    /\/([a-z]{2,3}(?:[_-][A-Za-z]{2,4})?)\/[^/]+\.vtt$/.exec(new URL(value).pathname)?.[1] ?? null;

  // ─── Caption source: Udemy REST API ──────────────────────────────────────────
  // Same-origin request from the content script → sent with the user's session cookies.
  async function fetchCaptionList(courseId, lectureId) {
    const url = new URL(
      `/api-2.0/users/me/subscribed-courses/${courseId}/lectures/${lectureId}/`,
      location.origin
    );
    url.searchParams.set('fields[asset]', 'captions');

    const resp = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return (data?.asset?.captions ?? []).map(normalizeCaption).filter(Boolean);
  }

  function normalizeCaption(raw) {
    if (!isUdemyCdnVtt(raw?.url)) return null;
    const label = raw.video_label ?? raw.title ?? '';
    return {
      url: raw.url,
      locale: raw.locale_id ?? raw.locale?.locale ?? localeFromVttUrl(raw.url),
      label,
      auto: raw.source === 'auto' || /\[auto\]/i.test(label),
    };
  }

  /** Label of the language checked in the player's caption menu (if rendered). */
  function playerMenuLabel() {
    const checked = document.querySelector(
      '[data-purpose="captions-dropdown-menu"] [aria-checked="true"]'
    );
    return normalizeText(checked?.textContent) || null;
  }

  /**
   * Preference: language the player is using → language checked in the player
   * menu → English → anything. Within a language, human-made beats auto-generated.
   */
  function pickCaption(items) {
    const best = list => list.find(c => !c.auto) ?? list[0];
    const matching = predicate => items.filter(predicate);

    if (state.playerLocale) {
      const byPlayer = matching(c => c.locale === state.playerLocale);
      if (byPlayer.length) return best(byPlayer);
    }
    const label = playerMenuLabel();
    if (label) {
      const byLabel = matching(c => normalizeText(c.label) === label);
      if (byLabel.length) return byLabel[0];
    }
    const english = matching(c => c.locale?.toLowerCase().startsWith('en'));
    return best(english.length ? english : items);
  }

  async function ensureCaptionList(key, courseId, lectureId) {
    if (state.captionList?.key === key || state.captionListLoading === key) return;
    state.captionListLoading = key;
    try {
      const items = await fetchCaptionList(courseId, lectureId);
      state.captionList = { key, items };
      log.info(`caption list (API): ${items.map(c => c.locale + (c.auto ? '*' : '')).join(', ') || 'none'}`);
    } catch (err) {
      state.captionList = { key, items: [] };
      log.warn(`caption list API failed (${err.message}), using player request`);
    } finally {
      state.captionListLoading = null;
      scheduleSync();
    }
  }

  /** Decides which subtitle file to use for the current lecture and loads it. */
  function resolveCaptionSource() {
    const lectureId = lectureIdFromUrl();
    const courseId = lectureId ? findCourseId() : null;
    const key = courseId && lectureId ? `${courseId}/${lectureId}` : null;

    if (key) {
      ensureCaptionList(key, courseId, lectureId);
      const items = state.captionList?.key === key ? state.captionList.items : null;
      if (items === null) return; // list still loading
      const chosen = items.length ? pickCaption(items) : null;
      if (chosen) {
        if (state.vttId !== vttIdFor(chosen)) {
          log.debug(`chosen caption ${chosen.locale}${chosen.auto ? ' (auto)' : ''}, player locale: ${state.playerLocale ?? '-'}`);
        }
        requestVtt({ url: chosen.url, locale: chosen.locale, label: chosen.label, origin: 'api' });
        return;
      }
    }
    // Fallback: whatever the player downloaded for this page.
    const { playerVtt } = state;
    if (playerVtt?.context === contextKey()) {
      requestVtt({ url: playerVtt.url, locale: state.playerLocale, label: '', origin: 'player' });
    }
  }

  function observeResourceRequests() {
    // buffered: also report requests made before this script started.
    new PerformanceObserver(list => {
      let changed = false;
      for (const { name } of list.getEntries()) {
        if (isPlayerSubtitleUrl(name)) {
          state.playerVtt = { url: name, context: contextKey() };
          state.playerLocale = localeFromVttUrl(name);
          changed = true;
        } else if (!state.courseIdFromRequests && name.startsWith(location.origin)) {
          const id = COURSE_API_RE.exec(name)?.[1];
          if (id) {
            log.debug(`course id ${id} found in page request`);
            state.courseIdFromRequests = id;
            changed = true;
          }
        }
      }
      if (changed) scheduleSync();
    }).observe({ type: 'resource', buffered: true });
  }

  /**
   * Loads a subtitle file unless the same lecture+language is already loaded.
   * (The API and the player use different signed URLs for the same file.)
   */
  const vttIdFor = source => `${contextKey()}|${source.locale ?? source.url}`;

  function requestVtt(source) {
    const id = vttIdFor(source);
    if (id === state.vttId) return;
    state.vttId = id;
    loadVtt(id, source);
  }

  // ─── VTT: parsing ────────────────────────────────────────────────────────────
  const TIME_RE = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
  const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

  function parseTime(value) {
    const m = TIME_RE.exec(value);
    if (!m) return NaN;
    return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
  }

  function parseVtt(text) {
    const cues = [];
    for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
      const lines = block.split('\n');
      const timingIdx = lines.findIndex(line => line.includes('-->'));
      if (timingIdx < 0) continue; // header, NOTE, STYLE…

      const [from, to] = lines[timingIdx].split('-->');
      const start = parseTime(from);
      const end = parseTime(to);
      const body = normalizeText(
        lines
          .slice(timingIdx + 1)
          .join(' ')
          .replace(/<[^>]*>/g, '') // <v Speaker>, <i>, timestamps…
          .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, e => ENTITIES[e])
      );
      if (Number.isFinite(start) && Number.isFinite(end) && body) {
        cues.push({ start, end, text: body, translation: null, pending: false });
      }
    }
    return cues.sort((a, b) => a.start - b.start);
  }

  /** Index of the last cue starting at or before `t` (binary search), or -1. */
  function cueIndexAt(cues, t) {
    let lo = 0;
    let hi = cues.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return idx;
  }

  // ─── VTT: loading & translate-ahead ──────────────────────────────────────────
  async function loadVtt(id, { url, locale, label, origin }) {
    const context = contextKey();
    try {
      const cues = parseVtt(await sendMessage({ type: MESSAGES.FETCH_VTT, url }));
      if (state.vttId !== id) return; // superseded by a newer file meanwhile
      if (!cues.length) throw new Error('no cues in file');

      // Text index for the "follow Udemy" sync mode (see cueForCaption).
      const byText = new Map();
      for (const cue of cues) if (!byText.has(matchKey(cue.text))) byText.set(matchKey(cue.text), cue);

      state.vtt = { id, url, context, locale, label, origin, cues, byText, translating: false };
      log.info(`subtitle file loaded (${origin}, ${locale ?? '?'}): ${cues.length} cues`);
      translateAhead();
      scheduleSync();
    } catch (err) {
      log.warn(`subtitle file not used (${err.message}), using on-screen captions`);
      if (state.vttId === id) state.vttId = null; // allow a retry from another source
    }
  }

  const playbackTime = () => (state.video?.currentTime ?? 0) - state.cfg.timingOffset;

  /** Next run of untranslated cues, starting from the playback position. */
  function nextBatch(cues) {
    const isOpen = cue => cue.translation === null && !cue.pending;
    const from = Math.max(0, cueIndexAt(cues, playbackTime()));
    let i = cues.findIndex((cue, idx) => idx >= from && isOpen(cue));
    if (i < 0) i = cues.findIndex(isOpen); // wrap around to earlier cues
    if (i < 0) return [];

    const batch = [];
    let chars = 0;
    for (; i < cues.length && batch.length < BATCH_MAX_CUES && isOpen(cues[i]); i++) {
      chars += cues[i].text.length + 1;
      if (chars > BATCH_MAX_CHARS && batch.length) break;
      batch.push(cues[i]);
    }
    return batch;
  }

  async function translateAhead() {
    const vtt = state.vtt;
    if (!vtt || vtt.translating) return;
    vtt.translating = true;
    let failures = 0;

    try {
      while (state.vtt === vtt && state.cfg.enabled && failures < BATCH_MAX_FAILURES) {
        const batch = nextBatch(vtt.cues);
        if (!batch.length) break;

        const key = langKey();
        batch.forEach(cue => (cue.pending = true));
        log.debug(`translating batch: ${batch.length} cues from ${batch[0].start.toFixed(1)} s (${key})`);
        try {
          const translations = await sendMessage(
            translationRequest({ type: MESSAGES.TRANSLATE_BATCH, texts: batch.map(c => c.text) })
          );
          // Language changed mid-flight → cues were reset, drop this result.
          if (key === langKey()) batch.forEach((cue, i) => (cue.translation = translations[i] ?? ''));
          failures = 0;
          clearError();
          scheduleSync(); // the "follow Udemy" mode picks translations up in sync()
          const done = vtt.cues.filter(c => c.translation !== null).length;
          if (done === vtt.cues.length) log.debug(`all ${done} cues translated`);
        } catch (err) {
          failures++;
          recordError(err);
          const delay =
            err.code === 'rate_limit' ? RATE_LIMIT_DELAY_MS : BATCH_RETRY_DELAY_MS * 2 ** (failures - 1);
          log.warn(`batch translation error (${err.code}): ${err.message} – retry in ${delay / 1000} s`);
          await sleep(delay);
        } finally {
          batch.forEach(cue => (cue.pending = false));
        }
      }
    } finally {
      vtt.translating = false;
    }
  }

  /** Cue still needs an on-demand translation (not done, not in flight, not backing off). */
  const needsTranslation = cue =>
    cue.translation === null && !cue.pending && Date.now() >= (cue.retryAt ?? 0);

  /** On-demand translation of a single cue (e.g. after seeking into an untranslated part). */
  async function translateCueNow(cue) {
    const key = langKey();
    log.debug(`on-demand translation of cue at ${cue.start.toFixed(1)} s`);
    cue.pending = true;
    try {
      const translated = await sendMessage(translationRequest({ type: MESSAGES.TRANSLATE, text: cue.text }));
      if (key === langKey()) cue.translation = translated;
      clearError();
      scheduleSync();
      translateAhead(); // resumes the batch loop if it gave up after failures
    } catch (err) {
      recordError(err);
      cue.retryAt = Date.now() + retryDelay(err);
      log.warn(`translation error (${err.code}):`, err.message);
    } finally {
      cue.pending = false;
    }
  }

  function resetVttTranslations() {
    if (!state.vtt) return;
    for (const cue of state.vtt.cues) {
      cue.translation = null;
      cue.retryAt = 0;
    }
    translateAhead();
  }

  // ─── VTT: render loop ────────────────────────────────────────────────────────
  /** A subtitle file for the current lecture is loaded. */
  function vttLoaded() {
    const { vtt, cfg } = state;
    return Boolean(cfg.enabled && vtt && vtt.context === contextKey());
  }

  /** Subtitles are driven by our own clock (sync mode "video"). */
  function useClock() {
    return vttLoaded() && state.cfg.syncMode === SYNC_MODES.VIDEO && Boolean(document.querySelector('video'));
  }

  function startClock() {
    if (!state.rafId) state.rafId = requestAnimationFrame(tick);
  }

  function stopClock() {
    cancelAnimationFrame(state.rafId);
    state.rafId = 0;
  }

  function tick() {
    state.rafId = 0;
    if (!useClock()) {
      scheduleSync(); // hand over to the DOM-driven mode
      return;
    }
    renderVtt();
    state.rafId = requestAnimationFrame(tick);
  }

  function renderVtt() {
    const video = trackVideo(document.querySelector('video'));
    const host = video.offsetParent ?? video.parentElement;
    const { cues } = state.vtt;
    const t = playbackTime();
    const idx = cueIndexAt(cues, t);
    const cue = idx >= 0 && t < cues[idx].end ? cues[idx] : null;

    if (!cue || !host) {
      hideOverlay();
      return;
    }
    if (needsTranslation(cue)) translateCueNow(cue);

    renderOverlay({ host, floating: true, original: cue.text, translation: cue.translation ?? '' });
  }

  // ─── DOM-driven display ──────────────────────────────────────────────────────
  // Used (a) in sync mode "udemy": Udemy decides what is shown and when, the text is
  // looked up in the pre-translated subtitle file; (b) as a fallback when no subtitle
  // file is available: each line is translated on demand.

  /** Key for matching on-screen text to file cues: Udemy may join lines without spaces. */
  const matchKey = text => text.replace(/\s+/g, '').toLowerCase();

  function cueForCaption(text) {
    return vttLoaded() ? state.vtt.byText.get(matchKey(text)) : undefined;
  }

  const domRetryAt = new Map(); // cache key -> timestamp before which no retry is made

  async function requestDomTranslation(text) {
    const key = cacheKey(text);
    if (inFlight.has(key) || Date.now() < (domRetryAt.get(key) ?? 0)) return;
    inFlight.add(key);

    try {
      const translated = await sendMessage(translationRequest({ type: MESSAGES.TRANSLATE, text }));
      clearError();
      if (!translated) return;
      cacheSet(key, translated);
      // Ignore stale responses: caption or language may have changed meanwhile.
      if (state.dom.original === text && cacheKey(text) === key) {
        state.dom.translation = translated;
        scheduleSync();
      }
    } catch (err) {
      recordError(err);
      domRetryAt.set(key, Date.now() + retryDelay(err));
      log.warn(`translation error (${err.code}):`, err.message);
    } finally {
      inFlight.delete(key);
    }
  }

  function syncDom(captionEl) {
    const text = normalizeText(captionEl?.textContent);
    const { dom } = state;

    if (text !== dom.original) {
      dom.original = text;
      dom.display = text;
      dom.translation = '';
    }
    if (text && !dom.translation) {
      const cue = cueForCaption(text);
      if (cue) {
        dom.display = cue.text; // file text has proper spacing between joined lines
        // Pre-translated file: usually ready; otherwise translate just this cue now.
        if (cue.translation !== null) dom.translation = cue.translation;
        else if (needsTranslation(cue)) translateCueNow(cue);
      } else {
        const cached = cacheGet(cacheKey(text));
        if (cached) dom.translation = cached;
        else requestDomTranslation(text);
      }
    }

    if (!captionEl?.parentElement || !dom.original) {
      hideOverlay();
      return;
    }
    trackVideo(findVideoFor(captionEl));
    renderOverlay({
      host: captionEl.parentElement,
      floating: false,
      original: dom.display,
      translation: dom.translation,
    });
  }

  // ─── Sync ────────────────────────────────────────────────────────────────────
  function resetDom() {
    state.dom.original = '';
    state.dom.display = '';
    state.dom.translation = '';
  }

  function sync() {
    state.syncScheduled = false;

    // Udemy is a SPA – lecture changes don't reload the page.
    const context = contextKey();
    if (context !== state.context) {
      if (state.context) log.debug(`context changed: ${state.context} → ${context}`);
      state.context = context;
      resetDom();
      removeOverlay();
      if (state.vtt && state.vtt.context !== context) state.vtt = null;
      state.vttId = state.vtt?.id ?? null;
      // Another course → ids learned from the previous course's requests are stale.
      if (state.courseIdCache && state.courseIdCache.slug !== courseSlug()) {
        state.courseIdCache = null;
        state.courseIdFromRequests = null;
      }
    }

    const { enabled } = state.cfg;
    document.documentElement.classList.toggle(ACTIVE_CLASS, enabled);

    if (!enabled) {
      stopClock();
      resetDom();
      removeOverlay();
      return;
    }

    // Mark the native caption so content.css hides it (no-op if already marked).
    const captionEl = findCaption();
    if (captionEl && !captionEl.hasAttribute(NATIVE_ATTR)) captionEl.setAttribute(NATIVE_ATTR, '');

    trackVideo(document.querySelector('video'));
    resolveCaptionSource();

    if (useClock()) {
      startClock(); // the render loop takes over
      return;
    }
    stopClock();
    syncDom(captionEl);
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

    // Language change → re-translate.
    if ('lang' in changes || 'sourceLang' in changes) {
      resetDom();
      resetVttTranslations();
    }
    if (changes.enabled?.newValue) translateAhead();
    if ('syncMode' in changes) {
      resetDom();
      removeOverlay(); // the two modes place the overlay in different hosts
    }

    scheduleSync();
  });

  // ─── Popup status ────────────────────────────────────────────────────────────
  // ─── Export ──────────────────────────────────────────────────────────────────
  function srtTime(seconds) {
    const ms = Math.max(0, Math.round(seconds * 1000));
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
  }

  function exportFileName(ext) {
    const title = document.title
      .replace(/\s*\|\s*Udemy.*$/i, '')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const langs = `${state.vtt.locale ?? sourceLang()}-${state.cfg.lang}`;
    return `${(title || 'udemy-lecture').slice(0, 100)}.${langs}.${ext}`;
  }

  /** Bilingual subtitles of the current lecture (original + translation per cue). */
  function buildExport(format) {
    if (!vttLoaded()) throw new Error('no subtitle file loaded for this lecture');
    const { cues } = state.vtt;
    const lines = cue => [cue.text, cue.translation].filter(Boolean).join('\n');
    const content =
      format === EXPORT_FORMATS.SRT
        ? cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${lines(c)}`).join('\n\n')
        : cues.map(lines).join('\n\n');
    return {
      filename: exportFileName(format),
      content: `${content}\n`,
      total: cues.length,
      translated: cues.filter(c => c.translation !== null).length,
    };
  }

  // ─── Messages from the popup ─────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === MESSAGES.EXPORT) {
      try {
        sendResponse({ result: buildExport(msg.format) });
      } catch (err) {
        sendResponse({ error: err.message });
      }
      return false;
    }
    if (msg?.type !== MESSAGES.GET_STATUS) return false;
    const usingVtt = vttLoaded();
    const cues = usingVtt ? state.vtt.cues : [];
    sendResponse({
      enabled: state.cfg.enabled,
      displayMode: state.cfg.displayMode,
      syncMode: state.cfg.syncMode,
      lastError: state.lastError,
      source: usingVtt ? 'vtt' : 'dom',
      captionOrigin: usingVtt ? state.vtt.origin : null,
      captionLocale: usingVtt ? state.vtt.locale : null,
      captionLabel: usingVtt ? state.vtt.label : null,
      captionFound: useClock() || Boolean(findCaption()),
      cuesTotal: cues.length,
      cuesTranslated: cues.filter(cue => cue.translation !== null).length,
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
      observeResourceRequests();
      scheduleSync();
      log.info(`Udemy Subtitle Translate v${chrome.runtime.getManifest().version} loaded`);
    })
    .catch(err => log.error('init failed:', err.message));
})();
