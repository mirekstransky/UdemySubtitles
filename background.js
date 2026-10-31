'use strict';

// Background service worker.
// - Performs translation requests and downloads subtitle (.vtt) files. In MV3 a
//   content script's fetch() runs with the page origin (udemy.com) and is subject to
//   CORS; the service worker uses the extension origin + host_permissions.
// - Handles keyboard shortcuts (chrome.commands).
// - Migrates settings from older versions.
//
// All listeners are registered synchronously at top level, as required for MV3
// service workers (otherwise events that wake the worker can be missed).

importScripts('shared.js');

const {
  createLogger,
  DISPLAY_MODES,
  MESSAGES,
  COMMANDS,
  OFFSET_MIN,
  OFFSET_MAX,
  OFFSET_STEP,
  loadSettings,
  saveSettings,
} = UST;

const log = createLogger();

const GTX_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const MAX_QUERY_CHARS = 2000;
const REQUEST_TIMEOUT_MS = 8000;

// ─── Translation ───────────────────────────────────────────────────────────────
async function translate({ text, sourceLang, targetLang }) {
  const url = new URL(GTX_ENDPOINT);
  url.search = new URLSearchParams({
    client: 'gtx',
    sl: sourceLang || 'auto',
    tl: targetLang,
    dt: 't',
    q: text.slice(0, MAX_QUERY_CHARS),
  }).toString();

  const resp = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const data = await resp.json();
  if (!Array.isArray(data?.[0])) throw new Error('Unexpected response format');
  return data[0].map(chunk => chunk?.[0] ?? '').join('');
}

/**
 * Translates many short texts with as few requests as possible: the texts are joined
 * with newlines (which the endpoint preserves) and split back. If the line count does
 * not match, falls back to translating each text separately.
 */
async function translateBatch({ texts, sourceLang, targetLang }) {
  const opts = { sourceLang, targetLang };
  const lines = (await translate({ ...opts, text: texts.join('\n') })).split('\n');
  if (lines.length === texts.length) return lines.map(line => line.trim());

  log.warn(`batch line mismatch (${lines.length}/${texts.length}), falling back to single requests`);
  const result = [];
  for (const text of texts) result.push(await translate({ ...opts, text }));
  return result;
}

// ─── Subtitle file ─────────────────────────────────────────────────────────────
function isUdemyCdnUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.endsWith('.udemycdn.com');
  } catch {
    return false;
  }
}

async function fetchVtt({ url }) {
  if (!isUdemyCdnUrl(url)) throw new Error('URL is not a Udemy CDN address');
  const resp = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

// ─── Messaging ─────────────────────────────────────────────────────────────────
// Each handler returns a promise; its result is sent back as { result } or { error }.
const MESSAGE_HANDLERS = {
  [MESSAGES.TRANSLATE]: msg => {
    if (typeof msg.text !== 'string' || !msg.text || !msg.targetLang) {
      throw new Error('Missing text or targetLang');
    }
    return translate(msg);
  },
  [MESSAGES.TRANSLATE_BATCH]: msg => {
    if (!Array.isArray(msg.texts) || !msg.texts.length || !msg.targetLang) {
      throw new Error('Missing texts or targetLang');
    }
    return translateBatch(msg);
  },
  [MESSAGES.FETCH_VTT]: fetchVtt,
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = MESSAGE_HANDLERS[msg?.type];
  if (!handler || sender.id !== chrome.runtime.id) return false;

  Promise.resolve()
    .then(() => handler(msg))
    .then(
      result => sendResponse({ result }),
      err => {
        log.warn(`${msg.type} failed:`, err.message);
        sendResponse({ error: err.message });
      }
    );
  return true; // keep the channel open for the async sendResponse
});

// ─── Keyboard shortcuts ────────────────────────────────────────────────────────
chrome.commands.onCommand.addListener(async command => {
  const cfg = await loadSettings();

  switch (command) {
    case COMMANDS.TOGGLE_DISPLAY_MODE:
      await saveSettings({
        enabled: true,
        displayMode:
          cfg.displayMode === DISPLAY_MODES.BOTH ? DISPLAY_MODES.TRANSLATION : DISPLAY_MODES.BOTH,
      });
      break;
    case COMMANDS.TOGGLE_ENABLED:
      await saveSettings({ enabled: !cfg.enabled });
      break;
    case COMMANDS.MOVE_UP:
    case COMMANDS.MOVE_DOWN: {
      const delta = command === COMMANDS.MOVE_UP ? OFFSET_STEP : -OFFSET_STEP;
      const verticalOffset = Math.min(OFFSET_MAX, Math.max(OFFSET_MIN, cfg.verticalOffset + delta));
      if (verticalOffset !== cfg.verticalOffset) await saveSettings({ verticalOffset });
      break;
    }
  }
});

// ─── Settings migration ────────────────────────────────────────────────────────
// v1.0 stored a boolean `hideOriginal`; v1.1+ uses `displayMode`.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== chrome.runtime.OnInstalledReason.UPDATE) return;

  const { hideOriginal, displayMode } = await chrome.storage.sync.get([
    'hideOriginal',
    'displayMode',
  ]);
  if (hideOriginal === undefined) return;

  if (displayMode === undefined) {
    await saveSettings({
      displayMode: hideOriginal ? DISPLAY_MODES.TRANSLATION : DISPLAY_MODES.BOTH,
    });
  }
  await chrome.storage.sync.remove('hideOriginal');
});
