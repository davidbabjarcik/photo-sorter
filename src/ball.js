// Rotujúca guľa z náhľadov (canvas). Fotky sa do nej pridávajú a odlietajú z nej do kariet priečinkov.
const N = 150;

function fibonacciSphere(n) {
  const pts = [];
  const phi = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const t = phi * i;
    pts.push({ x: Math.cos(t) * r, y, z: Math.sin(t) * r });
  }
  return pts;
}

export class Ball {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.slots = fibonacciSphere(N).map((p, i) => ({ ...p, img: null, hue: (i * 47) % 360, sx: 0, sy: 0, ss: 0, depth: 0 }));
    this.rot = 0;
    this.speed = 0.0018;
    this.fill = 0;
    this.running = true;
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
    const loop = () => { if (this.running) this.draw(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = this.canvas.getBoundingClientRect();
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setBusy(b) { this.speed = b ? 0.006 : 0.0018; }

  /** Pridá obrázok (ImageBitmap) do voľného alebo najstaršieho slotu. */
  add(img) {
    const empty = this.slots.filter((s) => !s.img);
    const slot = empty.length ? empty[(Math.random() * empty.length) | 0] : this.slots[(this.fill++) % N];
    slot.img?.close?.();
    slot.img = img;
  }

  clear() {
    for (const s of this.slots) { s.img?.close?.(); s.img = null; }
  }

  /** Vyberie viditeľný slot s obrázkom; vráti jeho pozíciu na obrazovke (pre animáciu odletu). */
  takeOut() {
    const front = this.slots.filter((s) => s.img && s.depth > 0.15);
    if (!front.length) return null;
    const s = front[(Math.random() * front.length) | 0];
    const rect = this.canvas.getBoundingClientRect();
    const out = { x: rect.left + s.sx, y: rect.top + s.sy, size: s.ss };
    // fotka „odletí“ – slot sa uvoľní a zaplní ho ďalšia fotka z fronty
    if (this.slots.filter((x) => x.img).length > 40) { s.img.close?.(); s.img = null; }
    return out;
  }

  draw() {
    const { ctx, w, h } = this;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);
    this.rot += this.speed;
    const R = Math.min(w, h) * 0.38;
    const cx = w / 2, cy = h / 2;
    const cr = Math.cos(this.rot), sr = Math.sin(this.rot);
    const tilt = 0.35, ct = Math.cos(tilt), st = Math.sin(tilt);
    const base = R * 0.27;
    for (const s of this.slots) {
      const x = s.x * cr - s.z * sr;
      const z1 = s.x * sr + s.z * cr;
      const y = s.y * ct - z1 * st;
      const z = s.y * st + z1 * ct;
      const persp = 1.6 / (2.4 - z);
      s.sx = cx + x * R * persp * 1.15;
      s.sy = cy + y * R * persp * 1.15;
      s.ss = base * persp;
      s.depth = z;
    }
    const sorted = [...this.slots].sort((a, b) => a.depth - b.depth);
    if (!this.tile || (this.frame = (this.frame || 0) + 1) % 30 === 0) {
      this.tile = getComputedStyle(this.canvas).getPropertyValue('--tile').trim() || '#333';
    }
    const tile = this.tile;
    for (const s of sorted) {
      const a = 0.25 + 0.75 * ((s.depth + 1) / 2);
      const size = s.ss;
      const x = s.sx - size / 2, y = s.sy - size / 2;
      ctx.globalAlpha = a;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x, y, size, size, size * 0.18);
      ctx.clip();
      if (s.img) {
        const iw = s.img.width, ih = s.img.height, m = Math.min(iw, ih);
        ctx.drawImage(s.img, (iw - m) / 2, (ih - m) / 2, m, m, x, y, size, size);
      } else {
        ctx.fillStyle = tile;
        ctx.fillRect(x, y, size, size);
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }
}
