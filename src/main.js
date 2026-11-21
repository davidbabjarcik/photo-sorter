import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { Ball } from './ball.js';
import { scanDirectory } from './scan.js';
import { Engine, ensureClip, onClipEvent, getClipInfo, embedTexts, reclassify } from './engine.js';
import { findDuplicates } from './dupes.js';
import { buildPlan, writePlan } from './output.js';
import { dot } from './classify.js';
import { toEnglishQuery } from './translate.js';
import { loadSettings, saveSettings, resetSettings, activeCategories, FALLBACK_CATEGORY, DUPES_FOLDER } from './settings.js';
import { kvGet, kvSet, clearPhotos, countPhotos } from './db.js';

registerSW({ immediate: true });

// ---------- pomocné ----------
const $ = (s, el = document) => el.querySelector(s);
const nf = new Intl.NumberFormat('sk-SK');
const n = (x) => nf.format(x);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function fmtBytes(b) {
  if (b >= 1e9) return (b / 1e9).toLocaleString('sk-SK', { maximumFractionDigits: 1 }) + ' GB';
  if (b >= 1e6) return (b / 1e6).toLocaleString('sk-SK', { maximumFractionDigits: 1 }) + ' MB';
  return Math.round(b / 1e3).toLocaleString('sk-SK') + ' kB';
}
const fmtSec = (s) => s.toLocaleString('sk-SK', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' s';
const fmtDate = (t) => new Date(t).toLocaleString('sk-SK', { dateStyle: 'medium', timeStyle: 'short' });
const folderWord = (k) => (k === 1 ? 'priečinka' : 'priečinkov');
function toast(msg, ms = 3500) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

const params = new URLSearchParams(location.search);
const DEMO = import.meta.env.DEV && params.has('demo');
const supported = 'showDirectoryPicker' in window || DEMO;

// ---------- stav ----------
const S = {
  settings: null,
  source: null,
  entries: null,
  engine: null,
  phase: 'idle', // idle | scanned | sorting | paused | done | writing
  records: [],
  cards: new Map(),
  live: { sha: new Set(), dupes: 0, saved: 0 },
  dup: null,
  plan: null,
};

const ball = new Ball($('#ball'));

// ---------- téma ----------
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
let theme = (() => { try { return localStorage.getItem('theme') || 'auto'; } catch { return 'auto'; } })();
applyTheme(theme);
$('#btn-theme').onclick = () => {
  const dark = theme === 'dark' || (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  theme = dark ? 'light' : 'dark';
  applyTheme(theme);
  try { localStorage.setItem('theme', theme); } catch { /* nič */ }
};

// ---------- karty priečinkov ----------
function cardFor(cat) {
  let c = S.cards.get(cat.id);
  if (c) return c;
  const el = document.createElement('button');
  el.className = 'card empty';
  el.innerHTML = `<div class="card-head"><div class="card-icon">${esc(cat.icon)}</div><div><div class="card-name">${esc(cat.name)}</div><div class="card-count">0 fotiek</div></div></div><div class="minis"><div></div><div></div><div></div><div></div></div>`;
  el.onclick = () => openFolder(cat.id);
  $('#cards').append(el);
  c = { cat, el, recs: [], minis: [], urls: [], dirty: false };
  S.cards.set(cat.id, c);
  return c;
}

function resetCards() {
  for (const c of S.cards.values()) c.urls.forEach((u) => URL.revokeObjectURL(u));
  S.cards.clear();
  $('#cards').innerHTML = '';
  for (const cat of activeCategories(S.settings)) cardFor(cat);
}

const countWord = (k) => (k === 1 ? 'fotka' : k >= 2 && k <= 4 ? 'fotky' : 'fotiek');
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function render() {
  for (const c of S.cards.values()) {
    if (!c.dirty) continue;
    c.dirty = false;
    c.el.classList.toggle('empty', c.recs.length === 0);
    c.el.querySelector('.card-count').textContent = `${n(c.recs.length)} ${countWord(c.recs.length)}`;
    const slots = c.el.querySelectorAll('.minis div');
    const last = c.recs.filter((r) => r.thumb).slice(-4).reverse();
    last.forEach((r, i) => {
      if (c.minis[i] === r) return;
      c.minis[i] = r;
      if (c.urls[i]) URL.revokeObjectURL(c.urls[i]);
      c.urls[i] = URL.createObjectURL(r.thumb);
      slots[i].style.backgroundImage = `url("${c.urls[i]}")`;
    });
  }
  renderStats();
  renderProgress();
}

function nonEmptyFolders() {
  let k = 0;
  for (const c of S.cards.values()) if (c.recs.length) k++;
  return k;
}

function renderStats() {
  const total = S.entries?.length ?? 0;
  let photos = 0, other = 0;
  for (const r of S.records) (r.cat?.nonPhoto || r.cat === FALLBACK_CATEGORY && r.error ? other++ : photos++);
  $('#st-total').textContent = n(total);
  $('#st-photos').textContent = n(photos);
  $('#st-other').textContent = n(other);
  const folders = S.phase === 'done' && S.plan ? S.plan.folders.length : nonEmptyFolders();
  $('#st-folders').textContent = n(folders);
  const dupes = S.dup ? S.dup.dupeCount : S.live.dupes;
  const saved = S.dup ? S.dup.savedBytes : S.live.saved;
  $('#st-dupes').textContent = n(dupes);
  $('#st-saved').textContent = dupes ? `(+${fmtBytes(saved)})` : '';
  if (S.phase === 'sorting' || S.phase === 'paused') {
    const k = S.cards.size;
    $('#title').textContent = `Triedim do ${n(k)} ${folderWord(k)}.`;
  }
}

function renderProgress() {
  const total = S.entries?.length ?? 0;
  const done = S.engine?.done ?? 0;
  if (S.engine) {
    $('#progress').textContent = `${n(done)} z ${n(total)} · ${fmtSec(S.engine.seconds)}`;
    $('#bar-fill').style.width = total ? `${(done / total) * 100}%` : '0';
  }
}
setInterval(() => { if (S.phase === 'sorting') renderProgress(); }, 100);

// ---------- animácia odletu ----------
let flights = 0;
// Fronta náhľadov do gule: drží len posledných ~150, spracúva pár za snímku (aj pri desaťtisícoch fotiek).
const ballQueue = [];
let ballPumping = false;
function addToBall(rec) {
  if (!rec.thumb) return;
  ballQueue.push(rec.thumb);
  if (ballQueue.length > 150) ballQueue.splice(0, ballQueue.length - 150);
  if (!ballPumping) pumpBall();
}
async function pumpBall() {
  ballPumping = true;
  while (ballQueue.length) {
    const batch = ballQueue.splice(0, 4);
    const bitmaps = await Promise.all(batch.map((b) => createImageBitmap(b, { resizeWidth: 72, resizeQuality: 'low' }).catch(() => null)));
    bitmaps.forEach((b) => b && ball.add(b));
    await new Promise((r) => requestAnimationFrame(r));
  }
  ballPumping = false;
}

function fly(rec, card) {
  if (!rec.thumb || flights >= 10 || document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    card.el.classList.remove('bump'); void card.el.offsetWidth; card.el.classList.add('bump');
    return;
  }
  const from = ball.takeOut() || (() => { const r = $('#ball').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })();
  const target = card.el.querySelector('.card-icon').getBoundingClientRect();
  if (target.bottom < 0 || target.top > innerHeight) return;
  flights++;
  const img = document.createElement('img');
  img.className = 'flyer';
  const url = URL.createObjectURL(rec.thumb);
  img.src = url;
  $('#fly-layer').append(img);
  const x0 = from.x - 22, y0 = from.y - 22;
  const x1 = target.left + target.width / 2 - 22, y1 = target.top + target.height / 2 - 22;
  const mx = (x0 + x1) / 2, my = Math.min(y0, y1) - 80 - Math.random() * 60;
  const anim = img.animate([
    { transform: `translate(${x0}px, ${y0}px) scale(0.6)`, opacity: 0.4 },
    { transform: `translate(${mx}px, ${my}px) scale(1.35)`, opacity: 1, offset: 0.45 },
    { transform: `translate(${x1}px, ${y1}px) scale(0.5)`, opacity: 0.3 },
  ], { duration: 650 + Math.random() * 250, easing: 'cubic-bezier(.45,0,.25,1)' });
  anim.onfinish = anim.oncancel = () => {
    img.remove();
    URL.revokeObjectURL(url);
    flights--;
    card.el.classList.remove('bump'); void card.el.offsetWidth; card.el.classList.add('bump');
  };
}

// ---------- výber priečinka a skenovanie ----------
async function pickSource() {
  try {
    const h = await window.showDirectoryPicker({ id: 'photo-sorter-src', mode: 'read' });
    await setSource(h);
    return true;
  } catch (err) {
    if (err?.name !== 'AbortError') toast('Priečinok sa nepodarilo otvoriť: ' + err.message);
    return false;
  }
}

async function setSource(handle) {
  if (S.engine && (S.phase === 'sorting' || S.phase === 'paused')) S.engine.cancel();
  S.source = handle;
  S.phase = 'scanning';
  S.records = [];
  S.engine = null;
  S.dup = null;
  S.plan = null;
  S.live = { sha: new Set(), dupes: 0, saved: 0 };
  ball.clear();
  resetCards();
  $('#title').textContent = 'Moje fotky sú totálny chaos.';
  $('#progress').innerHTML = '&nbsp;';
  $('#bar-fill').style.width = '0';
  if (!DEMO) kvSet('lastSource', handle).catch(() => {});
  setButtons();
  // AI model sa začne načítavať hneď na pozadí (prvýkrát sťahuje, potom je v cache a funguje offline).
  ensureClip(S.settings).then(showDevice).catch((err) => console.warn('CLIP:', err));
  $('#subtitle').textContent = `Prehľadávam „${handle.name}“…`;
  S.entries = await scanDirectory(handle, (k) => { $('#st-total').textContent = n(k); $('#status').textContent = `Nájdených ${n(k)} obrázkov…`; });
  S.phase = 'scanned';
  $('#subtitle').textContent = `Priečinok „${handle.name}“ · ${n(S.entries.length)} obrázkov (jpg, png, webp, heic). Stlač Roztriediť.`;
  $('#status').innerHTML = '&nbsp;';
  $('#resume-row').hidden = true;
  render();
  setButtons();
}

function setButtons() {
  const sortBtn = $('#btn-sort'), pauseBtn = $('#btn-pause'), pickBtn = $('#btn-pick');
  pickBtn.disabled = !supported || S.phase === 'scanning' || S.phase === 'writing';
  pauseBtn.hidden = !(S.phase === 'sorting' || S.phase === 'paused');
  pauseBtn.textContent = S.phase === 'paused' ? 'Pokračovať' : 'Pauza';
  sortBtn.disabled = !supported || S.phase === 'scanning' || S.phase === 'sorting' || S.phase === 'paused' || S.phase === 'writing';
  sortBtn.textContent = S.phase === 'done' ? 'Náhľad a zápis' : 'Roztriediť';
  ball.setBusy(S.phase === 'sorting');
}

// ---------- triedenie ----------
async function startSort() {
  if (!S.entries) {
    if (!(await pickSource())) return;
  }
  if (!S.entries.length) { toast('V priečinku nie sú žiadne fotky.'); return; }
  S.phase = 'sorting';
  S.records = [];
  S.dup = null;
  S.live = { sha: new Set(), dupes: 0, saved: 0 };
  resetCards();
  setButtons();
  renderStats();
  $('#subtitle').textContent = `Priečinok „${S.source.name}“ · ${n(S.entries.length)} obrázkov. Fotky sa analyzujú lokálne, nič sa neuploaduje.`;
  $('#status').textContent = 'Spúšťam…';
  const engine = new Engine({
    settings: S.settings,
    onAnalyzed: addToBall,
    onItem: (rec) => {
      S.records.push(rec);
      if (rec.sha256) {
        if (S.live.sha.has(rec.sha256)) { S.live.dupes++; S.live.saved += rec.size; } else S.live.sha.add(rec.sha256);
      }
      const card = cardFor(rec.cat);
      card.recs.push(rec);
      card.dirty = true;
      fly(rec, card);
      scheduleRender();
      if (engine.done === 1) $('#status').textContent = getClipInfo() ? `AI beží na ${getClipInfo().device === 'webgpu' ? 'WebGPU' : 'WASM (CPU)'}` : 'Triedim bez AI (model sa nenačítal)';
    },
    onLog: (m) => console.warn(m),
  });
  S.engine = engine;
  try {
    await engine.run(S.entries);
  } catch (err) {
    console.error(err);
    toast('Chyba pri triedení: ' + err.message, 6000);
  }
  if (S.engine !== engine) return; // medzitým vybraný iný priečinok
  if (engine.cancelled) return;
  finishSort();
}

function finishSort() {
  S.dup = findDuplicates(S.records, S.settings);
  for (const r of S.records) r.dupeOf = null;
  for (const g of S.dup.groups) for (const d of g.dupes) d.dupeOf = g.keep;
  S.phase = 'done';
  S.plan = buildPlan(S.records, new Set(S.records.filter((r) => r.dupeOf)), S.settings);
  const k = S.plan.folders.length;
  $('#title').textContent = `Roztriedené do ${n(k)} ${folderWord(k)}.`;
  $('#subtitle').textContent = `Priečinok „${S.source.name}“ · ${n(S.records.length)} obrázkov. Klikni na kartu pre detail alebo na Náhľad a zápis.`;
  const errs = S.records.filter((r) => r.error).length;
  $('#status').textContent = `Hotovo za ${fmtSec(S.engine.seconds)}.` + (errs ? ` ${n(errs)} súborov sa nepodarilo prečítať (pôjdu do „Ostatné“).` : '') + ' Nič sa zatiaľ nezapísalo – pozri Náhľad a zápis.';
  for (const c of S.cards.values()) c.dirty = true;
  render();
  setButtons();
  // pri malom počte fotiek guľu doplň opakovanými náhľadmi, nech nie je poloprázdna
  const withThumb = S.records.filter((r) => r.thumb);
  if (withThumb.length && withThumb.length < 150) for (let i = 0; i < 150; i++) addToBall(withThumb[i % withThumb.length]);
}

$('#btn-pick').onclick = pickSource;
$('#btn-sort').onclick = () => (S.phase === 'done' ? openPlan() : startSort());
$('#btn-pause').onclick = () => {
  if (!S.engine) return;
  if (S.phase === 'sorting') {
    S.engine.pause();
    S.phase = 'paused';
    $('#status').textContent = 'Pozastavené. Priebeh je uložený – môžeš aj zavrieť okno a neskôr pokračovať.';
  } else if (S.phase === 'paused') {
    S.engine.resume();
    S.phase = 'sorting';
    $('#status').textContent = 'Pokračujem…';
  }
  setButtons();
};

// stav sťahovania modelu
const loadState = new Map();
onClipEvent((ev) => {
  if (ev.type === 'load-progress' && ev.total) {
    loadState.set(ev.file, ev);
    let loaded = 0, total = 0;
    for (const v of loadState.values()) { loaded += v.loaded || 0; total += v.total || 0; }
    if (total > 5e6 && loaded < total) $('#status').textContent = `Sťahujem AI model (iba prvýkrát)… ${Math.round((loaded / total) * 100)} % z ${fmtBytes(total)}`;
  } else if (ev.type === 'log') console.warn(ev.msg);
});

function showDevice() {
  const info = getClipInfo();
  if (!info) return;
  const pill = $('#device');
  pill.hidden = false;
  pill.textContent = info.device === 'webgpu' ? 'AI: WebGPU' : 'AI: WASM';
}
setInterval(showDevice, 1000);

// ---------- dialógy ----------
const dialogUrls = new WeakMap();
// Pozn.: URL náhľadov sa uvoľnia pri zatvorení dialógu (udalosť „close“), nie tu – HTML ich už obsahuje.
function openDialog(dlg, html) {
  dlg.innerHTML = html;
  dlg.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => dlg.close()));
  if (!dlg.open) dlg.showModal();
  return dlg;
}
function trackUrl(dlg, blob) {
  const u = URL.createObjectURL(blob);
  if (!dialogUrls.has(dlg)) dialogUrls.set(dlg, []);
  dialogUrls.get(dlg).push(u);
  return u;
}
function closeUrls(dlg) {
  (dialogUrls.get(dlg) || []).forEach((u) => URL.revokeObjectURL(u));
  dialogUrls.set(dlg, []);
}
document.querySelectorAll('dialog').forEach((d) => {
  d.addEventListener('close', () => closeUrls(d));
  d.addEventListener('click', (e) => { if (e.target === d && d.id !== 'dlg-confirm') d.close(); });
});

