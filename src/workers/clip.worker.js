// CLIP (transformers.js): embeddingy obrázkov a textov. WebGPU, pri chybe fallback na WASM.
import {
  env, AutoProcessor, AutoTokenizer, CLIPVisionModelWithProjection, CLIPTextModelWithProjection, RawImage,
} from '@huggingface/transformers';

env.allowLocalModels = false;
env.useBrowserCache = true;

let processor, tokenizer, vision, text;

function halfToFloat(h) {
  const s = (h & 0x8000) >> 15, e = (h & 0x7c00) >> 10, f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * 2 ** -14 * (f / 1024);
  if (e === 0x1f) return f ? NaN : (s ? -Infinity : Infinity);
  return (s ? -1 : 1) * 2 ** (e - 15) * (1 + f / 1024);
}

// Tensor [n, d] -> pole L2-normalizovaných Float32Array
function rows(tensor) {
  const [n, d] = tensor.dims;
  let data = tensor.data;
  if (!(data instanceof Float32Array)) {
    const isNativeF16 = globalThis.Float16Array && data instanceof globalThis.Float16Array;
    data = data instanceof Uint16Array && !isNativeF16 ? Float32Array.from(data, halfToFloat) : Float32Array.from(data);
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = data.slice(i * d, (i + 1) * d);
    let norm = 0;
    for (let j = 0; j < d; j++) norm += v[j] * v[j];
    norm = Math.sqrt(norm) || 1;
    for (let j = 0; j < d; j++) v[j] /= norm;
    out.push(v);
  }
  return out;
}

async function pickDevice() {
  try {
    if (!navigator.gpu) return { device: 'wasm', dtype: 'q8' };
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { device: 'wasm', dtype: 'q8' };
    return { device: 'webgpu', dtype: adapter.features.has('shader-f16') ? 'fp16' : 'fp32' };
  } catch {
    return { device: 'wasm', dtype: 'q8' };
  }
}

async function load({ model, ortBase, forceWasm }) {
  if (ortBase) {
    env.backends.onnx.wasm.wasmPaths = {
      mjs: ortBase + 'ort-wasm-simd-threaded.asyncify.mjs',
      wasm: ortBase + 'ort-wasm-simd-threaded.asyncify.wasm',
    };
  }
  const progress_callback = (p) => {
    if (p.status === 'progress' || p.status === 'done') {
      self.postMessage({ type: 'load-progress', file: p.file, loaded: p.loaded, total: p.total, status: p.status });
    }
  };
  const choice = forceWasm ? { device: 'wasm', dtype: 'q8' } : await pickDevice();
  const tryLoad = async ({ device, dtype }) => {
    const opts = { device, dtype, progress_callback };
    [processor, tokenizer, vision, text] = await Promise.all([
      AutoProcessor.from_pretrained(model),
      AutoTokenizer.from_pretrained(model),
      CLIPVisionModelWithProjection.from_pretrained(model, opts),
      CLIPTextModelWithProjection.from_pretrained(model, opts),
    ]);
    // Skúšobný beh – overí, že backend naozaj funguje.
    const t = await tokenizer(['a photo'], { padding: true, truncation: true });
    await text(t);
    return { device, dtype };
  };
  try {
    return await tryLoad(choice);
  } catch (err) {
    if (choice.device !== 'webgpu') throw err;
    self.postMessage({ type: 'log', msg: 'WebGPU zlyhalo, prepínam na WASM: ' + (err?.message || err) });
    return await tryLoad({ device: 'wasm', dtype: 'q8' });
  }
}

async function embedImages(blobs) {
  const images = await Promise.all(blobs.map((b) => RawImage.fromBlob(b)));
  const inputs = await processor(images);
  const { image_embeds } = await vision(inputs);
  return rows(image_embeds);
}

async function embedTexts(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += 32) {
    const t = await tokenizer(texts.slice(i, i + 32), { padding: true, truncation: true });
    const { text_embeds } = await text(t);
    out.push(...rows(text_embeds));
  }
  return out;
}

self.onmessage = async (e) => {
  const { id, type, payload } = e.data;
  try {
    let res;
    if (type === 'init') res = await load(payload);
    else if (type === 'images') res = await embedImages(payload.blobs);
    else if (type === 'texts') res = await embedTexts(payload.texts);
    else throw new Error('Neznámy typ správy: ' + type);
    self.postMessage({ id, ok: true, res });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
