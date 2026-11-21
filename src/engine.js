// Orchestrácia: pool Web Workerov na analýzu, CLIP worker, cache v IndexedDB, pauza/pokračovanie.
import { getPhotos, putPhotos, getTextEmb, setTextEmb } from './db.js';
import { extOf } from './scan.js';
import { MODEL_ID, activeCategories } from './settings.js';
import { classify, resolveDate } from './classify.js';

const STORED = ['key', 'path', 'name', 'ext', 'size', 'mtime', 'sha256', 'dhash', 'flat', 'width', 'height', 'thumb',
  'exifDate', 'make', 'model', 'software', 'lens', 'emb', 'error'];
const toStored = (r) => Object.fromEntries(STORED.map((k) => [k, r[k] ?? null]));

class Pool {
  constructor(factory, size) {
    this.workers = Array.from({ length: size }, factory);
    this.idle = [...this.workers];
    this.waiting = [];
    this.seq = 0;
  }
  run(job) {
    return new Promise((resolve, reject) => {
      const go = (w) => {
        const id = ++this.seq;
        const onMsg = (e) => {
          if (e.data.id !== id) return;
          w.removeEventListener('message', onMsg);
          this.release(w);
          e.data.ok ? resolve(e.data.res) : reject(new Error(e.data.error));
        };
        w.addEventListener('message', onMsg);
        w.postMessage({ id, job });
      };
      const w = this.idle.pop();
      w ? go(w) : this.waiting.push(go);
    });
  }
  release(w) {
    const next = this.waiting.shift();
    next ? next(w) : this.idle.push(w);
  }
  terminate() { this.workers.forEach((w) => w.terminate()); }
}

class Clip {
  constructor(onEvent) {
    this.worker = new Worker(new URL('./workers/clip.worker.js', import.meta.url), { type: 'module' });
    this.seq = 0;
    this.pending = new Map();
    this.worker.onmessage = (e) => {
      const d = e.data;
      if (d.type) return onEvent(d);
      const p = this.pending.get(d.id);
      if (!p) return;
      this.pending.delete(d.id);
      d.ok ? p.resolve(d.res) : p.reject(new Error(d.error));
    };
  }
  call(type, payload) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload });
    });
  }
}

let clipSingleton = null;
let clipReady = null;
let clipInfo = null;
const clipListeners = new Set();

/** Načíta CLIP raz pre celú appku (triedenie aj vyhľadávanie). */
export function ensureClip(settings) {
  if (!clipReady) {
    clipSingleton = new Clip((ev) => clipListeners.forEach((fn) => fn(ev)));
    const ortBase = new URL('ort/', document.baseURI).href;
    clipReady = clipSingleton.call('init', { model: MODEL_ID, ortBase, forceWasm: !!settings.forceWasm })
      .then((info) => (clipInfo = info))
      .catch((err) => { clipReady = null; throw err; });
  }
  return clipReady;
}
export const onClipEvent = (fn) => { clipListeners.add(fn); return () => clipListeners.delete(fn); };
export const getClipInfo = () => clipInfo;

export async function embedTexts(texts, settings) {
  await ensureClip(settings);
  const out = new Array(texts.length);
  const missing = [];
  await Promise.all(texts.map(async (t, i) => {
    const v = await getTextEmb(MODEL_ID + '|' + t);
    if (v) out[i] = v; else missing.push(i);
  }));
  if (missing.length) {
    const embs = await clipSingleton.call('texts', { texts: missing.map((i) => texts[i]) });
    await Promise.all(missing.map((i, j) => { out[i] = embs[j]; return setTextEmb(MODEL_ID + '|' + texts[i], embs[j]); }));
  }
  return out;
}

export async function categoryEmbeddings(settings) {
  const cats = activeCategories(settings);
  const prompts = [...new Set(cats.flatMap((c) => c.prompts))];
  const embs = await embedTexts(prompts, settings);
  const map = new Map(prompts.map((p, i) => [p, embs[i]]));
  return cats.map((cat) => ({ cat, embs: cat.prompts.map((p) => map.get(p)) }));
}

