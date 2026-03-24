'use strict';

// ─── Selectors ─────────────────────────────────────────────────────────────────
// Udemy uses CSS modules – class names have an unpredictable module prefix and hash suffix.
// Actual element (confirmed live): class="captions-display-module--captions-cue-text--KMBV6"
//                                  data-purpose="captions-cue-text"
// Primary selector uses the stable data-purpose attribute; class*= variants are fallbacks.
const SEL_CAPTION = [
  '[data-purpose="captions-cue-text"]',   // most stable – Udemy data attribute
  '[class*="captions-cue-text"]',         // covers any module-prefix variant
  '[class^="well--text--"]',
  '[class*=" well--text--"]',
];
const SEL_VIDEO = [
  '[class*="video-player--video-player--"]',
  '[class*="video-player-module--video-player--"]',
  "[id^='playerId__'] video",
  'video',
].join(', ');
// Container: use class*= so it matches both "video-player--container--" and
// "video-player-module--container--" (same -module- shift seen in captions).
const SEL_CONTAINER =
  '[class*="video-player--container--"], [class*="video-player-module--container--"]';
const OVERLAY_ID = 'ust-overlay';

// ─── State ─────────────────────────────────────────────────────────────────────
let cfg = { lang: 'cs', sourceLang: 'auto', fontSize: 110, enabled: true, hideOriginal: false };
// lastCaption: text for which translation was actually displayed (updated after success)
let lastCaption = '';
// pendingText: latest text seen by the MutationObserver (may be ahead of lastCaption)
let pendingText = '';
let isTranslating = false;
let debounceTimer = null;

// ─── Settings ──────────────────────────────────────────────────────────────────
chrome.storage.sync.get(
  { lang: 'cs', sourceLang: 'auto', fontSize: 110, enabled: true, hideOriginal: false },
  result => { cfg = result; }
);

chrome.storage.onChanged.addListener(changes => {
  for (const [k, { newValue }] of Object.entries(changes)) cfg[k] = newValue;

  // Apply overlay visibility / font size changes immediately
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay) {
    overlay.style.fontSize = `${cfg.fontSize}%`;
    if (!cfg.enabled) {
      overlay.textContent = '';
      overlay.style.display = 'none';
    } else {
      overlay.style.display = '';
    }
  }

  // Apply hideOriginal change to the currently visible caption element immediately
  if ('hideOriginal' in changes || 'enabled' in changes) {
    const captionEl = findCaption();
    if (captionEl) {
      applyOriginalVisibility(captionEl);
    }
  }
});

// ─── Translation ───────────────────────────────────────────────────────────────
// In MV3, fetch() from a content script runs with the PAGE's origin (udemy.com),
// so cross-origin requests to translate.googleapis.com are blocked by CORS.
// We delegate the fetch to the background service worker via messaging.
async function gtxTranslate(text) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { method: 'translate', text, sourceLang: cfg.sourceLang, targetLang: cfg.lang },
      response => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response?.error) {
          reject(new Error(response.error));
          return;
        }
        resolve(response?.translated ?? '');
      }
    );
  });
}

// ─── Overlay element ───────────────────────────────────────────────────────────
// Overlay is injected as a sibling inside captionEl.parentElement.
// The Udemy caption parent is already positioned correctly over the video and
// does NOT have overflow:hidden – so this avoids the clipping issue that occurs
// when appending to the video container itself.
function getOrCreateOverlay(captionEl) {
  const parent = captionEl.parentElement;
  let el = parent.querySelector(`#${OVERLAY_ID}`);
  if (el) return el;

  el = document.createElement('div');
  el.id = OVERLAY_ID;
  Object.assign(el.style, {
    display: 'block',
    color: '#ffffff',
    fontSize: `${cfg.fontSize}%`,
    fontFamily: "'Segoe UI', Arial, sans-serif",
    fontWeight: '600',
    textAlign: 'center',
    textShadow: '0 0 5px #000, 0 0 5px #000',
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    padding: '2px 10px',
    borderRadius: '4px',
    lineHeight: '1.5',
    pointerEvents: 'none',
    marginTop: '4px',
    whiteSpace: 'pre-wrap',
  });
  parent.appendChild(el);
  return el;
}

// ─── Original caption visibility ──────────────────────────────────────────────
// Hides or restores the native Udemy caption text based on cfg.hideOriginal.
function applyOriginalVisibility(captionEl) {
  if (!captionEl) return;
  captionEl.style.display = (cfg.enabled && cfg.hideOriginal) ? 'none' : '';
}

// ─── Caption detection ─────────────────────────────────────────────────────────
function findCaption() {
  for (const sel of SEL_CAPTION) {
    const el = document.querySelector(sel);
    if (el?.textContent.trim()) return el;
  }
  return null;
}

// ─── Main handler ──────────────────────────────────────────────────────────────
async function handleCaptionChange() {
  if (!cfg.enabled) return;

  const captionEl = findCaption();
  const text = captionEl?.textContent.trim() ?? '';

  if (!text) {
    lastCaption = '';
    pendingText = '';
    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay) overlay.textContent = '';
    // Restore original caption visibility when captions disappear between cues
    if (captionEl) captionEl.style.display = '';
    return;
  }

  // Always track the latest text seen.
  pendingText = text;

  // Already displayed a translation for this exact text.
  if (text === lastCaption) return;

  // A translation is in flight. The finally block will re-trigger once it finishes
  // and pendingText will carry the latest text at that point.
  if (isTranslating) return;

  isTranslating = true;
  const capturedText = text;

  try {
    console.log('[UST] translating:', capturedText.slice(0, 80));
    const translated = await gtxTranslate(capturedText);
    console.log('[UST] translated:', translated?.slice(0, 80));
    if (translated) {
      lastCaption = capturedText;
      // Re-query caption element – it may have been replaced while awaiting.
      const freshCaption = findCaption();
      if (freshCaption) {
        const overlay = getOrCreateOverlay(freshCaption);
        overlay.textContent = translated;
        overlay.style.display = cfg.enabled ? '' : 'none';
        // Show/hide the original Udemy caption text based on mode
        applyOriginalVisibility(freshCaption);
      }
    }
  } catch (err) {
    console.warn('[UST] Translation error:', err.message);
  } finally {
    isTranslating = false;
    // If caption changed while we were translating, immediately process the latest.
    if (pendingText !== capturedText) {
      setTimeout(handleCaptionChange, 0);
    }
  }
}

function scheduleCaptionCheck() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(handleCaptionChange, 100);
}

// ─── MutationObserver ──────────────────────────────────────────────────────────
// Observe the whole document so we catch dynamic player/caption insertion on SPA nav.
const observer = new MutationObserver(scheduleCaptionCheck);
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  characterData: true,
});

// ─── SPA navigation detection ──────────────────────────────────────────────────
// Udemy is a React SPA – the URL changes without a full page reload.
let lastHref = location.href;
setInterval(() => {
  if (location.href === lastHref) return;
  lastHref = location.href;
  lastCaption = '';
  const el = document.getElementById(OVERLAY_ID);
  if (el) {
    el.textContent = '';
    el.remove(); // Force re-creation in the new player container
  }
}, 1000);

// ─── Messages from popup ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  if (req.method === 'getStatus') {
    sendResponse({
      enabled: cfg.enabled,
      captionFound: !!findCaption(),
      lastCaption,
    });
    return true;
  }
});

window.__UST_LOADED = true;
console.log('[UST] Udemy Subtitle Translate v1.0.0 loaded');
