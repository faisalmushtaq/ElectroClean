// Where electrodes sit on a 2D map of the scalp, as plain functions that the channel chooser's map
// (js/annotate/channel_map.js) uses and the unit tests check. No DOM.
//
// A map position is {x, y} in head units: x to the right, y to the front (the nose is up), and the
// ring through Fpz, T7, Oz and T8 at radius 1. Positions come, in this order, from the recording's
// own electrodes.tsv (projectPositions), from the standard positions of the 10-20, 10-10 and 10-05
// names (standardPosition), or, for montages whose names say nothing about position (BioSemi's A1
// to D32, EGI's E1 to E128), from a ring layout in the order of the channels (ringLayout), which
// the map labels as such.
//
// The standard positions are worked out on an idealised spherical head from the percentage rules
// of the 10-20 system as extended to 10% and 5% steps (Oostenveld and Praamstra, 2001): each row of
// electrodes (Fp, AF, F, FC, C, CP, P, PO, O and the 5% rows between them such as AFF and FCC) runs
// from its midline electrode to the ring at 10% steps of the half circumference (Fp1 at 18 degrees
// from the front, F7 at 54, T7 at 90, O1 at 162), and the numbers divide the row's arc in equal
// parts (1 and 2 a quarter of the way out, 7 and 8 at the ring). Numbers 9 and 10 sit on the ring
// below, 22.5 degrees under the 7s and 8s; an h halves a step (C1h between Cz and C1). The sphere
// is drawn with the azimuthal equidistant projection that EEG topographies use, so that the angle
// from the vertex becomes the distance from the centre.

const DEG = Math.PI / 180;

/** The rows of the 10-05 system, by their number of 22.5-degree steps forward (+) or back (-) from C. */
const ROWS = Object.freeze({
  FP: 4, AFP: 3.5, AF: 3, AFF: 2.5, F: 2, FFC: 1.5, FFT: 1.5, FC: 1, FT: 1, FCC: 0.5, FTT: 0.5,
  C: 0, T: 0, CCP: -0.5, TTP: -0.5, CP: -1, TP: -1, CPP: -1.5, TPP: -1.5, P: -2, PPO: -2.5,
  PO: -3, POO: -3.5, O: -4, OI: -4.5,
});
/** The names of the original 10-20 system that the 10-10 system renamed. */
const OLD_NAMES = Object.freeze({ T3: 'T7', T4: 'T8', T5: 'P7', T6: 'P8' });

/** A channel's name without what EDF files add ("EEG Fp1-REF" is Fp1), in capitals. */
export function electrodeCore(name) {
  let core = String(name ?? '').trim().replace(/^EEG[\s_-]*/i, '');
  core = core.replace(/[\s_-](REF|LE|AR|AVG|CZ|M1|M2|A1|A2)$/i, '');
  return core.toUpperCase();
}

/** A point on the unit sphere: polar angle from the vertex and azimuth from the front, left positive (degrees). */
function onSphere(polar, azimuth) {
  const t = polar * DEG;
  const a = azimuth * DEG;
  return [-Math.sin(t) * Math.sin(a), Math.sin(t) * Math.cos(a), Math.cos(t)];
}

const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const cross = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
const scale = (p, s) => [p[0] * s, p[1] * s, p[2] * s];
const unit = (p) => { const n = Math.hypot(...p); return n ? scale(p, 1 / n) : p; };

/** The point `f` of the way (0 at the midline, 1 at the ring) along a row's arc on the left. */
function alongRow(row, f) {
  const steps = Math.abs(row);
  const mid = onSphere(22.5 * steps, row >= 0 ? 0 : 180);
  const azimuth = 90 - 18 * row;
  const left = onSphere(90, azimuth);
  const right = onSphere(90, -azimuth);
  // The circle through the three points is where the sphere meets their plane.
  const n = unit(cross(sub(left, mid), sub(right, mid)));
  const centre = scale(n, dot(n, mid));
  const u = unit(sub(mid, centre));
  const v = cross(n, u);
  const r = Math.hypot(...sub(mid, centre));
  const l = sub(left, centre);
  let end = Math.atan2(dot(l, v), dot(l, u));
  if (Math.abs(end) < 1e-9) end = Math.PI; // (cannot happen for a real row, kept for safety)
  const ang = f * end;
  return [centre[0] + r * (Math.cos(ang) * u[0] + Math.sin(ang) * v[0]),
    centre[1] + r * (Math.cos(ang) * u[1] + Math.sin(ang) * v[1]),
    centre[2] + r * (Math.cos(ang) * u[2] + Math.sin(ang) * v[2])];
}

