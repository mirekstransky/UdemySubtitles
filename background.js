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
const REQUEST_TIMEOUT_MS = 10000;
const MAX_POST_CHARS = 5000; // text per request when sent in the POST body
const MAX_GET_CHARS = 1800;  // text per request when it has to go into the URL

// POST keeps long batches out of the URL. If the endpoint ever rejects it, the
// worker switches to GET (with smaller chunks) for the rest of its lifetime.
let postSupported = true;

/** Error with a machine-readable `code`: rate_limit | network | http | parse | post_unsupported */
class TranslateError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// ─── Translation ───────────────────────────────────────────────────────────────
async function gtxRequest({ text, sourceLang, targetLang }, method) {
  const params = new URLSearchParams({ client: 'gtx', sl: sourceLang || 'auto', tl: targetLang, dt: 't' });
  const init = { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
  if (method === 'POST') {
    init.method = 'POST';
    init.body = new URLSearchParams({ q: text }); // sent as application/x-www-form-urlencoded
  } else {
    params.set('q', text);
  }

  let resp;
  try {
    resp = await fetch(`${GTX_ENDPOINT}?${params}`, init);
  } catch (err) {
    throw new TranslateError(err.name === 'TimeoutError' ? 'timeout' : err.message, 'network');
  }
  if (resp.status === 429) throw new TranslateError('HTTP 429', 'rate_limit');
  if (!resp.ok) throw new TranslateError(`HTTP ${resp.status}`, 'http');

  let data;
  try {
    data = await resp.json();
  } catch {
    throw new TranslateError('invalid JSON', 'parse');
  }
  if (!Array.isArray(data?.[0])) throw new TranslateError('Unexpected response format', 'parse');
  return data[0].map(chunk => chunk?.[0] ?? '').join('');
}

async function translate(req) {
  if (postSupported) {
    try {
      return await gtxRequest(req, 'POST');
    } catch (err) {
      if (err.code !== 'http') throw err; // 429, network… are not about the method
      postSupported = false;
      log.info(`POST rejected (${err.message}), switching to GET`);
      if (req.text.length > MAX_GET_CHARS) {
        throw new TranslateError('POST not supported, text too long for GET', 'post_unsupported');
      }
    }
  }
  return gtxRequest({ ...req, text: req.text.slice(0, MAX_GET_CHARS) }, 'GET');
}

/** Splits texts into consecutive groups whose joined length fits `limit`. */
function chunkByChars(texts, limit) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const text of texts) {
    if (current.length && size + text.length + 1 > limit) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(text);
    size += text.length + 1;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * One request for many short texts: joined with newlines (preserved by the
 * endpoint) and split back. On a line-count mismatch each text goes separately.
 */
async function translateChunk(texts, opts) {
  const lines = (await translate({ ...opts, text: texts.join('\n') })).split('\n');
  if (lines.length === texts.length) return lines.map(line => line.trim());

  log.warn(`batch line mismatch (${lines.length}/${texts.length}), falling back to single requests`);
  const result = [];
  for (const text of texts) result.push(await translate({ ...opts, text }));
  return result;
}

async function translateBatch({ texts, sourceLang, targetLang }) {
  const opts = { sourceLang, targetLang };
  const run = async () => {
    const chunks = chunkByChars(texts, postSupported ? MAX_POST_CHARS : MAX_GET_CHARS);
    log.debug(`batch: ${texts.length} texts in ${chunks.length} request(s) via ${postSupported ? 'POST' : 'GET'}`);
    const result = [];
    for (const chunk of chunks) result.push(...(await translateChunk(chunk, opts)));
    return result;
  };
  try {
    return await run();
  } catch (err) {
    if (err.code === 'post_unsupported') return run(); // re-chunk for GET
    throw err;
  }
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
        sendResponse({ error: err.message, code: err.code ?? 'other' });
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