const head = (title) => `<div class="dlg-head"><h2>${title}</h2><button class="ghost" data-close aria-label="Zavrieť">✕</button></div>`;

function thumbHtml(dlg, rec, badge = '', badgeClass = '') {
  const src = rec.thumb ? trackUrl(dlg, rec.thumb) : '';
  return `<button class="thumb" data-key="${esc(rec.key)}" title="${esc(rec.path)}">${src ? `<img loading="lazy" src="${src}" alt="">` : ''}${badge ? `<span class="badge ${badgeClass}">${esc(badge)}</span>` : ''}</button>`;
}
function bindThumbs(container) {
  const byKey = new Map(S.records.map((r) => [r.key, r]));
  container.querySelectorAll('.thumb[data-key]').forEach((b) => (b.onclick = () => openPhoto(byKey.get(b.dataset.key))));
}

function openFolder(catId) {
  const c = S.cards.get(catId);
  if (!c) return;
  const dlg = $('#dlg-folder');
  const recs = [...c.recs].sort((a, b) => a.date - b.date);
  const shown = recs.slice(0, 600);
  openDialog(dlg, `${head(`${esc(c.cat.icon)} ${esc(c.cat.name)} <span class="muted small">· ${n(recs.length)} ${countWord(recs.length)}</span>`)}
    <div class="dlg-body">
      ${recs.length ? '' : '<p class="muted">Zatiaľ prázdne.</p>'}
      <div class="grid">${shown.map((r) => thumbHtml(dlg, r, r.dupeOf ? 'duplikát' : '', r.dupeOf ? 'dup' : '')).join('')}</div>
      ${recs.length > shown.length ? `<p class="muted small">Zobrazených prvých ${n(shown.length)}.</p>` : ''}
    </div>`);
  bindThumbs(dlg);
}

