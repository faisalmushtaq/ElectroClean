// Read-only layers of marks drawn over the EEG beside the annotations (viewer.setLayers), and the
// replay's pointer (viewer.setReplayPointer): the arithmetic, without the page, so that it can be
// tested in Node. A layer is {id, annotations, style: 'dashed', prefix, visible}: the original of a
// correction, drawn as dashed outlines so that a removed or moved mark stays visible. A mark of a
// layer that is exactly one of the annotations on screen (the same ID, type, times and channels) is
// left out, since the annotation itself shows it.

const endOf = (a) => a.onset_sample + a.duration_samples;
const sameSet = (x, y) => {
  const a = new Set(x || []);
  const b = new Set(y || []);
  return a.size === b.size && [...a].every((v) => b.has(v));
};

/** True when two marks are the same in everything drawn: ID, type, times and channels. */
export function sameMark(a, b) {
  return Boolean(a && b) && a.annotation_id === b.annotation_id && a.label === b.label && a.onset_sample === b.onset_sample
    && a.duration_samples === b.duration_samples && sameSet(a.channels, b.channels);
}

/** A list of layers made safe to draw: each with its annotations, a prefix and whether it is shown. */
export function normaliseLayers(layers) {
  return (Array.isArray(layers) ? layers : []).filter((l) => l && Array.isArray(l.annotations)).map((l, i) => ({
    id: String(l.id || `layer-${i + 1}`), annotations: l.annotations, style: l.style === 'solid' ? 'solid' : 'dashed',
    prefix: typeof l.prefix === 'string' ? l.prefix : '', visible: l.visible !== false,
  }));
}

/**
 * The marks of the shown layers to draw between samples s0 and s1 (the view), with their layer:
 * [{layer, a}], leaving out those the current annotations show already.
 */
export function layerMarks(layers, current, s0, s1) {
  const byId = new Map((current || []).map((a) => [a.annotation_id, a]));
  const out = [];
  for (const layer of normaliseLayers(layers)) {
    if (!layer.visible) continue;
    for (const a of layer.annotations) {
      if (a.onset_sample >= s1 || endOf(a) <= s0) continue;
      if (sameMark(a, byId.get(a.annotation_id))) continue;
      out.push({ layer, a });
    }
  }
  return out;
}

/**
 * Where the replay's pointer goes: its x for time t, and the centre of its channel's row when that row
 * is on screen (otherwise the middle of the plot), or null when the time is outside the view.
 * `rows` are the visible rows ({row, ch}); `geo` holds x0, x1, y0, y1, tToX(t) and rowCentre(row).
 */
export function pointerSpot(pointer, rows, geo) {
  if (!pointer || typeof pointer.t !== 'number' || !Number.isFinite(pointer.t)) return null;
  const x = geo.tToX(pointer.t);
  if (x < geo.x0 - 0.5 || x > geo.x1 + 0.5) return null;
  const hit = pointer.channel ? rows.find((r) => r.ch.name === pointer.channel) : null;
  return { x, y: hit ? geo.rowCentre(hit.row) : (geo.y0 + geo.y1) / 2, onChannel: Boolean(hit) };
}
