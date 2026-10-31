# Udemy Subtitle Translate

Chrome extension (Manifest V3) pro zobrazení překladu titulků přímo ve videu na [udemy.com](https://udemy.com).
Dva režimy zobrazení: **Originál + překlad** (pod sebou) nebo **Pouze překlad**.
Titulky se načítají ze souboru lekce a překládají dopředu, takže jsou synchronní s hlasem.

## Instalace (vývojářský mód)

1. V Chrome otevřete `chrome://extensions`
2. Zapněte **Developer mode** (pravý horní roh)
3. Klikněte **Load unpacked** a vyberte složku `UdemySubtitles`
4. Ikona rozšíření se objeví v toolbaru

Po aktualizaci rozšíření (tlačítko ⟳ v `chrome://extensions`) obnovte otevřené Udemy karty (F5).

## Použití

1. Otevřete libovolný Udemy kurz a zapněte titulky v přehrávači (ikona CC)
2. Klikněte na ikonu rozšíření → zvolte režim zobrazení a cílový jazyk (výchozí: čeština)
3. Titulky se zobrazují automaticky; režim lze přepínat i za běhu klávesovou zkratkou

## Nastavení (popup)

| Volba | Popis |
|---|---|
| Toggle (vpravo nahoře) | Zapnout / vypnout překlad bez reloadu stránky (vypnuto = původní Udemy titulky) |
| Zobrazení titulků | **Originál + překlad** nebo **Pouze překlad** |
| Přeložit do | Cílový jazyk překladu |
| Zdrojový jazyk | Jazyk titulků ve videu (auto = detekovat automaticky) |
| Velikost titulků | Relativní velikost písma (60 – 200 %) |
| Časování | Posun titulků v čase (−3 až +3 s, krok 0,1 s; záporné = dříve). Funguje jen pro titulky ze souboru (viz níže). |
| Svislá pozice | Posun titulků v ose Y v % výšky videa (−10 až +80 %, kladné = nahoru, 0 = výchozí pozice Udemy). Přizpůsobí se i fullscreenu. Tlačítko **Výchozí** vrátí na 0. |

## Klávesové zkratky

| Zkratka | Akce |
|---|---|
| `Alt+T` | Přepnout zobrazení originál + překlad ↔ pouze překlad |
| `Alt+Shift+T` | Zapnout / vypnout překlad |
| `Alt+↑` / `Alt+↓` | Posunout titulky nahoru / dolů (po 5 %) |

Zkratky lze změnit na `chrome://extensions/shortcuts` (odkaz je i v popupu).

## Jak to funguje

### Titulky ze souboru (hlavní režim)

Odkud se soubor titulků (`.vtt`) bere – použije se první dostupný zdroj:

1. **Udemy REST API** – hned po otevření lekce content script zavolá `/api-2.0/users/me/subscribed-courses/{courseId}/lectures/{lectureId}/?fields[asset]=captions` (stejná doména, s přihlášením uživatele) a dostane seznam všech titulků lekce. Nezáleží na tom, jestli jsou v přehrávači zapnuté titulky – překlad začne ještě před spuštěním videa.
   - `courseId` se hledá v datech stránky (`data-module-args`), v atributu `data-clp-course-id` nebo v API požadavcích, které stránka sama udělala.
   - Jazyk: ten, který používá přehrávač (podle posledního staženého `.vtt`) → zaškrtnutý v menu titulků přehrávače → angličtina → cokoli. V rámci jazyka mají přednost ručně psané titulky před automatickými.
   - Při zdrojovém jazyce „Automaticky“ se Googlu pošle jazyk titulků (např. `en_US` → `en`) místo automatické detekce.
2. **Požadavek přehrávače** – pokud API nejde použít, zachytí se `.vtt`, který stáhl přehrávač (`PerformanceObserver`).

Soubor stáhne background worker a content script ho rozparsuje.
- Titulky se **překládají dopředu po dávkách** (až 40 titulků / 1 500 znaků na jeden požadavek), vždy od aktuální pozice ve videu. Lekce se tak přeloží několika požadavky místo stovek.
- Zobrazení řídí `video.currentTime` v každém snímku (`requestAnimationFrame`) – překlad se ukáže současně s hlasem. Posun **Časování** se přičítá k času videa.
- Po přetočení do ještě nepřeloženého místa se aktuální titulek přeloží okamžitě samostatně.
- Overlay je umístěný přímo nad videem; pozice i velikost písma se počítají z výšky videa (stejný vzhled i ve fullscreenu).
- Při vypnutí CC v přehrávači se titulky ze souboru dál zobrazují – vypínají se přepínačem rozšíření (`Alt+Shift+T`).

### Titulky ze stránky (záloha)

Dokud soubor `.vtt` není k dispozici:

- Content script sleduje DOM pomocí `MutationObserver` (změny se slučují do jednoho zpracování za 50 ms) a čte text prvku `[data-purpose="captions-cue-text"]` (s fallbacky na třídy CSS modulů).
- Dokud je rozšíření zapnuté, **nativní Udemy titulek se skryje přes CSS** (`html.ust-active …{display:none}`) a rozšíření vykreslí vlastní box se dvěma řádky – originálem a překladem. Na obrazovce je tak vždy jen jeden prvek a titulky se nemůžou překrývat. Režim „Pouze překlad" jen skryje řádek s originálem.
- Překlad se vyžádá přes background service worker (kvůli CORS), výsledky se cachují v rámci karty (LRU, 500 položek). Odpovědi, které dorazí pozdě pro už neaktuální titulek, se ignorují.
- Nastavení je v `chrome.storage.sync`; změny (z popupu i zkratek) se projeví okamžitě přes `storage.onChanged`.
- **Změna lekce / videa**: titulky, překlady a overlay patří k jedné „identitě“ toho, co se přehrává. Na stránce lekce je to ID lekce z URL – přepnutí záložek pod videem (Přehled, Q&A, Poznámky…) mění jen hash/query, a proto titulky znovu nenačítá. Na jiných stránkách (např. náhled kurzu) je identitou cesta + zdroj videa, takže se pozná i přepnutí na jiné video bez změny URL (události `loadstart`/`emptied`).

## Technická omezení

- **Neoficiální Google Translate API** (`translate.googleapis.com/translate_a/single?client=gtx`): endpoint není zdokumentován, může být omezen rate limitem nebo zablokován bez předchozího upozornění. Není určen pro produkční použití.
- **Selektory**: Udemy používá CSS moduly s hash suffixem. Primární selektor je atribut `data-purpose`, při velkém redesignu UI může přestat fungovat.
- **Soubor titulků**: rozpoznává se podle domény `vtt-*.udemycdn.com` a přípony `.vtt`. Pokud Udemy změní způsob doručení titulků, rozšíření automaticky přejde na titulky ze stránky.
- **Jiná rozšíření na titulky Udemy** (např. s logem `[uds]`) mohou zasahovat do stejných prvků – doporučuje se je vypnout.
- **Jedno video na stránce**: rozšíření cílí na první nalezený titulek.

## Struktura projektu

```
UdemySubtitles/
├── manifest.json        # MV3 manifest (content scripts, commands, permissions)
├── shared.js            # Sdílené konstanty, výchozí nastavení, load/save (background, content, popup)
├── background.js        # Service worker: překlad, klávesové zkratky, migrace nastavení
├── content.js           # Content script: detekce titulků, overlay, cache
├── content.css          # Skrytí nativních titulků + styl overlay
├── popup.html / .css / .js  # UI popupu
├── images/              # Ikony
├── generate_icons.js    # Pomocný skript: node generate_icons.js
└── generate_icons.py    # Alternativa pro Python
```

## Ladění

Otevřete DevTools na Udemy stránce → Console → filtrujte `[UdemySubtitles]`:

```
[UdemySubtitles] Udemy Subtitle Translate v1.5.0 loaded
[UdemySubtitles] caption list (API): en_US, es_ES*     ← * = automaticky generované
[UdemySubtitles] subtitle file loaded (api, en_US): 182 cues   ← titulky ze souboru aktivní
[UdemySubtitles] translation error: HTTP 429     ← rate limit
```

Podrobný výpis (výběr titulků, dávky překladu, změny lekce) zapnete v popupu zaškrtnutím **Ladicí výpis do konzole** – řádky mají prefix `[UdemySubtitles] [debug]`. Nastavení je jen pro tento počítač (`chrome.storage.local`) a projeví se okamžitě bez reloadu.

Service worker: `chrome://extensions` → u rozšíření odkaz **service worker**.