async function openPhoto(rec) {
  if (!rec) return;
  const dlg = $('#dlg-photo');
  let src = rec.thumb ? trackUrl(dlg, rec.thumb) : '';
  if (rec.ext !== 'heic' && rec.ext !== 'heif' && rec.handle) {
    try { src = trackUrl(dlg, await rec.handle.getFile()); } catch { /* ostane náhľad */ }
  }
  openDialog(dlg, `${head(esc(rec.name))}
    <div class="dlg-body photo-view">
      ${src ? `<img src="${src}" alt="">` : ''}
      <dl class="kv">
        <dt>Cesta</dt><dd>${esc(rec.path)}</dd>
        <dt>Kategória</dt><dd>${esc(rec.cat?.icon)} ${esc(rec.cat?.name)} <span class="muted">(${esc(rec.reason)}${rec.p ? ', ' + Math.round(rec.p * 100) + ' %' : ''})</span></dd>
        <dt>Dátum</dt><dd>${fmtDate(rec.date)} <span class="muted">(${esc(rec.dateSource)})</span></dd>
        <dt>Rozmery</dt><dd>${rec.width ? `${rec.width} × ${rec.height}` : '–'} · ${fmtBytes(rec.size)}</dd>
        ${rec.make || rec.model ? `<dt>Fotoaparát</dt><dd>${esc([rec.make, rec.model].filter(Boolean).join(' '))}</dd>` : ''}
        ${rec.dupeOf ? `<dt>Duplikát</dt><dd>lepšia verzia: ${esc(rec.dupeOf.path)}</dd>` : ''}
        ${rec.error ? `<dt>Chyba</dt><dd class="err">${esc(rec.error)}</dd>` : ''}
      </dl>
    </div>`);
}

