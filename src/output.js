// Plán výstupu (dry run) a zápis do nového priečinka. Predvolene kopíruje, originály nemaže.
import { DUPES_FOLDER } from './settings.js';
import { cameraOf } from './camera.js';

const pad = (n) => String(n).padStart(2, '0');
export const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const safe = (s) => s.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+$/g, '').replace(/^\.+/, '_') || '_';

/** Zoskupí fotky do eventov podľa časových medzier. Vráti Map(rec -> názov priečinka RRRR-MM-DD). */
export function groupEvents(recs, gapHours) {
  const sorted = [...recs].sort((a, b) => a.date - b.date);
  const gap = gapHours * 3600_000;
  const out = new Map();
  const used = new Map();
  let current = null, last = -Infinity;
  for (const r of sorted) {
    if (!current || r.date - last > gap) {
      const base = ymd(r.date);
      const n = (used.get(base) || 0) + 1;
      used.set(base, n);
      current = n === 1 ? base : `${base} (${n})`;
    }
    out.set(r, current);
    last = r.date;
  }
  return out;
}

/**
 * @param {any[]} recs – záznamy s .cat, .date, .size, .name
 * @param {Set<any>} dupeSet – záznamy označené ako duplikát (nie „najlepšia“ verzia)
 */
export function buildPlan(recs, dupeSet, settings) {
  const { layout, dupes, eventGapHours } = settings;
  const included = [], dupList = [];
  for (const r of recs) {
    if (dupeSet.has(r) && dupes !== 'keep') { if (dupes === 'folder') dupList.push(r); }
    else included.push(r);
  }

  const eventOf = new Map();
  if (layout === 'date') {
    for (const [r, f] of groupEvents(included, eventGapHours)) eventOf.set(r, f);
  } else if (layout === 'cat-date') {
    const byCat = new Map();
    for (const r of included) {
      if (!byCat.has(r.cat.name)) byCat.set(r.cat.name, []);
      byCat.get(r.cat.name).push(r);
    }
    for (const list of byCat.values()) for (const [r, f] of groupEvents(list, eventGapHours)) eventOf.set(r, f);
  }

  const ops = [];
  const names = new Map(); // dirKey -> Set(lowercase names)
  const tree = new Map(); // dirKey -> {dir, count, bytes, recs}
  const push = (rec, dir) => {
    const dirKey = dir.join('/');
    let set = names.get(dirKey);
    if (!set) names.set(dirKey, (set = new Set()));
    let name = rec.name;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 1; set.has(name.toLowerCase()); i++) name = `${stem} (${i})${ext}`;
    set.add(name.toLowerCase());
    ops.push({ rec, dir, name });
    let t = tree.get(dirKey);
    if (!t) tree.set(dirKey, (t = { dir, count: 0, bytes: 0, recs: [] }));
    t.count++;
    t.bytes += rec.size;
    t.recs.push(rec);
  };

  for (const r of included) {
    const c = safe(r.cat.name);
    const dir = layout === 'cat' ? [c]
      : layout === 'date' ? [eventOf.get(r)]
        : layout === 'cam' ? [safe(cameraOf(r).name)]
          : [c, eventOf.get(r)];
    push(r, dir);
  }
  for (const r of dupList) push(r, [DUPES_FOLDER]);

  const folders = [...tree.values()].sort((a, b) => a.dir.join('/').localeCompare(b.dir.join('/'), 'sk'));
  return { ops, folders, totalBytes: ops.reduce((s, o) => s + o.rec.size, 0) };
}

async function exists(dir, name) {
  try { await dir.getFileHandle(name); return true; } catch { return false; }
}

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

/**
 * Zapíše plán do výstupného priečinka.
 * @param {{ops:any[]}} plan
 * @param {FileSystemDirectoryHandle} outRoot
 * @param {{mode:'copy'|'move', onProgress:(done:number,total:number,bytes:number)=>void, isCancelled:()=>boolean}} o
 */
export async function writePlan(plan, outRoot, { mode, onProgress, isCancelled }) {
  const dirCache = new Map();
  const getDir = async (parts) => {
    const key = parts.join('/');
    if (dirCache.has(key)) return dirCache.get(key);
    const p = (async () => {
      let d = outRoot;
      for (const part of parts) d = await d.getDirectoryHandle(part, { create: true });
      return d;
    })();
    dirCache.set(key, p);
    return p;
  };

  const report = [['povodna_cesta', 'nova_cesta', 'kategoria', 'datum', 'zdroj_datumu', 'duplikat', 'velkost_B', 'stav'].join(';')];
  const errors = [];
  let done = 0, bytes = 0, i = 0;
  const total = plan.ops.length;

  const worker = async () => {
    while (i < total) {
      if (isCancelled?.()) return;
      const op = plan.ops[i++];
      let state = mode === 'move' ? 'presunuté' : 'skopírované';
      let finalName = op.name;
      try {
        const dir = await getDir(op.dir);
        // nikdy neprepíš existujúci súbor vo výstupe
        const dot = op.name.lastIndexOf('.');
        const stem = dot > 0 ? op.name.slice(0, dot) : op.name, ext = dot > 0 ? op.name.slice(dot) : '';
        for (let n = 1; await exists(dir, finalName); n++) finalName = `${stem} (${n})${ext}`;
        const src = await op.rec.handle.getFile();
        const fh = await dir.getFileHandle(finalName, { create: true });
        const w = await fh.createWritable();
        await src.stream().pipeTo(w);
        if (mode === 'move') {
          const written = await fh.getFile();
          if (written.size !== src.size) throw new Error('Veľkosť kópie nesedí – originál ponechaný');
          await op.rec.parent.removeEntry(op.rec.name);
        }
        bytes += src.size;
      } catch (err) {
        state = 'chyba: ' + (err?.message || err);
        errors.push({ op, error: String(err?.message || err) });
      }
      report.push([op.rec.path, [...op.dir, finalName].join('/'), op.rec.cat.name, new Date(op.rec.date).toISOString(), op.rec.dateSource, op.rec.dupeOf ? 'áno' : '', op.rec.size, state].map(csvCell).join(';'));
      done++;
      onProgress?.(done, total, bytes);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);

  try {
    const fh = await outRoot.getFileHandle(`photo-sorter-report-${ymd(Date.now())}-${Date.now() % 100000}.csv`, { create: true });
    const w = await fh.createWritable();
    await w.write(new Blob(['﻿' + report.join('\r\n')], { type: 'text/csv' }));
    await w.close();
  } catch { /* report je len bonus */ }

  return { done, bytes, errors };
}
