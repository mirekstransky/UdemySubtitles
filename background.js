'use strict';

// Background service worker.
// - Performs translation requests. In MV3 a content script's fetch() runs with the
//   page origin (udemy.com) and is blocked by CORS; the service worker uses the
//   extension origin + host_permissions, so the request succeeds here.
// - Handles keyboard shortcuts (chrome.commands).
// - Migrates settings from older versions.
//
// All listeners are registered synchronously at top level, as required for MV3
// service workers (otherwise events that wake the worker can be missed).

importScripts('shared.js');

const { LOG_PREFIX, DISPLAY_MODES, MESSAGES, COMMANDS, loadSettings, saveSettings } = UST;

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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== MESSAGES.TRANSLATE) return false;
  if (sender.id !== chrome.runtime.id) return false;

  if (typeof msg.text !== 'string' || !msg.text || !msg.targetLang) {
    sendResponse({ error: 'Missing text or targetLang' });
    return false;
  }

  translate(msg).then(
    translated => sendResponse({ translated }),
    err => {
      console.warn(`${LOG_PREFIX} bg translation error:`, err.message);
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
