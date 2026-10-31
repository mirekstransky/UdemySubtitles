'use strict';

const {
  MESSAGES,
  COMMANDS,
  DEFAULTS,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  OFFSET_MIN,
  OFFSET_MAX,
  OFFSET_STEP,
  TIMING_MIN,
  TIMING_MAX,
  TIMING_STEP,
  DEBUG_KEY,
  SYNC_MODES,
  loadSettings,
  saveSettings,
} = UST;

const formatOffset = value => (value > 0 ? `+${value} %` : `${value} %`);
const formatTiming = value => {
  const s = Math.abs(value).toFixed(1).replace('.', ',');
  return value > 0 ? `+${s} s` : value < 0 ? `−${s} s` : '0 s';
};

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

const SOURCE_LANGUAGES = [{ code: 'auto', name: 'Automaticky (doporučeno)' }, ...LANGUAGES];

const $ = id => document.getElementById(id);

// ─── Helpers ───────────────────────────────────────────────────────────────────
function fillSelect(select, options, selected) {
  select.replaceChildren(
    ...options.map(({ code, name }) => new Option(name, code, false, code === selected))
  );
}

/** Sends a message to the content script of the active tab; null if there is none. */
async function messageActiveTab(message) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    return null; // no content script in this tab
  }
}

const queryActiveTabStatus = () => messageActiveTab({ type: MESSAGES.GET_STATUS });

const ERROR_TEXTS = {
  rate_limit: 'Google dočasně omezil počet požadavků (HTTP 429) – zkouším znovu.',
  network: 'Překladač není dostupný (síť nebo vypršel čas).',
  parse: 'Překladač vrátil nečitelnou odpověď.',
};
const ERROR_MAX_AGE_MS = 2 * 60 * 1000;

function errorText(err) {
  return ERROR_TEXTS[err.code] ?? `Chyba překladu: ${err.message}.`;
}

// ─── Status UI ─────────────────────────────────────────────────────────────────
function setStatus(dotClass, text) {
  $('statusDot').className = `status-dot ${dotClass}`;
  $('statusText').textContent = text;
}

function renderStatus(status, enabled) {
  if (!enabled) return setStatus('', 'Překlad je vypnutý.');
  if (!status) {
    return setStatus('', 'Tato karta není Udemy lekce nebo je potřeba stránku obnovit (F5).');
  }
  const { lastError } = status;
  if (lastError && Date.now() - lastError.at < ERROR_MAX_AGE_MS) {
    return setStatus('warn', errorText(lastError));
  }
  if (status.source === 'vtt') {
    const { cuesTranslated: done, cuesTotal: total, captionLabel, captionLocale, captionOrigin } = status;
    const lang = captionLabel || captionLocale || 'neznámý jazyk';
    const via = captionOrigin === 'api' ? 'Udemy API' : 'přehrávač';
    const sync = status.syncMode === SYNC_MODES.UDEMY ? 'zobrazení podle Udemy' : 'synchronizované s videem';
    const progress = done < total ? ` Přeloženo ${done}/${total}.` : ' Přeloženo vše.';
    return setStatus('active', `Titulky ze souboru (${lang}, zdroj: ${via}), ${sync}.${progress}`);
  }
  if (status.captionFound) {
    return setStatus('active', 'Titulky ze stránky – překlad za běhu (časování nelze posunout).');
  }
  setStatus('warn', 'Připojeno k Udemy, ale titulky nejsou zapnuty v přehrávači (CC).');
}

// ─── Shortcuts ─────────────────────────────────────────────────────────────────
async function renderShortcuts() {
  const commands = await chrome.commands.getAll();
  const keyOf = name => commands.find(c => c.name === name)?.shortcut || '—';

  const container = $('shortcuts');
  const line = (key, label) => {
    const row = document.createElement('div');
    const kbd = document.createElement('kbd');
    kbd.textContent = key;
    row.append(kbd, ` ${label}`);
    return row;
  };

  const manage = document.createElement('button');
  manage.className = 'link-btn';
  manage.type = 'button';
  manage.textContent = 'Změnit zkratky';
  manage.addEventListener('click', () =>
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })
  );

  container.replaceChildren(
    line(keyOf(COMMANDS.TOGGLE_DISPLAY_MODE), 'přepnout zobrazení'),
    line(keyOf(COMMANDS.TOGGLE_ENABLED), 'zapnout / vypnout'),
    line(`${keyOf(COMMANDS.MOVE_UP)} / ${keyOf(COMMANDS.MOVE_DOWN)}`, 'posunout nahoru / dolů'),
    manage
  );
}

// ─── Export ────────────────────────────────────────────────────────────────────
async function exportSubtitles(format, noteEl) {
  const res = await messageActiveTab({ type: MESSAGES.EXPORT, format });
  if (!res || res.error) {
    noteEl.textContent = 'Export není k dispozici – pro tuto lekci není načtený soubor titulků.';
    return;
  }
  const { filename, content, translated, total } = res.result;
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  noteEl.textContent =
    translated < total
      ? `Staženo – přeloženo zatím ${translated}/${total} titulků, zbytek jen v originále.`
      : `Staženo: ${filename}`;
}