function openDupes() {
  const dlg = $('#dlg-dupes');
  if (!S.dup) {
    openDialog(dlg, `${head('Duplikáty')}<div class="dlg-body"><p class="muted">${S.phase === 'sorting' || S.phase === 'paused' ? `Zatiaľ ${n(S.live.dupes)} presných kópií. Podobné fotky sa vyhodnotia po dokončení triedenia.` : 'Najprv roztrieď priečinok.'}</p></div>`);
    return;
  }
  const groups = S.dup.groups.slice(0, 200);
  openDialog(dlg, `${head(`Duplikáty <span class="muted small">· ${n(S.dup.dupeCount)} súborov · ušetrí ${fmtBytes(S.dup.savedBytes)}</span>`)}
    <div class="dlg-body">
      <p class="muted small">Ponecháva sa verzia s najvyšším rozlíšením (potom väčší súbor a EXIF). Ostatné sa pri zápise dajú do „${DUPES_FOLDER}“, preskočia, alebo ponechajú – podľa voľby v náhľade. Nič sa nemaže.</p>
      ${groups.length ? '' : '<p>Žiadne duplikáty. 🎉</p>'}
      ${groups.map((g) => `<div class="dupe-group">
        <div class="small muted">${g.exact ? 'Presná kópia (SHA-256)' : 'Takmer rovnaké'} · ${g.dupes.length + 1} verzie · ušetrí ${fmtBytes(g.dupes.reduce((s, d) => s + d.size, 0))}</div>
        <div class="grid" style="margin-top:8px">${thumbHtml(dlg, g.keep, 'ponechať', 'keep')}${g.dupes.map((d) => thumbHtml(dlg, d, 'duplikát', 'dup')).join('')}</div>
      </div>`).join('')}
      ${S.dup.groups.length > groups.length ? `<p class="muted small">Zobrazených prvých ${groups.length} skupín.</p>` : ''}
    </div>`);
  bindThumbs(dlg);
}
$('#st-dupes-btn').onclick = openDupes;

