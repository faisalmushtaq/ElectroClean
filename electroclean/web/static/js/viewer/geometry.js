// Pure helpers of the EEG viewer (no DOM), so they can be unit tested in Node.

/** A tick step (seconds) that leaves at least `minPx` pixels between labels. */
export function niceStep(durationS, widthPx, minPx = 70) {
  const steps = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  for (const s of steps) if ((s / durationS) * widthPx >= minPx) return s;
  return steps[steps.length - 1];
}

/** "12", "12.5", "1:05:00" style tick labels (seconds below a minute shown as seconds). */
export function tickLabel(t, step) {
  if (step >= 60 || t >= 600) {
    const s = Math.round(t);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }
  const digits = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  return t.toFixed(digits);
}

/**
 * Min/max of `data` (from absolute sample `dataStart`) for each of `columns` columns covering
 * samples [s0, s0 + span). Returns {min, max} Float32Arrays (NaN where there is no data).
 */
export function columnMinMax(data, dataStart, s0, span, columns) {
  const min = new Float32Array(columns).fill(NaN);
  const max = new Float32Array(columns).fill(NaN);
  const spp = span / columns;
  const n = data.length;
  for (let c = 0; c < columns; c++) {
    let a = Math.floor(s0 + c * spp) - dataStart;
    let b = Math.floor(s0 + (c + 1) * spp) - dataStart;
    if (b <= a) b = a + 1;
    if (a < 0) a = 0;
    if (b > n) b = n;
    if (a >= b) continue;
    let lo = data[a];
    let hi = lo;
    for (let k = a + 1; k < b; k++) {
      const v = data[k];
      if (v < lo) lo = v; else if (v > hi) hi = v;
    }
    min[c] = lo;
    max[c] = hi;
  }
  return { min, max };
}

/** Mean of data over [a, b) (indices), for removing the offset of each trace. */
export function meanOf(data, a, b) {
  a = Math.max(0, a); b = Math.min(data.length, b);
  if (b <= a) return 0;
  let s = 0;
  for (let k = a; k < b; k++) s += data[k];
  return s / (b - a);
}

/**
 * Rows for annotation tags so that neighbours do not overlap: each tag {x, w} (centre and width)
 * goes in the first row where it fits; tags that fit nowhere go in the last row.
 */
export function layoutTags(tags, rows = 2, gap = 4) {
  const order = tags.map((t, i) => [t, i]).sort((a, b) => a[0].x - b[0].x);
  const right = new Array(rows).fill(-Infinity);
  const out = new Array(tags.length);
  for (const [t, i] of order) {
    let row = right.findIndex((r) => t.x - t.w / 2 >= r + gap);
    if (row < 0) row = right.indexOf(Math.min(...right));
    right[row] = Math.max(right[row], t.x + t.w / 2);
    out[i] = row;
  }
  return out;
}

/** Display options for seconds and channels shown (Home/End and Page Up/Page Down step through them). */
export const DURATIONS = [1, 2, 3, 5, 10, 15, 20, 30, 60, 120];
export const CHANNEL_COUNTS = [1, 2, 4, 8, 12, 16, 20, 24, 32, 48, 64, 96, 128, 192, 256];

export function stepOption(options, current, dir, max = Infinity) {
  const list = options.filter((v) => v <= max);
  if (!list.length) return current;
  if (dir > 0) return list.find((v) => v > current + 1e-9) ?? Math.min(max, list[list.length - 1]);
  const smaller = list.filter((v) => v < current - 1e-9);
  return smaller.length ? smaller[smaller.length - 1] : list[0];
}

/** "100 µV", "1.5 mV" for a scale bar of `volts`. */
export function voltsText(volts) {
  const uv = volts * 1e6;
  if (uv >= 1000) return `${+(uv / 1000).toPrecision(3)} mV`;
  return `${+uv.toPrecision(3)} µV`;
}
