// The illustration beside the sign-in form: many EEG-like traces drawn across a dark field in warm
// and cool light, like a long exposure of a recording with many channels. It is drawn from a fixed
// seed, so it is the same every time, and drawn again only when its size changes.

const PALETTE = ['#FFC48A', '#FF8B1A', '#F4D35E', '#9ED9A6', '#3FB58A', '#4FA3E8', '#B9A7F2']; // top to bottom

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mix(a, b, f) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * f)).join(', ')})`;
}

function colourAt(f) {
  const s = Math.min(PALETTE.length - 1.0001, Math.max(0, f * (PALETTE.length - 1)));
  const i = Math.floor(s);
  return mix(PALETTE[i], PALETTE[i + 1], s - i);
}

function draw(canvas) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#121211';
  g.fillRect(0, 0, w, h);
  // Soft light behind the traces: warm low on the left, cool high on the right.
  for (const [x, y, r, c, a] of [[0.15, 0.85, 0.75, '255, 139, 26', 0.30], [0.9, 0.15, 0.7, '79, 163, 232', 0.22], [0.55, 0.5, 0.5, '6, 120, 67', 0.20]]) {
    const glow = g.createRadialGradient(x * w, y * h, 0, x * w, y * h, r * Math.max(w, h));
    glow.addColorStop(0, `rgba(${c}, ${a})`);
    glow.addColorStop(1, `rgba(${c}, 0)`);
    g.fillStyle = glow;
    g.fillRect(0, 0, w, h);
  }
  const rnd = seeded(1020);
  const n = 54;
  const top = h * 0.06;
  const span = h * 0.9;
  g.globalCompositeOperation = 'lighter';
  g.lineJoin = 'round';
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    const y0 = top + f * span;
    const amp = (0.4 + rnd() * 0.6) * span / n * 1.9;
    const waves = Array.from({ length: 4 }, () => ({ k: (0.004 + rnd() * 0.05) * (1 + 3 * rnd()), p: rnd() * 6.283, a: 0.2 + rnd() * 0.5 }));
    const blink = rnd() < 0.5 ? { x: w * (0.2 + 0.6 * rnd()), s: 18 + rnd() * 30, a: (rnd() < 0.5 ? -1 : 1) * amp * (1.5 + rnd() * 2) } : null;
    g.strokeStyle = colourAt(f);
    g.globalAlpha = 0.28 + 0.4 * Math.sin(Math.PI * (0.15 + 0.7 * f)) * (0.6 + 0.4 * rnd());
    g.lineWidth = 0.8 + rnd() * 0.7;
    g.beginPath();
    for (let x = -10; x <= w + 10; x += 2) {
      let v = 0;
      for (const wv of waves) v += wv.a * Math.sin(wv.k * x + wv.p);
      v += (rnd() - 0.5) * 0.35;
      if (blink) v += (blink.a / amp) * Math.exp(-(((x - blink.x) / blink.s) ** 2));
      const y = y0 + v * amp;
      if (x === -10) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  }
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  // Shade an oval where the name and the words sit (left, around the middle), so that they read.
  g.save();
  g.translate(w * 0.3, h * 0.43);
  g.scale(1, 0.5);
  const r = w * 0.62;
  const shade = g.createRadialGradient(0, 0, 0, 0, 0, r);
  shade.addColorStop(0, 'rgba(18, 18, 17, 0.82)');
  shade.addColorStop(0.55, 'rgba(18, 18, 17, 0.55)');
  shade.addColorStop(1, 'rgba(18, 18, 17, 0)');
  g.fillStyle = shade;
  g.fillRect(-r, -r, 2 * r, 2 * r);
  g.restore();
}

export function eegArt() {
  const canvas = document.createElement('canvas');
  canvas.className = 'eeg-art';
  canvas.setAttribute('aria-hidden', 'true');
  let frame = 0;
  let last = '';
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    if (!canvas.isConnected) { ro.disconnect(); return; }
    const size = `${canvas.clientWidth}x${canvas.clientHeight}`;
    if (size === last) return;
    last = size;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => draw(canvas));
  }) : null;
  if (ro) ro.observe(canvas);
  else requestAnimationFrame(() => draw(canvas));
  return canvas;
}
