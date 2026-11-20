# Nasadenie na Synology NAS

Photo Sorter je čisto statická stránka – NAS ju len servíruje. Fotky sa triedia v prehliadači na počítači, nie na NAS-e.

> **Podmienka:** appka musí bežať cez **HTTPS s platným certifikátom**. Bez neho prehliadač nepovolí prístup k priečinkom a nepôjde ani inštalácia ako appka (PWA). Self-signed certifikát nestačí.

Postup je pre DSM 7.

---

## 1. Web Station

1. **Centrum balíkov** → nainštaluj **Web Station**.
2. Vytvorí sa zdieľaný priečinok **`web`** (`/volume1/web`). Jeho obsah sa servíruje na `http(s)://<NAS>/`.

## 2. Doména a HTTPS certifikát

Najjednoduchšie je zadarmo cez Synology DDNS a Let's Encrypt:

1. **Ovládací panel → Externý prístup → DDNS → Pridať**
   Poskytovateľ: *Synology*, názov napr. `mojnas.synology.me`.
   Zaškrtni **„Získať certifikát od Let's Encrypt a nastaviť ho ako predvolený“**.
2. Pre vydanie a obnovu certifikátu musí byť z internetu dostupný **port 80** na NAS (presmerovanie na routeri).
3. Over v **Ovládací panel → Zabezpečenie → Certifikát**, že certifikát pre `mojnas.synology.me` je **predvolený**.

Ak NAS nechceš vystavovať do internetu, appku môžeš používať aj lokálne cez `npm run dev` (localhost platí ako zabezpečený kontext).

## 3. Nahratie appky

Na počítači v priečinku projektu:

### Možnosť A – ZIP cez File Station (najjednoduchšie)

```bash
npm run synology:zip
```

Vznikne `photo-sorter-synology.zip`. V DSM otvor **File Station → web**, vytvor priečinok **`photo-sorter`**, nahraj doň ZIP a rozbaľ ho (pravý klik → *Rozbaliť → Rozbaliť sem*). Potom ZIP zmaž.

### Možnosť B – priamo cez sieťový priečinok

Najprv sprístupni zdieľaný priečinok `web` (SMB je v DSM zapnuté predvolene):

- **Windows:** Prieskumník → `\\<IP-NAS>\web` (prípadne *Pripojiť sieťovú jednotku*)
- **macOS:** Finder → *Ísť → Pripojiť k serveru* → `smb://<IP-NAS>/web`

Potom:

```bash
# Windows
npm run synology:copy -- "\\192.168.1.10\web\photo-sorter"

# macOS
npm run synology:copy -- "/Volumes/web/photo-sorter"
```

Skript spraví build a skopíruje `dist/`. Starú verziu v cieľovom priečinku premaže len vtedy, keď je v ňom už Photo Sorter (`index.html`) alebo je prázdny. Iný obsah nechá na pokoji a skončí s chybou.

Cieľ si môžeš uložiť aj do premennej `SYNOLOGY_PATH` a potom stačí `npm run synology:copy`.

## 4. Otvorenie a inštalácia

1. Otvor v Chrome alebo Edge: **`https://mojnas.synology.me/photo-sorter/`** (lomka na konci je dôležitá).
2. V paneli s adresou klikni na ikonu **Inštalovať**. Photo Sorter sa objaví ako samostatná appka.
3. Pri prvom triedení sa stiahne AI model (raz, cca 150–300 MB). Potom appka funguje aj offline.

## 5. Aktualizácia

Zopakuj krok 3. Nainštalovaná appka si novú verziu stiahne sama pri ďalšom otvorení.

---

## Triedenie fotiek, ktoré sú na NAS-e

Priečinok s fotkami vyberáš z počítača, takže sa dá vybrať aj sieťový priečinok:

- **Windows:** namapuj zdieľaný priečinok ako jednotku (napr. `Z:`) a vyber ho v appke.
- **macOS:** pripoj ho vo Finderi (`/Volumes/...`) a vyber ho v appke.

Cez sieť je čítanie pomalšie, hlavne pri prvom spustení. Ďalšie spustenia idú z cache. **Výstupný priečinok** môže byť tiež na NAS-e, ale musí byť nový, nie ten istý ako zdroj.

## Riešenie problémov

| Problém | Riešenie |
| --- | --- |
| „Tento prehliadač nepodporuje prístup k priečinkom“ | Nebeží cez HTTPS s platným certifikátom, alebo nejde o Chrome či Edge. |
| Biela stránka alebo 404 | Skontroluj, že `index.html` je priamo v `web/photo-sorter/` a nie v podpriečinku (napr. `dist/`). |
| AI model sa nenačíta | Prvé stiahnutie potrebuje internet (huggingface.co). V Nastaveniach skús „Vynútiť WASM“. |
| Chyba pri `.wasm` súbore | Web Station má posielať `Content-Type: application/wasm`. DSM 7 to robí predvolene. |
| Nedá sa nainštalovať ako appka | Certifikát nie je platný pre adresu, ktorú používaš (napr. otváraš cez IP namiesto domény). |