// ---------- náhľad (dry run) a zápis ----------
function seg(name, value, options) {
  return `<div class="seg">${options.map(([v, label]) => `<label><input type="radio" name="${name}" value="${v}" ${v === value ? 'checked' : ''}>${label}</label>`).join('')}</div>`;
}

function openPlan() {
  const dlg = $('#dlg-plan');
  const s = S.settings;
  openDialog(dlg, `${head('Náhľad bez zápisu')}
    <div class="dlg-body">
      <div class="row"><span class="lbl">Štruktúra</span>${seg('layout', s.layout, [['cat', 'Kategória/…'], ['date', 'Dátum/…'], ['cat-date', 'Kategória/Dátum/…']])}</div>
      <div class="row"><span class="lbl">Duplikáty</span>${seg('dupes', s.dupes, [['folder', `do „${DUPES_FOLDER}“`], ['skip', 'nekopírovať'], ['keep', 'triediť normálne']])}</div>
      <div class="row"><span class="lbl">Režim</span>${seg('mode', 'copy', [['copy', 'Kopírovať (originály ostanú)'], ['move', 'Presunúť']])}</div>
      <div class="row"><span class="lbl">Medzera medzi eventmi</span><input type="number" id="gap" min="1" max="168" step="1" value="${s.eventGapHours}" style="width:80px"> hodín</div>
      <div id="plan-warn"></div>
      <p id="plan-summary"></p>
      <div id="plan-tree" class="tree"></div>
    </div>
    <div class="dlg-foot"><span id="plan-progress" class="muted" style="margin-right:auto"></span><button class="secondary" data-close>Zavrieť</button><button class="yellow" id="btn-write">Vybrať výstupný priečinok a zapísať</button></div>`);

  const refresh = () => {
    const fd = Object.fromEntries([...dlg.querySelectorAll('input[type=radio]:checked')].map((i) => [i.name, i.value]));
    s.layout = fd.layout; s.dupes = fd.dupes; s.eventGapHours = Math.max(1, +$('#gap', dlg).value || 6);
    saveSettings(s);
    S.plan = buildPlan(S.records, new Set(S.records.filter((r) => r.dupeOf)), s);
    const p = S.plan;
    $('#plan-summary', dlg).innerHTML = `<strong>${n(p.ops.length)} súborov · ${fmtBytes(p.totalBytes)} · ${n(p.folders.length)} priečinkov.</strong> <span class="muted">Ukážka štruktúry – na disk sa zatiaľ nič nezapísalo.</span>`;
    $('#plan-warn', dlg).innerHTML = fd.mode === 'move'
      ? '<div class="warn">⚠️ <strong>Presúvanie:</strong> po úspešnom skopírovaní sa originál zo zdrojového priečinka <strong>zmaže</strong>. Pred zápisom sa ešte opýtam.</div>' : '';
    $('#plan-tree', dlg).innerHTML = p.folders.slice(0, 400).map((f) => `<details><summary><span class="path">📁 ${esc(f.dir.join(' / '))}</span><span class="muted small">${n(f.count)} · ${fmtBytes(f.bytes)}</span></summary><ul></ul></details>`).join('')
      + (p.folders.length > 400 ? `<p class="muted small">…a ďalších ${n(p.folders.length - 400)} priečinkov.</p>` : '');
    const opsByDir = new Map();
    for (const o of p.ops) { const k = o.dir.join('/'); if (!opsByDir.has(k)) opsByDir.set(k, []); opsByDir.get(k).push(o); }
    dlg.querySelectorAll('#plan-tree details').forEach((d, i) => {
      d.addEventListener('toggle', () => {
        const ul = d.querySelector('ul');
        if (!d.open || ul.childElementCount) return;
        const ops = opsByDir.get(p.folders[i].dir.join('/')) || [];
        ul.innerHTML = ops.slice(0, 300).map((o) => `<li>${esc(o.name)} <span class="muted">← ${esc(o.rec.path)}</span></li>`).join('') + (ops.length > 300 ? `<li>…a ďalších ${n(ops.length - 300)}</li>` : '');
      });
    });
    renderStats();
    $('#title').textContent = `Roztriedené do ${n(p.folders.length)} ${folderWord(p.folders.length)}.`;
  };
  dlg.querySelectorAll('input').forEach((i) => i.addEventListener('change', refresh));
  refresh();
  $('#btn-write', dlg).onclick = () => doWrite(dlg);
}

