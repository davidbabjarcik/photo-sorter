// Duplikáty: presné (SHA-256) a takmer rovnaké (dHash + CLIP podobnosť fotiek blízko v čase).
import { dot } from './classify.js';

class UnionFind {
  constructor(n) { this.p = Int32Array.from({ length: n }, (_, i) => i); }
  find(x) { while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x]; } return x; }
  union(a, b) { a = this.find(a); b = this.find(b); if (a !== b) this.p[b] = a; }
}

const POP = new Uint8Array(256).map((_, i) => { let c = 0, x = i; while (x) { c += x & 1; x >>= 1; } return c; });
function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < 16; i += 2) d += POP[parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16)];
  return d;
}

/** Kvalita na výber „najlepšej“ verzie: rozlíšenie, potom veľkosť súboru, potom EXIF. */
function quality(r) {
  return (r.width || 0) * (r.height || 0) * 1e3 + Math.min(r.size, 1e9) / 1e6 + (r.exifDate ? 0.5 : 0);
}

/**
 * @param {any[]} recs – záznamy s sha256, dhash, emb, date, size
 * @returns {{groups:{keep:any, dupes:any[], exact:boolean}[], savedBytes:number, dupeCount:number}}
 */
export function findDuplicates(recs, { nearDupHamming = 5, nearDupClip = 0.965 } = {}) {
  const n = recs.length;
  const uf = new UnionFind(n);

  // 1) presné kópie
  const bySha = new Map();
  recs.forEach((r, i) => {
    if (!r.sha256) return;
    const j = bySha.get(r.sha256);
    if (j === undefined) bySha.set(r.sha256, i);
    else uf.union(j, i);
  });

  // 2) dHash – LSH cez 8 pásiem po 8 bitoch (pri vzdialenosti ≤ 7 sa vždy zhodne aspoň jedno pásmo)
  if (nearDupHamming > 0) {
    const buckets = new Map();
    recs.forEach((r, i) => {
      if (!r.dhash || r.dhash === '0000000000000000' || r.dhash === 'ffffffffffffffff') return;
      for (let b = 0; b < 8; b++) {
        const k = b + ':' + r.dhash.slice(b * 2, b * 2 + 2);
        let arr = buckets.get(k);
        if (!arr) buckets.set(k, (arr = []));
        arr.push(i);
      }
    });
    for (const arr of buckets.values()) {
      if (arr.length < 2 || arr.length > 400) continue;
      for (let x = 0; x < arr.length; x++) {
        for (let y = x + 1; y < arr.length; y++) {
          const a = recs[arr[x]], b = recs[arr[y]];
          if (uf.find(arr[x]) === uf.find(arr[y])) continue;
          if (hamming(a.dhash, b.dhash) > nearDupHamming) continue;
          // poistka proti falošným zhodám (napr. dve čierne fotky): ak máme CLIP, musí súhlasiť
          if (a.emb && b.emb && dot(a.emb, b.emb) < 0.9) continue;
          uf.union(arr[x], arr[y]);
        }
      }
    }
  }

  // 3) CLIP – sériové fotky odfotené tesne po sebe (do 30 s)
  if (nearDupClip < 1) {
    const order = recs.map((_, i) => i).filter((i) => recs[i].emb).sort((a, b) => recs[a].date - recs[b].date);
    for (let x = 0; x < order.length; x++) {
      const a = recs[order[x]];
      for (let y = x + 1; y < Math.min(order.length, x + 12); y++) {
        const b = recs[order[y]];
        if (b.date - a.date > 30_000) break;
        if (dot(a.emb, b.emb) >= nearDupClip) uf.union(order[x], order[y]);
      }
    }
  }

  const groupsMap = new Map();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    let g = groupsMap.get(root);
    if (!g) groupsMap.set(root, (g = []));
    g.push(i);
  }

  const groups = [];
  let savedBytes = 0, dupeCount = 0;
  for (const idx of groupsMap.values()) {
    if (idx.length < 2) continue;
    const members = idx.map((i) => recs[i]).sort((a, b) => quality(b) - quality(a));
    const [keep, ...dupes] = members;
    const exact = dupes.every((d) => d.sha256 === keep.sha256);
    groups.push({ keep, dupes, exact });
    for (const d of dupes) { savedBytes += d.size; dupeCount++; }
  }
  groups.sort((a, b) => b.dupes.length - a.dupes.length);
  return { groups, savedBytes, dupeCount };
}
