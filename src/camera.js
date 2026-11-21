// Čím bolo fotené: zariadenie z EXIF (Make/Model), objektív, inak odhad podľa názvu súboru.
import { screenshotScore } from './classify.js';

const BRANDS = {
  apple: 'Apple', samsung: 'Samsung', google: 'Google', xiaomi: 'Xiaomi', redmi: 'Xiaomi', poco: 'Xiaomi', huawei: 'Huawei',
  honor: 'Honor', oneplus: 'OnePlus', oppo: 'OPPO', vivo: 'vivo', realme: 'realme', motorola: 'Motorola', nokia: 'Nokia',
  hmd: 'Nokia', sony: 'Sony', canon: 'Canon', nikon: 'Nikon', fujifilm: 'Fujifilm', olympus: 'Olympus', 'om digital solutions': 'OM System',
  panasonic: 'Panasonic', leica: 'Leica', ricoh: 'Ricoh', pentax: 'Pentax', sigma: 'Sigma', hasselblad: 'Hasselblad', dji: 'DJI',
  gopro: 'GoPro', insta360: 'Insta360', 'arashi vision': 'Insta360', lg: 'LG', 'lg electronics': 'LG', asus: 'ASUS', nothing: 'Nothing',
  fairphone: 'Fairphone', microsoft: 'Microsoft', kodak: 'Kodak', 'eastman kodak company': 'Kodak', casio: 'Casio',
};
const PHONE_BRANDS = new Set(['Apple', 'Samsung', 'Google', 'Xiaomi', 'Huawei', 'Honor', 'OnePlus', 'OPPO', 'vivo', 'realme', 'Motorola', 'Nokia', 'LG', 'ASUS', 'Nothing', 'Fairphone']);
const ACTION_BRANDS = new Set(['GoPro', 'Insta360']);

// Samsung zapisuje do EXIF len kód modelu – najčastejšie Galaxy modely.
const SAMSUNG = [
  [/^SM-S93[18]/, 'Galaxy S25'], [/^SM-S92[18]/, 'Galaxy S24'], [/^SM-S91[168]/, 'Galaxy S23'], [/^SM-S90[168]/, 'Galaxy S22'],
  [/^SM-G99[168]/, 'Galaxy S21'], [/^SM-G98[168]/, 'Galaxy S20'], [/^SM-G97[035]/, 'Galaxy S10'], [/^SM-G96[05]/, 'Galaxy S9'],
  [/^SM-A5[0-9]6/, 'Galaxy A5x'], [/^SM-A3[0-9]6/, 'Galaxy A3x'], [/^SM-A1[0-9]/, 'Galaxy A1x'], [/^SM-F9[0-9]/, 'Galaxy Z Fold'],
  [/^SM-F7[0-9]/, 'Galaxy Z Flip'], [/^SM-N9[0-9]/, 'Galaxy Note'],
];

const clean = (s) => String(s || '').replace(/\0/g, '').replace(/\s+/g, ' ').trim();

function brandOf(make) {
  const m = clean(make).toLowerCase().replace(/\b(corporation|corp\.?|company|co\.,? ?ltd\.?|ltd\.?|inc\.?|imaging|optical|electronics|technology)\b/g, '').replace(/[.,]/g, '').trim();
  if (!m) return '';
  if (BRANDS[m]) return BRANDS[m];
  const first = m.split(' ')[0];
  return BRANDS[first] || clean(make).split(' ')[0].replace(/^\w/, (c) => c.toUpperCase());
}

/** Názov zariadenia z EXIF, napr. „Apple iPhone 13“, „Canon EOS R6“, „Samsung Galaxy S23“. */
export function deviceName(r) {
  const brand = brandOf(r.make);
  let model = clean(r.model);
  if (!brand && !model) return null;
  if (!model) return brand;
  if (brand === 'Samsung') {
    const hit = SAMSUNG.find(([re]) => re.test(model));
    if (hit) model = hit[1];
  }
  // model často obsahuje značku („NIKON D750“, „Canon EOS R6“) – nechaj ju len raz a pekne napísanú
  const lower = model.toLowerCase();
  for (const b of [brand.toLowerCase(), clean(r.make).toLowerCase(), clean(r.make).toLowerCase().split(' ')[0]]) {
    if (b && lower.startsWith(b + ' ')) { model = model.slice(b.length + 1); break; }
  }
  return brand ? `${brand} ${model}` : model;
}

/**
 * Zariadenie alebo odhadnutý pôvod fotky.
 * @returns {{name:string, icon:string, known:boolean}}
 */
export function cameraOf(r) {
  const name = deviceName(r);
  if (name) {
    const brand = name.split(' ')[0];
    const icon = brand === 'DJI' ? '🚁' : ACTION_BRANDS.has(brand) ? '🎥' : PHONE_BRANDS.has(brand) ? '📱' : '📷';
    return { name, icon, known: true };
  }
  if (/-WA\d{4}|^WhatsApp/i.test(r.name)) return { name: 'WhatsApp (bez údajov o zariadení)', icon: '💬', known: false };
  if (/^(received_|FB_IMG|Messenger)/i.test(r.name)) return { name: 'Messenger / Facebook', icon: '💬', known: false };
  if (/^(signal-|telegram|photo_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})/i.test(r.name)) return { name: 'Signal / Telegram', icon: '💬', known: false };
  if (screenshotScore(r) >= 0.7) return { name: 'Screenshot', icon: '🖥️', known: false };
  if (r.software && /photoshop|lightroom|gimp|snapseed|capture one|affinity/i.test(r.software)) return { name: `Upravené v ${clean(r.software).split(/[ (]/)[0]}`, icon: '🎨', known: false };
  return { name: 'Neznáme zariadenie', icon: '❔', known: false };
}

/** Zoskupí záznamy podľa zariadenia, zoradené podľa počtu. */
export function groupByCamera(records) {
  const map = new Map();
  for (const r of records) {
    const c = cameraOf(r);
    let g = map.get(c.name);
    if (!g) map.set(c.name, (g = { ...c, recs: [], bytes: 0, lenses: new Map() }));
    g.recs.push(r);
    g.bytes += r.size || 0;
    if (r.lens) g.lenses.set(r.lens, (g.lenses.get(r.lens) || 0) + 1);
  }
  return [...map.values()].sort((a, b) => (b.known - a.known) || b.recs.length - a.recs.length);
}