function confirmDialog(title, html, okLabel, danger = false) {
  return new Promise((resolve) => {
    const dlg = $('#dlg-confirm');
    openDialog(dlg, `${head(title)}<div class="dlg-body">${html}</div><div class="dlg-foot"><button class="secondary" id="c-no">Zrušiť</button><button class="${danger ? 'danger' : 'yellow'}" id="c-yes">${okLabel}</button></div>`);
    const done = (v) => { dlg.close(); resolve(v); };
    $('#c-no', dlg).onclick = () => done(false);
    $('#c-yes', dlg).onclick = () => done(true);
    dlg.querySelector('[data-close]').onclick = () => done(false);
    dlg.addEventListener('cancel', () => resolve(false), { once: true });
  });
}

async function demoOutputDir() {
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry('demo-output', { recursive: true }); } catch { /* nebol */ }
  return root.getDirectoryHandle('demo-output', { create: true });
}

async function doWrite(dlg) {
  const mode = dlg.querySelector('input[name=mode]:checked').value;
  let out;
  try {
    out = DEMO ? await demoOutputDir() : await window.showDirectoryPicker({ id: 'photo-sorter-out', mode: 'readwrite', startIn: 'pictures' });
  } catch (err) {
    if (err?.name !== 'AbortError') toast('Výstupný priečinok sa nepodarilo otvoriť: ' + err.message);
    return;
  }
  if (await out.isSameEntry(S.source)) {
    toast('Výstupný priečinok nesmie byť ten istý ako zdrojový. Vyber nový, prázdny priečinok.', 6000);
    return;
  }
  const inside = await S.source.resolve(out).catch(() => null);
  if (inside) {
    const ok = await confirmDialog('Výstup je vnútri zdrojového priečinka', `<p>Priečinok „${esc(out.name)}“ je vnútri „${esc(S.source.name)}“. Pri ďalšom triedení by sa fotky načítali znova. Odporúčam vybrať priečinok mimo zdroja.</p>`, 'Pokračovať aj tak');
    if (!ok) return;
  }
  let nonEmpty = false;
  for await (const _ of out.keys()) { nonEmpty = true; break; }
  if (nonEmpty) {
    const ok = await confirmDialog('Priečinok nie je prázdny', `<p>„${esc(out.name)}“ už obsahuje súbory. Nič sa neprepíše – pri zhode názvu dostane nový súbor príponu (1), (2)…</p>`, 'Pokračovať');
    if (!ok) return;
  }
  if (mode === 'move') {
    const ok = await confirmDialog('Naozaj presunúť?', `<p>${n(S.plan.ops.length)} súborov sa skopíruje do „${esc(out.name)}“ a <strong>originály sa potom zmažú</strong> zo „${esc(S.source.name)}“. Ak si nie si istý, zvoľ Kopírovať.</p>`, 'Áno, presunúť', true);
    if (!ok) return;
    if (!DEMO) {
      const perm = await S.source.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') { toast('Bez povolenia na zápis do zdroja sa nedá presúvať.'); return; }
    }
  }

  if (!dlg.open) dlg.showModal();
  S.phase = 'writing';
  setButtons();
  let cancelled = false;
  const btn = $('#btn-write', dlg);
  btn.textContent = 'Zastaviť';
  btn.onclick = () => { cancelled = true; btn.disabled = true; };
  const prog = $('#plan-progress', dlg);
  const t0 = performance.now();
  const res = await writePlan(S.plan, out, {
    mode,
    isCancelled: () => cancelled,
    onProgress: (d, t, b) => {
      prog.textContent = `${mode === 'move' ? 'Presúvam' : 'Kopírujem'} ${n(d)} z ${n(t)} · ${fmtBytes(b)} · ${fmtSec((performance.now() - t0) / 1000)}`;
      $('#bar-fill').style.width = `${(d / t) * 100}%`;
    },
  });
  S.phase = 'done';
  setButtons();
  btn.disabled = false;
  btn.textContent = 'Hotovo';
  btn.onclick = () => dlg.close();
  prog.innerHTML = `${cancelled ? 'Zastavené' : 'Hotovo'}: ${n(res.done - res.errors.length)} súborov (${fmtBytes(res.bytes)}) do „${esc(out.name)}“.` + (res.errors.length ? ` <span class="err">${n(res.errors.length)} chýb – pozri CSV report.</span>` : '');
  if (DEMO) window.__demoResult = res;
  if (mode === 'move' && res.done) {
    S.entries = null;
    $('#subtitle').textContent = 'Súbory boli presunuté. Pre ďalšie triedenie vyber priečinok znova.';
  }
  toast(`Zapísané: ${n(res.done - res.errors.length)} súborov. Report CSV je vo výstupnom priečinku.`, 5000);
}

