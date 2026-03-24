'use strict';

const LANGUAGES = [
  { code: 'cs', name: 'Čeština' },
  { code: 'sk', name: 'Slovenčina' },
  { code: 'de', name: 'Deutsch' },
  { code: 'fr', name: 'Français' },
  { code: 'es', name: 'Español' },
  { code: 'it', name: 'Italiano' },
  { code: 'pt', name: 'Português' },
  { code: 'pl', name: 'Polski' },
  { code: 'ru', name: 'Русский' },
  { code: 'uk', name: 'Українська' },
  { code: 'nl', name: 'Nederlands' },
  { code: 'hu', name: 'Magyar' },
  { code: 'ro', name: 'Română' },
  { code: 'bg', name: 'Български' },
  { code: 'hr', name: 'Hrvatski' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'ar', name: 'العربية' },
  { code: 'hi', name: 'हिन्दी' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'zh-CN', name: '中文 (简体)' },
  { code: 'zh-TW', name: '中文 (繁體)' },
  { code: 'en', name: 'English' },
];

const SOURCE_LANGUAGES = [
  { code: 'auto', name: 'Automaticky (doporučeno)' },
  ...LANGUAGES,
];

// ─── Helpers ───────────────────────────────────────────────────────────────────
function buildSelect(el, options, selectedValue) {
  el.innerHTML = options
    .map(
      o =>
        `<option value="${o.code}"${o.code === selectedValue ? ' selected' : ''}>${o.name}</option>`
    )
    .join('');
}

function loadSettings() {
  return new Promise(resolve =>
    chrome.storage.sync.get(
      { lang: 'cs', sourceLang: 'auto', fontSize: 110, enabled: true, hideOriginal: false },
      resolve
    )
  );
}

function save(partial) {
  chrome.storage.sync.set(partial);
}

async function queryActiveTabStatus() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    return await chrome.tabs.sendMessage(tab.id, { method: 'getStatus' });
  } catch {
    return null;
  }
}

// ─── Status UI ─────────────────────────────────────────────────────────────────
function setStatus(dotClass, text) {
  document.getElementById('statusDot').className = `status-dot ${dotClass}`;
  document.getElementById('statusText').textContent = text;
}

function renderStatus(status, enabled) {
  if (!status) {
    setStatus('', 'Tato karta není Udemy lekce nebo se nepodařilo připojit ke content scriptu.');
    return;
  }
  if (!enabled) {
    setStatus('', 'Překlad je vypnutý.');
    return;
  }
  if (status.captionFound) {
    setStatus('active', 'Titulky aktivní – překlad běží.');
  } else {
    setStatus('warn', 'Připojeno k Udemy, ale titulky nejsou zapnuty v přehrávači.');
  }
}

// ─── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const settings = await loadSettings();

  const enabledEl       = document.getElementById('enabled');
  const langEl          = document.getElementById('lang');
  const sourceLangEl    = document.getElementById('sourceLang');
  const fontSizeEl      = document.getElementById('fontSize');
  const fontSizeValEl   = document.getElementById('fontSizeVal');
  const hideOriginalEl  = document.getElementById('hideOriginal');

  // Populate controls
  buildSelect(langEl, LANGUAGES, settings.lang);
  buildSelect(sourceLangEl, SOURCE_LANGUAGES, settings.sourceLang);
  enabledEl.checked       = settings.enabled;
  fontSizeEl.value        = settings.fontSize;
  fontSizeValEl.textContent = `${settings.fontSize}%`;
  hideOriginalEl.checked  = settings.hideOriginal;

  // ── Event listeners ──
  enabledEl.addEventListener('change', () => {
    save({ enabled: enabledEl.checked });
    renderStatus(null, enabledEl.checked);
  });

  langEl.addEventListener('change', () => save({ lang: langEl.value }));

  sourceLangEl.addEventListener('change', () => save({ sourceLang: sourceLangEl.value }));

  fontSizeEl.addEventListener('input', () => {
    fontSizeValEl.textContent = `${fontSizeEl.value}%`;
  });
  fontSizeEl.addEventListener('change', () => {
    save({ fontSize: Number(fontSizeEl.value) });
  });

  hideOriginalEl.addEventListener('change', () => {
    save({ hideOriginal: hideOriginalEl.checked });
  });

  // ── Initial status ──
  const status = await queryActiveTabStatus();
  renderStatus(status, settings.enabled);
});
