# Udemy Subtitle Translate

Chrome extension (Manifest V3) pro zobrazení překladu titulků přímo ve videu na [udemy.com](https://udemy.com).  
Originální text titulku zůstane – překlad se zobrazí pod ním jako overlay.

## Instalace (vývojářský mód)

1. V Chrome otevřete `chrome://extensions`
2. Zapněte **Developer mode** (pravý horní roh)
3. Klikněte **Load unpacked** a vyberte složku `UdemySubtitles`
4. Ikona rozšíření se objeví v toolbaru

## Použití

1. Otevřete libovolný Udemy kurz a zapněte titulky v přehrávači (ikona CC)
2. Klikněte na ikonu rozšíření → nastavte cílový jazyk (výchozí: čeština)
3. Překlad se zobrazuje automaticky pod Udemy titulky

## Nastavení (popup)

| Volba | Popis |
|---|---|
| Toggle (vpravo nahoře) | Zapnout / vypnout překlad bez reloadu stránky |
| Přeložit do | Cílový jazyk překladu |
| Zdrojový jazyk | Jazyk titulků ve videu (auto = detekovat automaticky) |
| Velikost překladu | Relativní velikost písma overlay (60 – 200 %) |

## Jak to funguje

- Content script sleduje element `[class^="captions-display--captions-cue-text--"]` pomocí `MutationObserver`
- Při změně textu titulku odešle GET požadavek na Google Translate (`gtx` neoficiální endpoint)
- Výsledek překladu zobrazí v absolutně pozicovaném overlay divu uvnitř video kontejneru
- Při navigaci mezi lekcemi (SPA) se overlay automaticky resetuje

## Technická omezení

- **Neoficiální Google Translate API** (`translate.googleapis.com/translate_a/single?client=gtx`): endpoint není zdokumentován, může být omezen rate limitem nebo zablokován bez předchozího upozornění. Není určen pro produkční použití.
- **Pozice overlay**: fixní `bottom: 7%` uvnitř video kontejneru – může se vizuálně překrývat s Udemy titulky nebo s ovládacími prvky přehrávače v závislosti na verzi UI.
- **Selektory**: Udemy používá CSS moduly s hash suffixem (např. `captions-display--captions-cue-text--Xe4H2`). Prefix je dlouhodobě stabilní, ale při velkém redesignu UI může přestat fungovat.
- **Jedno video na stránce**: rozšíření cílí na první nalezený prvek s odpovídající třídou; stránky s více videi (výjimečné) nejsou plně testovány.

## Struktura projektu

```
UdemySubtitles/
├── manifest.json        # MV3 manifest
├── content.js           # Hlavní content script (MutationObserver + překlad)
├── popup.html           # UI popupu
├── popup.js             # Logika popupu
├── images/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── generate_icons.js    # Pomocný skript: node generate_icons.js
└── generate_icons.py    # Alternativa pro Python (pokud je dostupný)
```

## Ladění

Otevřete DevTools na Udemy stránce → Console → filtrujte `[UST]`:

```
[UST] Udemy Subtitle Translate v1.0.0 loaded
[UST] Translation error: HTTP 429     ← rate limit
```