// ─── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const settings = await loadSettings();

  const enabledEl = $('enabled');
  const langEl = $('lang');
  const sourceLangEl = $('sourceLang');
  const fontSizeEl = $('fontSize');
  const fontSizeValEl = $('fontSizeVal');
  const modeEls = document.querySelectorAll('input[name="displayMode"]');
  const offsetEl = $('verticalOffset');
  const offsetValEl = $('verticalOffsetVal');

  const timingEl = $('timingOffset');
  const timingValEl = $('timingOffsetVal');
  const syncEls = document.querySelectorAll('input[name="syncMode"]');
  const colorEls = ['textColor', 'originalColor', 'bgColor'].map($);
  const bgOpacityEl = $('bgOpacity');
  const bgOpacityValEl = $('bgOpacityVal');

  const showSyncMode = mode => {
    for (const el of syncEls) el.checked = el.value === mode;
    const udemy = mode === SYNC_MODES.UDEMY;
    $('timingField').classList.toggle('is-disabled', udemy);
    $('timingNote').hidden = !udemy;
  };
  const showAppearance = cfg => {
    for (const el of colorEls) el.value = cfg[el.id];
    bgOpacityEl.value = cfg.bgOpacity;
    bgOpacityValEl.textContent = `${cfg.bgOpacity}%`;
  };

  const showOffset = value => {
    offsetEl.value = value;
    offsetValEl.textContent = formatOffset(Number(value));
  };
  const showTiming = value => {
    timingEl.value = value;
    timingValEl.textContent = formatTiming(Number(value));
  };

  // Populate controls
  fillSelect(langEl, LANGUAGES, settings.lang);
  fillSelect(sourceLangEl, SOURCE_LANGUAGES, settings.sourceLang);
  enabledEl.checked = settings.enabled;
  fontSizeEl.min = FONT_SIZE_MIN;
  fontSizeEl.max = FONT_SIZE_MAX;
  fontSizeEl.value = settings.fontSize;
  fontSizeValEl.textContent = `${settings.fontSize}%`;
  for (const el of modeEls) el.checked = el.value === settings.displayMode;
  offsetEl.min = OFFSET_MIN;
  offsetEl.max = OFFSET_MAX;
  offsetEl.step = OFFSET_STEP;
  showOffset(settings.verticalOffset);
  timingEl.min = TIMING_MIN;
  timingEl.max = TIMING_MAX;
  timingEl.step = TIMING_STEP;
  showTiming(settings.timingOffset);
  showSyncMode(settings.syncMode);
  showAppearance(settings);

  // Event listeners – every change is persisted; content scripts react via storage.onChanged.
  enabledEl.addEventListener('change', async () => {
    await saveSettings({ enabled: enabledEl.checked });
    renderStatus(await queryActiveTabStatus(), enabledEl.checked);
  });
  langEl.addEventListener('change', () => saveSettings({ lang: langEl.value }));
  sourceLangEl.addEventListener('change', () => saveSettings({ sourceLang: sourceLangEl.value }));
  fontSizeEl.addEventListener('input', () => {
    fontSizeValEl.textContent = `${fontSizeEl.value}%`;
  });
  fontSizeEl.addEventListener('change', () => saveSettings({ fontSize: Number(fontSizeEl.value) }));
  for (const el of modeEls) {
    el.addEventListener('change', () => el.checked && saveSettings({ displayMode: el.value }));
  }
  // Save on release only ('change'), not on every 'input' – storage.sync has a write quota.
  offsetEl.addEventListener('input', () => showOffset(offsetEl.value));
  offsetEl.addEventListener('change', () => saveSettings({ verticalOffset: Number(offsetEl.value) }));
  $('resetOffset').addEventListener('click', () => {
    showOffset(DEFAULTS.verticalOffset);
    saveSettings({ verticalOffset: DEFAULTS.verticalOffset });
  });
  timingEl.addEventListener('input', () => showTiming(timingEl.value));
  timingEl.addEventListener('change', () => saveSettings({ timingOffset: Number(timingEl.value) }));
  $('resetTiming').addEventListener('click', () => {
    showTiming(DEFAULTS.timingOffset);
    saveSettings({ timingOffset: DEFAULTS.timingOffset });
  });
  for (const el of syncEls) {
    el.addEventListener('change', () => {
      if (!el.checked) return;
      showSyncMode(el.value);
      saveSettings({ syncMode: el.value });
    });
  }
  // Color pickers: 'change' fires when the picker is closed → one write per choice.
  for (const el of colorEls) el.addEventListener('change', () => saveSettings({ [el.id]: el.value }));
  bgOpacityEl.addEventListener('input', () => (bgOpacityValEl.textContent = `${bgOpacityEl.value}%`));
  bgOpacityEl.addEventListener('change', () => saveSettings({ bgOpacity: Number(bgOpacityEl.value) }));
  $('resetAppearance').addEventListener('click', () => {
    const { textColor, originalColor, bgColor, bgOpacity } = DEFAULTS;
    showAppearance(DEFAULTS);
    saveSettings({ textColor, originalColor, bgColor, bgOpacity });
  });
  for (const btn of document.querySelectorAll('[data-export]')) {
    btn.addEventListener('click', () => exportSubtitles(btn.dataset.export, $('exportNote')));
  }

  // Keep the popup in sync if settings change elsewhere (e.g. keyboard shortcut).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.displayMode) {
      for (const el of modeEls) el.checked = el.value === changes.displayMode.newValue;
    }
    if (changes.enabled) enabledEl.checked = changes.enabled.newValue;
    if (changes.verticalOffset) showOffset(changes.verticalOffset.newValue ?? DEFAULTS.verticalOffset);
    if (changes.timingOffset) showTiming(changes.timingOffset.newValue ?? DEFAULTS.timingOffset);
    if (changes.syncMode) showSyncMode(changes.syncMode.newValue ?? DEFAULTS.syncMode);
  });

  // Debug logging is a per-device developer setting → storage.local, not sync.
  const debugEl = $('debug');
  debugEl.checked = Boolean((await chrome.storage.local.get({ [DEBUG_KEY]: false }))[DEBUG_KEY]);
  debugEl.addEventListener('change', () => chrome.storage.local.set({ [DEBUG_KEY]: debugEl.checked }));

  renderShortcuts();
  renderStatus(await queryActiveTabStatus(), settings.enabled);
});