/** A point on the unit sphere drawn with the azimuthal equidistant projection: {x, y}, the ring at 1. */
export function projectPoint(p) {
  const [x, y, z] = unit(p);
  const polar = Math.acos(Math.max(-1, Math.min(1, z)));
  const s = Math.hypot(x, y);
  const rho = polar / (Math.PI / 2);
  return s < 1e-12 ? { x: 0, y: 0 } : { x: (rho * x) / s, y: (rho * y) / s };
}

/** The point on the sphere of a 10-05 name's core (capitals), or null. */
function sphereOf(core) {
  if (OLD_NAMES[core]) core = OLD_NAMES[core];
  const special = { NZ: [112.5, 0], IZ: [112.5, 180], I1: [112.5, 171], I2: [112.5, -171],
    A1: [123.75, 90], A2: [123.75, -90], LPA: [123.75, 90], RPA: [123.75, -90], M1: [123.75, 108], M2: [123.75, -108] };
  if (special[core]) return onSphere(...special[core]);
  const m = /^([A-Z]+?)(Z|(\d{1,2})(H?))$/.exec(core);
  if (!m || !(m[1] in ROWS)) return null;
  const row = ROWS[m[1]];
  if (m[2] === 'Z') return alongRow(row, 0);
  const n = Number(m[3]);
  const half = m[4] === 'H';
  if (n < 1 || n > 10 || (half && n > 10)) return null;
  const odd = n % 2 === 1;
  const mirror = (p) => (odd ? p : [-p[0], p[1], p[2]]);
  const idx = Math.ceil(n / 2); // 1 and 2 are 1, 7 and 8 are 4, 9 and 10 are 5
  const ring = Math.abs(row) >= 4; // the Fp and O rows lie on the ring itself: 1 and 2 are at its end
  const lower = (r) => onSphere(112.5, 90 - 18 * r); // 9 and 10: on the ring below
  if (idx === 5) {
    if (!half) return mirror(lower(row));
    // 9h and 10h: halfway between the 7 and the 9
    return mirror(unit(scale([...alongRow(row, 1)].map((c, i) => c + lower(row)[i]), 0.5)));
  }
  const f = ring ? Math.min(1, idx - (half ? 0.5 : 0)) : (idx - (half ? 0.5 : 0)) / 4;
  return mirror(alongRow(row, f));
}

/** The standard map position of a 10-20, 10-10 or 10-05 name (also as EDF files write it), or null. */
export function standardPosition(name) {
  const p = sphereOf(electrodeCore(name));
  return p ? projectPoint(p) : null;
}

// ------------------------------------------------------------------ the recording's own positions
/** BIDS coordinate systems whose x axis points to the front and y to the left (BIDS appendix, Coordinate systems). */
export const ALS_SYSTEMS = Object.freeze(['EEGLAB', 'EEGLAB-HJ', 'CTF', '4DBti', 'KitYokogawa']);

/** The centre of the sphere that best fits the points (least squares), or null when they do not span one. */
export function fitSphere(points) {
  if (points.length < 4) return null;
  // x² + y² + z² = 2ax + 2by + 2cz + k, linear in a, b, c and k: solve the normal equations.
  const A = Array.from({ length: 4 }, () => new Array(5).fill(0));
  for (const [x, y, z] of points) {
    const row = [2 * x, 2 * y, 2 * z, 1];
    const rhs = x * x + y * y + z * z;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) A[i][j] += row[i] * row[j];
      A[i][4] += row[i] * rhs;
    }
  }
  for (let c = 0; c < 4; c++) {
    let best = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(A[r][c]) > Math.abs(A[best][c])) best = r;
    if (Math.abs(A[best][c]) < 1e-12) return null;
    [A[c], A[best]] = [A[best], A[c]];
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 5; k++) A[r][k] -= f * A[c][k];
    }
  }
  const centre = [A[0][4] / A[0][0], A[1][4] / A[1][1], A[2][4] / A[2][2]];
  return centre.every(Number.isFinite) ? centre : null;
}

