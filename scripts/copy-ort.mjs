// Skopíruje ONNX Runtime WASM súbory do public/ort, aby appka nepotrebovala CDN a fungovala offline.
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const src = 'node_modules/onnxruntime-web/dist';
const dst = 'public/ort';
mkdirSync(dst, { recursive: true });
for (const f of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
  const from = join(src, f);
  if (!existsSync(from)) throw new Error(`Chýba ${from}`);
  copyFileSync(from, join(dst, f));
}
console.log('ORT súbory skopírované do public/ort');
