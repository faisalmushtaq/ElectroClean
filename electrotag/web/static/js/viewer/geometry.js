// Pure helpers of the EEG viewer (no DOM), so they can be unit tested in Node.

/** A tick step (seconds) that leaves at least `minPx` pixels between labels. */
export function niceStep(durationS, widthPx, minPx = 70) {
  const steps = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  for (const s of steps) if ((s / durationS) * widthPx >= minPx) return s;
  return steps[steps.length - 1];
}

/**
 * How the time axis writes its times on one screen: 'clock' (m:ss, or h:mm:ss past an hour) once
 * the ticks are a minute or more apart or the screen reaches ten minutes, and 's' (seconds)
 * otherwise. One format for the whole axis, so that its title can name the unit.
 */
export function axisFormat(startS, durationS, step) {
  return step >= 60 || startS + durationS >= 600 ? 'clock' : 's';
}

/** The axis's title for a format: "time (s)", "time (m:ss)" or, past an hour, "time (h:mm:ss)". */
export function axisTitle(format, endS) {
  if (format !== 'clock') return 'time (s)';
  return endS >= 3600 ? 'time (h:mm:ss)' : 'time (m:ss)';
}

/**
 * "12", "12.5", "1:05", "15:00.5" or "1:02:05" tick labels: seconds, or a clock (the format of
 * axisFormat; by default a clock from ten minutes on), with the decimals the step needs.
 */
export function tickLabel(t, step, format = step >= 60 || t >= 600 ? 'clock' : 's') {
  const digits = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  if (format !== 'clock') return t.toFixed(digits);
  // Whole units of the last digit shown, so that 59.96 s at tenths is 1:00.0 and never 0:60.0.
  const per = 10 ** digits;
  const units = Math.round(t * per);
  const secUnits = units % (60 * per);
  const minutes = Math.floor(units / (60 * per));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const sec = (secUnits / per).toFixed(digits).padStart(digits ? 3 + digits : 2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
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

/**
 * Min, max and sum of `data` (from absolute sample `dataStart`) for `cols` columns of a fixed grid:
 * column g covers samples [floor(g * grid), floor((g + 1) * grid)). Columns already worked out in
 * `prev` (the same grid, the same data) are copied, so scrolling only works out the new ones.
 */
export function decimateColumns(data, dataStart, grid, g0, cols, prev = null) {
  const min = new Float32Array(cols);
  const max = new Float32Array(cols);
  const sum = new Float64Array(cols);
  const cnt = new Int32Array(cols);
  const n = data.length;
  const usable = prev && prev.grid === grid ? prev : null;
  for (let col = 0; col < cols; col++) {
    const g = g0 + col;
    if (usable) {
      const j = g - usable.g0;
      if (j >= 0 && j < usable.n && usable.cnt[j] > 0) {
        min[col] = usable.min[j]; max[col] = usable.max[j]; sum[col] = usable.sum[j]; cnt[col] = usable.cnt[j];
        continue;
      }
    }
    let a = Math.floor(g * grid) - dataStart;
    let b = Math.floor((g + 1) * grid) - dataStart;
    if (b <= a) b = a + 1;
    if (a < 0) a = 0;
    if (b > n) b = n;
    if (a >= b) { min[col] = NaN; max[col] = NaN; continue; }
    let lo = data[a];
    let hi = lo;
    let s = lo;
    for (let k = a + 1; k < b; k++) {
      const v = data[k];
      s += v;
      lo = v < lo ? v : lo;
      hi = v > hi ? v : hi;
    }
    min[col] = lo; max[col] = hi; sum[col] = s; cnt[col] = b - a;
  }
  return { grid, g0, n: cols, min, max, sum, cnt };
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
export const DURATIONS = [1, 2, 5, 10, 20, 30, 60, 120]; // the toolbar's time scales (scales.js TIME_SCALES), then two minutes
export const CHANNEL_COUNTS = [1, 2, 4, 8, 12, 16, 20, 24, 32, 48, 64, 96, 128, 192, 256];

export function stepOption(options, current, dir, max = Infinity) {
  // The largest choice is everything there is (all the channels, the whole recording).
  const list = Number.isFinite(max) ? [...options.filter((v) => v < max), max] : [...options];
  if (dir > 0) return list.find((v) => v > current + 1e-9) ?? list[list.length - 1];
  const smaller = list.filter((v) => v < current - 1e-9);
  return smaller.length ? smaller[smaller.length - 1] : list[0];
}

/** "100 µV", "1.5 mV" for a scale bar of `volts`. */
export function voltsText(volts) {
  const uv = volts * 1e6;
  if (uv >= 1000) return `${+(uv / 1000).toPrecision(3)} mV`;
  return `${+uv.toPrecision(3)} µV`;
}

// ------------------------------------------------------------------------- the overlay
/** In the overlay, half the plot's height stands for this many times a channel type's scaling. */
export const OVERLAY_SPAN = 4;

/**
 * Pixels per unit of signal in the overlay, where every channel shares one axis: half the plot's
 * height (`plotH`) shows OVERLAY_SPAN × the type's scaling (200 µV for EEG at 50 µV), larger or
 * smaller with the amplitude (`scaleFactor`, the − and + keys). Returns {k, lim}: the gain and the
 * clip, a pixel short of the plot's edges.
 */
export function overlayGain(plotH, scaling, scaleFactor = 1) {
  const half = Math.max(1, plotH / 2);
  return { k: (half / (OVERLAY_SPAN * (scaling || 1e-3))) * scaleFactor, lim: Math.max(1, half - 1) };
}

/** The opacity of each trace in the overlay: overlaps darken, so many traces are lighter (0.18 to 0.7). */
export function overlayAlpha(nChannels) {
  return Math.min(0.7, Math.max(0.18, 4 / Math.max(1, nChannels)));
}

/** The value shown by the pointer readout: "−23.4 µV" (volts in, the minus sign of print). */
export function microvoltText(volts) {
  const uv = volts * 1e6;
  const a = Math.abs(uv);
  const text = a >= 1000 ? a.toFixed(0) : a.toFixed(1);
  return `${uv < 0 && Number(text) !== 0 ? '−' : ''}${text} µV`;
}
