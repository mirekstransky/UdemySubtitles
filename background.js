'use strict';

// Background service worker handles translation fetch requests from the content
// script. In MV3, content script fetch() runs with the PAGE's origin (udemy.com)
// and is blocked by CORS. The service worker runs with the extension's origin
// and has full access to host_permissions, so the request succeeds here.

const MAX_QUERY_CHARS = 2000;

chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  if (req.method !== 'translate') return false;

  const { text, sourceLang, targetLang } = req;
  if (!text || !targetLang) {
    sendResponse({ error: 'Missing text or targetLang' });
    return true;
  }

  const q = text.length > MAX_QUERY_CHARS ? text.slice(0, MAX_QUERY_CHARS) : text;
  const url =
    'https://translate.googleapis.com/translate_a/single?' +
    `client=gtx&sl=${encodeURIComponent(sourceLang || 'auto')}` +
    `&tl=${encodeURIComponent(targetLang)}&dt=t` +
    `&q=${encodeURIComponent(q)}`;

  fetch(url)
    .then(resp => {
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp.json();
    })
    .then(data => {
      const translated = data[0].map(chunk => chunk[0]).join('');
      sendResponse({ translated });
    })
    .catch(err => {
      console.warn('[UST bg] Translation fetch error:', err.message);
      sendResponse({ error: err.message });
    });

  // Return true to indicate we will call sendResponse asynchronously
  return true;
});

console.log('[UST bg] Background service worker loaded');
