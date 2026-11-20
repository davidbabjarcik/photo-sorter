// Zero-shot klasifikácia cez CLIP + heuristiky pre screenshoty + určenie dátumu.
import { FALLBACK_CATEGORY } from './settings.js';

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

const SCREENS = [
  [1170, 2532], [1179, 2556], [1284, 2778], [1290, 2796], [1206, 2622], [1320, 2868], [1125, 2436], [1242, 2688],
  [828, 1792], [750, 1334], [1242, 2208], [640, 1136], [1080, 1920], [1080, 2340], [1080, 2400], [1080, 2412],
  [1080, 2460], [1440, 3200], [1440, 3088], [1440, 3120], [1440, 2960], [720, 1600], [720, 1280], [1920, 1080],
  [2560, 1440], [1366, 768], [1440, 900], [2880, 1800], [3024, 1964], [3456, 2234], [2560, 1600], [1280, 800],
  [1536, 864], [3840, 2160], [1600, 900], [1680, 1050], [1920, 1200], [2048, 1536], [1668, 2388], [2732, 2048],
  [1620, 2160], [2360, 1640], [2940, 1912], [3420, 2224], [2880, 1864], [2256, 1504], [2496, 1664], [2736, 1824],
];
const SCREEN_SET = new Set(SCREENS.flatMap(([w, h]) => [`${w}x${h}`, `${h}x${w}`]));

const SHOT_NAME = /screenshot|screen[ _-]?shot|sn[ií]mka obrazovky|sn[ií]mek obrazovky|bildschirmfoto|capture d.?[ée]cran|captura de pantalla|^scr[_-]|^screen[_-]/i;

/** Heuristické skóre „je to screenshot?“ (≥ 0.7 = takmer isto, < 0 = takmer isto nie). */
export function screenshotScore(rec) {
  let s = 0;
  if (SHOT_NAME.test(rec.name)) s += 0.7;
  if (rec.ext === 'png') s += 0.25;
  if (rec.make || rec.model) s -= 0.6;
  else s += 0.2;
  if (SCREEN_SET.has(`${rec.width}x${rec.height}`)) s += 0.3;
  if (rec.flat > 0.55) s += 0.15;
  return s;
}

/**
 * @param {Float32Array} emb
 * @param {{cat:any, embs:Float32Array[]}[]} catEmbs
 */
export function categoryScores(emb, catEmbs) {
  const logits = catEmbs.map(({ embs }) => {
    let m = -1;
    for (const e of embs) m = Math.max(m, dot(emb, e));
    return m * 100;
  });
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return catEmbs.map(({ cat }, i) => ({ cat, p: exps[i] / sum }));
}

export function classify(rec, catEmbs, settings) {
  const shotCat = catEmbs.find((c) => c.cat.screenshot)?.cat;
  const heur = settings.screenshotHeuristics ? screenshotScore(rec) : 0;
  if (shotCat && heur >= 0.7) return { cat: shotCat, p: 1, reason: 'heuristika' };
  if (!rec.emb || !catEmbs.length) return { cat: FALLBACK_CATEGORY, p: 0, reason: 'bez AI' };

  const scores = categoryScores(rec.emb, catEmbs).sort((a, b) => b.p - a.p);
  let best = scores[0];
  // Foto s EXIF z fotoaparátu nebude screenshot, aj keby CLIP tipoval.
  if (best.cat.screenshot && heur < 0 && scores[1]) best = scores[1];
  if (best.p < settings.minConfidence) return { cat: FALLBACK_CATEGORY, p: best.p, reason: 'nízka istota' };
  return { cat: best.cat, p: best.p, reason: 'CLIP' };
}

const NAME_DATE = /(?:^|[^0-9])((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[ _T-]?([01]\d|2[0-3])[-_.:]?([0-5]\d)[-_.:]?([0-5]\d))?/;

export function dateFromName(name) {
  const m = name.match(NAME_DATE);
  if (!m) return null;
  const [, y, mo, d, h = '12', mi = '00', s = '00'] = m;
  const t = new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
  return t > new Date(1995, 0, 1).getTime() && t < Date.now() + 864e5 ? t : null;
}

/** Dátum: EXIF DateTimeOriginal → dátum v názve súboru → dátum zmeny súboru. */
export function resolveDate(rec) {
  if (rec.exifDate) return { date: rec.exifDate, dateSource: 'EXIF' };
  const n = dateFromName(rec.name);
  if (n) return { date: n, dateSource: 'názov' };
  return { date: rec.mtime, dateSource: 'zmena súboru' };
}
