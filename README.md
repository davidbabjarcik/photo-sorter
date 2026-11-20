# Photo Sorter

Webová appka (PWA), ktorá roztriedi fotky z priečinka na počítači. **Všetko beží lokálne v prehliadači** – fotky sa nikam neuploadujú. Funguje v Chrome a Edge na Windows aj macOS.

## Čo vie

- **Vstup:** výber priečinka cez File System Access API, rekurzívne hľadá `jpg`, `jpeg`, `png`, `webp`, `heic/heif`. Preskakuje skryté a systémové priečinky (napr. `@eaDir` zo Synology).
- **HEIC z iPhonu** sa dekóduje cez libheif (WebAssembly) – načíta sa len keď je v priečinku HEIC.
- **Výkon na desaťtisíce fotiek:** náhľady cez `createImageBitmap` so zmenšením, analýza v dávkach v poole Web Workerov, CLIP v samostatnom workeri, **pauza / pokračovanie**. Všetko (hash, EXIF, náhľad, embedding) sa ukladá do IndexedDB, takže ďalšie spustenie je rýchle a po zatvorení okna sa dá pokračovať.
- **AI triedenie:** transformers.js + CLIP (`Xenova/clip-vit-base-patch32`), zero-shot. WebGPU s automatickým fallbackom na WASM. Kategórie a ich textové prompty sa dajú upraviť v Nastaveniach.
  - Všeobecné: Selfie, Rodina a priatelia, Eventy a svadby, Jedlo, Cestovanie, Príroda a výhľady, Screenshoty, Memy a preposlané, Doklady a bločky, Veci a nákupy
  - Eventy (JEF PRODUCTION): Stage a svetlá, Publikum, DJ pult, Technika, Backstage, Plagáty a flyery
  - Pri nízkej istote ide fotka do „Ostatné“.
- **Screenshoty:** CLIP + heuristiky (PNG, chýbajúci EXIF fotoaparátu, rozlíšenie displeja, „Screenshot“ / „Snímka obrazovky“ v názve).
- **Duplikáty:** presné (SHA-256) aj takmer rovnaké (dHash + podobnosť CLIP embeddingov pri fotkách odfotených tesne po sebe). Ponechá sa najkvalitnejšia verzia (rozlíšenie → veľkosť → EXIF), ostatné sa označia a ukáže sa, koľko miesta sa ušetrí.
- **Dátum:** EXIF `DateTimeOriginal` (exifr) → dátum v názve súboru (`IMG_20240501_…`, `Screenshot_2024…`) → dátum zmeny súboru. Fotky sa zoskupia do eventov podľa časových medzier (predvolene 6 h), priečinky sa volajú `RRRR-MM-DD`.
- **Výstup:** najprv **náhľad bez zápisu** (dry run), potom zápis do **nového** výstupného priečinka v štruktúre `Kategória/…`, `Dátum/…` alebo `Kategória/Dátum/…`.
  - Predvolene sa **kopíruje** – originály sa nikdy nemažú. Presúvanie je voliteľné, s potvrdením, a originál sa zmaže až po overení kópie.
  - Existujúce súbory sa nikdy neprepíšu (pri zhode názvu pribudne `(1)`, `(2)`…).
  - Do výstupného priečinka sa zapíše CSV report (pôvodná cesta → nová cesta, kategória, dátum, duplikát).
- **Vyhľadávanie** (klávesa `/`): textový dopyt cez CLIP, napr. „svetlá na stage“ alebo „torta“. Slovenské slová sa preložia vstavaným slovníkom do angličtiny (CLIP rozumie najmä anglicky); anglické dopyty fungujú priamo.
- Svetlý aj tmavý režim, inštalovateľná PWA, po prvom stiahnutí modelu funguje offline.

## Spustenie lokálne

Potrebuješ Node.js 20+.

```bash
npm install
npm run dev
```

Otvor `http://localhost:5173` v Chrome alebo Edge.

Prvé triedenie stiahne AI model (podľa zariadenia cca 150–300 MB, iba raz – potom je v cache prehliadača).

## Build a nasadenie

```bash
npm run build
```

Výsledok je v priečinku `dist/` – čisto statické súbory s relatívnymi cestami, takže fungujú v ľubovoľnom podpriečinku.

> **Dôležité:** File System Access API funguje len v zabezpečenom kontexte – **HTTPS** alebo `localhost`.

### GitHub Pages

V repozitári je workflow `.github/workflows/deploy.yml` (spúšťa sa ručne cez *Actions → Deploy to GitHub Pages → Run workflow*).
V *Settings → Pages* nastav **Source: GitHub Actions**. GitHub Pages pre súkromné repozitáre vyžaduje platený plán (Pro/Team); inak použi Synology.

### Synology (Web Station)

Podrobný návod je v **[SYNOLOGY.md](SYNOLOGY.md)**. V skratke:

```bash
npm run synology:zip                                    # ZIP na nahratie cez File Station
npm run synology:copy -- "\\192.168.1.10\web\photo-sorter"  # alebo priamo na sieťový priečinok
```

Potom otvor `https://<tvoj-nas>/photo-sorter/` (potrebný platný HTTPS certifikát, napr. Let's Encrypt cez Synology DDNS).

### Inštalácia ako appka

V Chrome / Edge klikni na ikonu inštalácie v paneli s adresou (alebo menu → *Inštalovať Photo Sorter*).

## Testovací priečinok (vývoj)

Vo vývojovom režime je skrytý testovací režim: otvor `http://localhost:5173/?demo`, klikni *Načítať testovací priečinok* – súbory z `dev-fixtures/` (zoznam v `dev-fixtures/manifest.json`) sa skopírujú do súkromného úložiska prehliadača (OPFS) a výstup sa zapíše tiež tam. Priečinok `dev-fixtures/` nie je v gite – vlož doň vlastné testovacie fotky a `manifest.json` so zoznamom relatívnych ciest.

## Štruktúra

| Súbor | Účel |
| --- | --- |
| `src/main.js` | UI, stav, dialógy, vyhľadávanie |
| `src/engine.js` | orchestrácia: pool workerov, CLIP, cache, pauza |
| `src/workers/process.worker.js` | SHA-256, EXIF, rozmery, náhľad, dHash, HEIC |
| `src/workers/clip.worker.js` | CLIP embeddingy (WebGPU / WASM) |
| `src/classify.js` | zero-shot klasifikácia, heuristiky screenshotov, dátum |
| `src/dupes.js` | presné a takmer rovnaké duplikáty |
| `src/output.js` | eventy, plán (dry run), zápis, CSV report |
| `src/settings.js` | predvolené kategórie a prompty |
| `src/ball.js` | animovaná guľa z náhľadov |

## Súkromie

Žiadny server, žiadna analytika. Z internetu sa sťahuje iba AI model z Hugging Face (raz, potom z cache). Fotky, náhľady a embeddingy zostávajú v tvojom prehliadači (IndexedDB) – dajú sa vymazať v Nastaveniach.