// ---------- nastavenia ----------
function openSettings() {
  const dlg = $('#dlg-settings');
  const s = JSON.parse(JSON.stringify(S.settings));
  const catRow = (setIdx, c, i) => `<div class="cat-row" data-set="${setIdx}" data-i="${i}">
      <input type="text" class="icon-in" data-f="icon" value="${esc(c.icon)}" aria-label="Ikona">
      <input type="text" data-f="name" value="${esc(c.name)}" aria-label="Názov">
      <textarea data-f="prompts" aria-label="Prompty (jeden na riadok)" placeholder="Jeden anglický prompt na riadok">${esc(c.prompts.join('\n'))}</textarea>
      <button class="ghost" data-del title="Odstrániť kategóriu">🗑</button>
    </div>`;
  const build = () => {
    openDialog(dlg, `${head('Nastavenia')}
      <div class="dlg-body">
        <h3 style="margin-top:0">Kategórie</h3>
        <p class="muted small">Každá kategória má vlastné textové prompty pre CLIP (najlepšie anglicky, jeden na riadok). Fotka ide do kategórie s najvyššou podobnosťou; pri nízkej istote do „${FALLBACK_CATEGORY.name}“.</p>
        ${s.sets.map((set, si) => `<div class="set-block">
          <h3><label><input type="checkbox" data-set-enabled="${si}" ${set.enabled ? 'checked' : ''}> ${esc(set.name)}</label></h3>
          ${set.categories.map((c, i) => catRow(si, c, i)).join('')}
          <button class="secondary" data-add="${si}" style="margin-top:8px">+ Pridať kategóriu</button>
        </div>`).join('')}
        <h3>Triedenie</h3>
        <div class="row"><span class="lbl">Min. istota AI</span><input type="number" id="s-conf" min="0" max="0.9" step="0.05" value="${s.minConfidence}" style="width:90px"><span class="muted small">pod touto hodnotou → „${FALLBACK_CATEGORY.name}“</span></div>
        <div class="row"><span class="lbl">Heuristiky screenshotov</span><label><input type="checkbox" id="s-heur" ${s.screenshotHeuristics ? 'checked' : ''}> PNG, chýbajúci EXIF fotoaparátu, rozlíšenie displeja, „Screenshot“ v názve</label></div>
        <div class="row"><span class="lbl">Takmer rovnaké fotky</span>
          <label class="field">dHash vzdialenosť (0 = vypnuté)<input type="number" id="s-ham" min="0" max="7" step="1" value="${s.nearDupHamming}" style="width:90px"></label>
          <label class="field">CLIP podobnosť (1 = vypnuté)<input type="number" id="s-clipdup" min="0.8" max="1" step="0.005" value="${s.nearDupClip}" style="width:90px"></label>
        </div>
        <div class="row"><span class="lbl">Medzera medzi eventmi</span><input type="number" id="s-gap" min="1" max="168" value="${s.eventGapHours}" style="width:90px"> hodín</div>
        <div class="row"><span class="lbl">AI výpočet</span><label><input type="checkbox" id="s-wasm" ${s.forceWasm ? 'checked' : ''}> Vynútiť WASM (bez WebGPU) – platí po reštarte appky</label></div>
        <h3>Dáta</h3>
        <p class="muted small" id="s-cache">Cache: …</p>
        <button class="secondary" id="s-clear">Vymazať uložené analýzy a embeddingy</button>
      </div>
      <div class="dlg-foot"><button class="ghost" id="s-reset" style="margin-right:auto">Obnoviť predvolené</button><button class="secondary" data-close>Zrušiť</button><button class="yellow" id="s-save">Uložiť</button></div>`);
    countPhotos().then((k) => { const el = $('#s-cache', dlg); if (el) el.textContent = `V IndexedDB je uložených ${n(k)} analyzovaných fotiek (náhľady, hashe, embeddingy).`; });
    dlg.querySelectorAll('[data-add]').forEach((b) => (b.onclick = () => { collect(); s.sets[+b.dataset.add].categories.push({ id: 'c' + Date.now().toString(36), name: 'Nová kategória', icon: '📁', prompts: ['a photo of something'] }); build(); }));
    dlg.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => { collect(); const row = b.closest('.cat-row'); s.sets[+row.dataset.set].categories.splice(+row.dataset.i, 1); build(); }));
    $('#s-reset', dlg).onclick = () => { Object.assign(s, resetSettings()); build(); };
    $('#s-clear', dlg).onclick = async () => {
      if (!(await confirmDialog('Vymazať cache?', '<p>Pri ďalšom triedení sa všetky fotky analyzujú odznova. Tvoje fotky ani výstupné priečinky sa nezmenia.</p>', 'Vymazať'))) return;
      await clearPhotos();
      toast('Cache vymazaná.');
    };
    $('#s-save', dlg).onclick = async () => {
      collect();
      s.setsCustomized = JSON.stringify(s.sets) !== JSON.stringify(resetSettings().sets);
      s.minConfidence = +$('#s-conf', dlg).value || 0;
      s.screenshotHeuristics = $('#s-heur', dlg).checked;
      s.nearDupHamming = Math.max(0, Math.min(7, +$('#s-ham', dlg).value || 0));
      s.nearDupClip = Math.max(0.8, Math.min(1, +$('#s-clipdup', dlg).value || 1));
      s.eventGapHours = Math.max(1, +$('#s-gap', dlg).value || 6);
      s.forceWasm = $('#s-wasm', dlg).checked;
      S.settings = s;
      await saveSettings(s);
      dlg.close();
      await applySettingsChange();
    };
  };
  const collect = () => {
    dlg.querySelectorAll('[data-set-enabled]').forEach((c) => (s.sets[+c.dataset.setEnabled].enabled = c.checked));
    dlg.querySelectorAll('.cat-row').forEach((row) => {
      const c = s.sets[+row.dataset.set].categories[+row.dataset.i];
      c.icon = row.querySelector('[data-f=icon]').value.trim() || '📁';
      c.name = row.querySelector('[data-f=name]').value.trim() || 'Bez názvu';
      c.prompts = row.querySelector('[data-f=prompts]').value.split('\n').map((x) => x.trim()).filter(Boolean);
    });
  };
  build();
}
$('#btn-settings').onclick = openSettings;