/**
 * Map positions from 3D positions ({name: [x, y, z]} as a Map, in any unit) in a BIDS coordinate
 * system: turned to right-front-up, centred on the sphere that fits them best, and projected as the
 * standard positions are. Positions in one plane (a flat layout) are used as they are, scaled so that
 * the farthest is at 1. Returns a Map name -> {x, y}.
 */
export function projectPositions(positions, system = '') {
  const als = ALS_SYSTEMS.map((s) => s.toLowerCase()).includes(String(system || '').toLowerCase());
  const names = [];
  const pts = [];
  for (const [name, p] of positions) {
    if (!Array.isArray(p) || p.length < 2 || !p.slice(0, 2).every(Number.isFinite)) continue;
    const z = Number.isFinite(p[2]) ? p[2] : 0;
    names.push(name);
    pts.push(als ? [-p[1], p[0], z] : [p[0], p[1], z]);
  }
  const out = new Map();
  if (!pts.length) return out;
  const zs = pts.map((p) => p[2]);
  const span = Math.max(...pts.flatMap((p) => p.map(Math.abs))) || 1;
  const flat = Math.max(...zs) - Math.min(...zs) < 1e-6 * span;
  const centre = flat ? null : fitSphere(pts);
  if (!centre) {
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const far = Math.max(...pts.map((p) => Math.hypot(p[0] - cx, p[1] - cy))) || 1;
    pts.forEach((p, i) => out.set(names[i], { x: (p[0] - cx) / far, y: (p[1] - cy) / far }));
    return out;
  }
  pts.forEach((p, i) => out.set(names[i], projectPoint(sub(p, centre))));
  return out;
}

// --------------------------------------------------------------------------- the ring layout
/**
 * `n` points in order on rings around the centre, inside radius 1: ring k (of K) at radius k/K holds
 * a share of the points proportional to its circumference, starting at the top and going clockwise,
 * the first ring innermost. K is the fewest rings that keep the points about as far apart along each
 * ring as the rings are apart.
 */