export class Engine {
  /**
   * @param {{settings:any, onItem:(rec:any)=>void, onAnalyzed:(rec:any)=>void, onStatus:(s:string)=>void, onLog:(s:string)=>void}} o
   */
  constructor(o) {
    Object.assign(this, o);
    this.paused = false;
    this.cancelled = false;
    this.resumeFn = null;
    this.records = [];
    this.done = 0;
    this.elapsed = 0;
    this.aiError = null;
    const n = Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 2)));
    this.pool = new Pool(() => new Worker(new URL('./workers/process.worker.js', import.meta.url), { type: 'module' }), n);
  }

  pause() { this.paused = true; this.tickStop(); }
  resume() {
    this.paused = false;
    this.tickStart();
    const fn = this.resumeFn; this.resumeFn = null; fn?.();
  }
  cancel() { this.cancelled = true; this.resume(); }
  async gate() {
    if (this.paused) await new Promise((r) => (this.resumeFn = r));
  }
  tickStart() { this.t0 = performance.now(); }
  tickStop() { if (this.t0) { this.elapsed += performance.now() - this.t0; this.t0 = null; } }
  get seconds() { return (this.elapsed + (this.t0 ? performance.now() - this.t0 : 0)) / 1000; }

  async analyzeEntry(entry) {
    const ext = extOf(entry.name);
    let file;
    try {
      file = await entry.handle.getFile();
    } catch (err) {
      this.onLog?.(`Súbor sa nedá prečítať ${entry.path}: ${err.message}`);
      return { key: entry.path + '|?', path: entry.path, name: entry.name, ext, size: 0, mtime: Date.now(), error: err.message, unreadable: true };
    }
    const key = `${entry.path}|${file.size}|${file.lastModified}`;
    const base = { key, path: entry.path, name: entry.name, ext, size: file.size, mtime: file.lastModified };
    try {
      const res = await this.pool.run({ file, ext, thumbSize: 256 });
      return { ...base, ...res, emb: null, error: null, fresh: true };
    } catch (err) {
      this.onLog?.(`Nepodarilo sa spracovať ${entry.path}: ${err.message}`);
      return { ...base, error: err.message, fresh: true };
    }
  }

  /** @param {{name:string,path:string,handle:FileSystemFileHandle,parent:FileSystemDirectoryHandle}[]} entries */
  async run(entries) {
    const { settings } = this;
    this.total = entries.length;
    this.tickStart();

    // CLIP sa načítava paralelne s analýzou súborov.
    let catEmbs = [];
    const aiPromise = ensureClip(settings)
      .then(() => categoryEmbeddings(settings))
      .then((c) => { catEmbs = c; })
      .catch((err) => { this.aiError = err; this.onLog?.('AI model sa nepodarilo načítať: ' + err.message); });

    const queue = [];
    let producerDone = false;
    let wakeConsumer = null;
    let wakeProducer = null;
    const notify = () => { const f = wakeConsumer; wakeConsumer = null; f?.(); };

    const CHUNK = 32;
    const producer = (async () => {
      for (let i = 0; i < entries.length && !this.cancelled; i += CHUNK) {
        await this.gate();
        while (queue.length > 512 && !this.cancelled) await new Promise((r) => (wakeProducer = r));
        const chunk = entries.slice(i, i + CHUNK);
        const files = await Promise.all(chunk.map(async (e) => {
          try { return await e.handle.getFile(); } catch { return null; }
        }));
        const keys = chunk.map((e, j) => (files[j] ? `${e.path}|${files[j].size}|${files[j].lastModified}` : '-'));
        const cached = await getPhotos(keys);
        const recs = await Promise.all(chunk.map((e, j) => (cached[j] && !cached[j].error ? cached[j] : this.analyzeEntry(e))));
        const fresh = recs.filter((r) => r.fresh);
        await putPhotos(fresh.map(toStored));
        recs.forEach((r, j) => {
          r.handle = chunk[j].handle;
          r.parent = chunk[j].parent;
          Object.assign(r, resolveDate(r));
          this.onAnalyzed?.(r);
          queue.push(r);
        });
        notify();
      }
      producerDone = true;
      notify();
    })();

    const consumer = (async () => {
      await aiPromise;
      const B = Math.max(1, settings.batchSize || 8);
      while (!this.cancelled) {
        await this.gate();
        if (!queue.length) {
          if (producerDone) break;
          await new Promise((r) => (wakeConsumer = r));
          continue;
        }
        const batch = queue.splice(0, B);
        const w = wakeProducer; wakeProducer = null; w?.();
        const need = this.aiError ? [] : batch.filter((r) => !r.emb && r.thumb);
        if (need.length) {
          try {
            const embs = await clipSingleton.call('images', { blobs: need.map((r) => r.thumb) });
            need.forEach((r, j) => (r.emb = embs[j]));
            await putPhotos(need.map(toStored));
          } catch (err) {
            this.onLog?.('CLIP chyba: ' + err.message);
          }
        }
        for (const r of batch) {
          const c = classify(r, catEmbs, settings);
          r.cat = c.cat; r.p = c.p; r.reason = c.reason;
          this.records.push(r);
          this.done++;
          this.onItem?.(r);
        }
      }
    })();

    await Promise.all([producer, consumer]);
    this.tickStop();
    this.pool.terminate();
    return this.records;
  }
}

/** Preklasifikuje už spracované záznamy (napr. po zmene kategórií v nastaveniach). */
export async function reclassify(records, settings) {
  const catEmbs = await categoryEmbeddings(settings);
  for (const r of records) {
    const c = classify(r, catEmbs, settings);
    r.cat = c.cat; r.p = c.p; r.reason = c.reason;
  }
}