async function applySettingsChange() {
  if (S.phase === 'sorting' || S.phase === 'paused') {
    toast('Nové nastavenia sa použijú pri ďalšom triedení.');
    return;
  }
  if (S.phase !== 'done' || !S.records.length) { resetCards(); return; }
  $('#status').textContent = 'Preklasifikovávam podľa nových kategórií…';
  try {
    await reclassify(S.records, S.settings);
  } catch (err) {
    toast('AI model nie je k dispozícii: ' + err.message);
  }
  resetCards();
  for (const r of S.records) { const c = cardFor(r.cat); c.recs.push(r); c.dirty = true; }
  finishSort();
}

// ---------- vyhľadávanie ----------
const searchInput = $('#search');
const results = $('#search-results');
let searchUrls = [];
let searchSeq = 0;
async function doSearch(q) {
  const seq = ++searchSeq;
  searchUrls.forEach((u) => URL.revokeObjectURL(u));
  searchUrls = [];
  if (!q.trim()) { results.hidden = true; return; }
  results.hidden = false;
  const withEmb = S.records.filter((r) => r.emb);
  if (!withEmb.length) {
    results.innerHTML = `<p class="muted">${S.records.length ? 'Fotky zatiaľ nemajú AI embeddingy.' : 'Najprv vyber priečinok a stlač Roztriediť.'}</p>`;
    return;
  }
  const { text, translated } = toEnglishQuery(q);
  results.innerHTML = '<p class="muted">Hľadám…</p>';
  let emb;
  try {
    [emb] = await embedTexts([text], S.settings);
  } catch (err) {
    results.innerHTML = `<p class="err">AI model nie je k dispozícii: ${esc(err.message)}</p>`;
    return;
  }
  if (seq !== searchSeq) return;
  const all = withEmb.map((r) => ({ r, s: dot(r.emb, emb) })).sort((a, b) => b.s - a.s);
  // len výsledky blízko najlepšej zhody (inak by sa vždy ukázalo 60 fotiek, aj nesúvisiacich)
  const scored = all.filter((x, i) => i < 6 || x.s >= all[0].s - 0.04).slice(0, 60);
  const html = scored.map(({ r, s }) => {
    const u = URL.createObjectURL(r.thumb);
    searchUrls.push(u);
    return `<button class="thumb" data-key="${esc(r.key)}" title="${esc(r.path)}"><img loading="lazy" src="${u}" alt=""><span class="badge">${Math.round(s * 100)}</span></button>`;
  }).join('');
  results.innerHTML = `<div class="head"><span><strong>${n(scored.length)}</strong> najpodobnejších pre „${esc(q)}“ <span class="muted small">(CLIP: „${esc(translated)}“)</span></span><button class="ghost" id="search-close">✕</button></div><div class="grid">${html}</div>`;
  $('#search-close').onclick = () => { results.hidden = true; };
  bindThumbs(results);
}
let searchTimer;
searchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => doSearch(searchInput.value), 450); });
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { clearTimeout(searchTimer); doSearch(searchInput.value); }
  if (e.key === 'Escape') { results.hidden = true; searchInput.blur(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t?.isContentEditable) return;
  if (document.querySelector('dialog[open]')) return;
  e.preventDefault();
  searchInput.focus();
  searchInput.select();
});

// ---------- testovací priečinok (len vo vývoji: ?demo) ----------
async function loadDemo() {
  $('#status').textContent = 'Pripravujem testovací priečinok…';
  const list = await (await fetch('/dev-fixtures/manifest.json')).json();
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry('demo-photos', { recursive: true }); } catch { /* nebol */ }
  const dir = await root.getDirectoryHandle('demo-photos', { create: true });
  for (const rel of list) {
    const parts = rel.split('/');
    let d = dir;
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
    const blob = await (await fetch('/dev-fixtures/' + rel)).blob();
    const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
    await w.write(blob);
    await w.close();
  }
  await setSource(dir);
}
if (DEMO) {
  $('#demo-row').hidden = false;
  $('#btn-demo').onclick = loadDemo;
  window.__S = S;
}

// ---------- štart ----------
(async function init() {
  S.settings = await loadSettings();
  resetCards();
  setButtons();
  if (!supported) {
    $('#subtitle').innerHTML = '<span class="err">Tento prehliadač nepodporuje prístup k priečinkom (File System Access API). Použi Chrome alebo Edge na počítači (Windows / macOS) cez HTTPS alebo localhost.</span>';
    return;
  }
  const last = DEMO ? null : await kvGet('lastSource').catch(() => null);
  if (last) {
    const row = $('#resume-row');
    row.hidden = false;
    row.innerHTML = `<button class="secondary" id="btn-resume">↻ Pokračovať s priečinkom „${esc(last.name)}“</button><span class="muted small">Už spracované fotky sa načítajú z cache.</span>`;
    $('#btn-resume').onclick = async () => {
      try {
        let perm = await last.queryPermission({ mode: 'read' });
        if (perm !== 'granted') perm = await last.requestPermission({ mode: 'read' });
        if (perm !== 'granted') { toast('Bez povolenia sa priečinok nedá čítať.'); return; }
        await setSource(last);
        startSort();
      } catch (err) {
        toast('Priečinok už nie je dostupný: ' + err.message);
        row.hidden = true;
      }
    };
  }
})();