export function ringLayout(n) {
  if (n <= 0) return [];
  if (n === 1) return [{ x: 0, y: 0 }];
  let K = 1;
  while (n > 3 * K * (K + 1)) K += 1; // at most 6k points on ring k
  const total = (K * (K + 1)) / 2;
  const exact = Array.from({ length: K }, (_, i) => (n * (i + 1)) / total);
  const counts = exact.map(Math.floor);
  let left = n - counts.reduce((s, c) => s + c, 0);
  const order = exact.map((e, i) => [e - Math.floor(e), i]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  for (const [, i] of order) { if (!left) break; counts[i] += 1; left -= 1; }
  const out = [];
  counts.forEach((c, i) => {
    const r = (i + 1) / K;
    for (let j = 0; j < c; j++) {
      const a = (2 * Math.PI * j) / c;
      out.push({ x: r * Math.sin(a), y: r * Math.cos(a) });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------------- the layout
const isEeg = (c) => ['eeg', ''].includes(String(c.type || '').toLowerCase());

/**
 * The map of a montage. channels: [{name, type}] in display order; electrodes: a Map name -> {x, y}
 * from the recording's own electrodes.tsv (projectPositions), or null. Returns {source: 'file' |
 * 'standard' | 'order', points: [{name, x, y, extra}]}: the EEG channels with their positions, then
 * the channels without one (other types, names the map cannot place) in rows under the head, marked
 * extra. A montage is placed by its names when 60% or more of its EEG channels have standard
 * positions (the channel chooser's rule); otherwise its EEG channels go on rings in their order.
 */
export function mapLayout(channels, electrodes = null) {
  const eeg = channels.filter(isEeg);
  const pool = eeg.length ? eeg : channels;
  const fromFile = electrodes && electrodes.size ? pool.filter((c) => electrodes.has(c.name)) : [];
  let source;
  let placed;
  if (fromFile.length) {
    source = 'file';
    placed = new Map(fromFile.map((c) => [c.name, electrodes.get(c.name)]));
  } else {
    const named = pool.map((c) => [c.name, standardPosition(c.name)]).filter(([, p]) => p);
    if (named.length && named.length >= 0.6 * pool.length) {
      source = 'standard';
      placed = new Map(named);
    } else {
      source = 'order';
      const ring = ringLayout(pool.length);
      placed = new Map(pool.map((c, i) => [c.name, ring[i]]));
    }
  }
  const points = [];
  const rest = [];
  for (const c of channels) {
    const p = placed.get(c.name);
    if (p && !points.some((q) => q.name === c.name)) points.push({ name: c.name, x: p.x, y: p.y, extra: false });
    else rest.push(c.name);
  }
  // Channels without a place: rows under the head, as wide as the head.
  const bottom = points.length ? Math.min(-1.05, ...points.map((p) => p.y)) : -1;
  const perRow = 8;
  rest.forEach((name, i) => {
    const row = Math.floor(i / perRow);
    const inRow = Math.min(perRow, rest.length - row * perRow);
    const col = i % perRow;
    points.push({ name, x: inRow === 1 ? 0 : -1 + (2 * col) / (perRow - 1) + (perRow - inRow) / (perRow - 1), y: bottom - 0.3 - 0.25 * row, extra: true });
  });
  return { source, points };
}

/** The smallest distance between two points (Infinity for fewer than two). */
export function minSpacing(points) {
  let best = Infinity;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
      if (d < best) best = d;
    }
  }
  return best;
}

/** The extent of the points: {minX, maxX, minY, maxY}, at least the head (radius 1) and a margin. */
export function extentOf(points, margin = 0.15) {
  const xs = [-1, 1, ...points.map((p) => p.x)];
  const ys = [-1, 1.12, ...points.map((p) => p.y)]; // the nose above the ring
  return { minX: Math.min(...xs) - margin, maxX: Math.max(...xs) + margin, minY: Math.min(...ys) - margin, maxY: Math.max(...ys) + margin };
}

/**
 * Pixels per head unit: what fits `widthPx` × `heightPx`, or more when the targets (`targetPx`
 * wide, with a small gap) would otherwise overlap; `zoom` multiplies the larger of the two.
 */
export function mapScale(points, { widthPx, heightPx, targetPx, zoom = 1 }) {
  const e = extentOf(points);
  const fit = Math.min(widthPx / (e.maxX - e.minX), heightPx / (e.maxY - e.minY));
  const spacing = minSpacing(points);
  const needed = Number.isFinite(spacing) && spacing > 0 ? (targetPx + 4) / spacing : 0;
  return { scale: Math.max(fit, needed) * zoom, fit, needed };
}

/**
 * The point to move to from `from` (an index) for an arrow key: dir 'left' | 'right' | 'up' | 'down'
 * (up is towards the nose). The nearest point within 60 degrees of that direction, nearer ones
 * preferred over straighter ones; `from` itself when there is none.
 */
export function nearestInDirection(points, from, dir) {
  const [dx, dy] = { left: [-1, 0], right: [1, 0], up: [0, 1], down: [0, -1] }[dir] || [0, 0];
  const p = points[from];
  if (!p) return from;
  let best = from;
  let bestScore = Infinity;
  points.forEach((q, i) => {
    if (i === from) return;
    const vx = q.x - p.x;
    const vy = q.y - p.y;
    const d = Math.hypot(vx, vy);
    if (d < 1e-9) return;
    const cos = (vx * dx + vy * dy) / d;
    if (cos < Math.cos(60 * DEG)) return;
    const score = d * (1 + 2 * (1 - cos));
    if (score < bestScore) { bestScore = score; best = i; }
  });
  return best;
}

/** The names of the points inside a box {x0, y0, x1, y1} (head units, either corner first). */
export function pointsInBox(points, box) {
  const [xa, xb] = [Math.min(box.x0, box.x1), Math.max(box.x0, box.x1)];
  const [ya, yb] = [Math.min(box.y0, box.y1), Math.max(box.y0, box.y1)];
  return points.filter((p) => p.x >= xa && p.x <= xb && p.y >= ya && p.y <= yb).map((p) => p.name);
}
