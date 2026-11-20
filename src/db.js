// IndexedDB: výsledky analýzy fotiek (hash, EXIF, náhľad, embedding), cache textových embeddingov, nastavenia.
import { openDB } from 'idb';

const dbp = openDB('photo-sorter', 1, {
  upgrade(db) {
    db.createObjectStore('photos', { keyPath: 'key' });
    db.createObjectStore('textemb');
    db.createObjectStore('kv');
  },
});

export async function getPhotos(keys) {
  const db = await dbp;
  const tx = db.transaction('photos');
  const out = await Promise.all(keys.map((k) => tx.store.get(k)));
  await tx.done;
  return out;
}

export async function putPhotos(recs) {
  if (!recs.length) return;
  const db = await dbp;
  const tx = db.transaction('photos', 'readwrite');
  for (const r of recs) tx.store.put(r);
  await tx.done;
}

export async function countPhotos() {
  return (await dbp).count('photos');
}

export async function clearPhotos() {
  const db = await dbp;
  await db.clear('photos');
  await db.clear('textemb');
}

export async function getTextEmb(key) {
  return (await dbp).get('textemb', key);
}
export async function setTextEmb(key, val) {
  return (await dbp).put('textemb', val, key);
}

export async function kvGet(key) {
  return (await dbp).get('kv', key);
}
export async function kvSet(key, val) {
  return (await dbp).put('kv', val, key);
}
export async function kvDel(key) {
  return (await dbp).delete('kv', key);
}
