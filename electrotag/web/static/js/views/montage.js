// A small figure on the sign-in page's illustration: the 10-20 electrode montage drawn as a
// wireframe in light lines (a dashed head outline, the 19 electrodes joined to Cz by faint lines,
// and three nodes on a slowly turning orbit, which stands still when the person asks for reduced
// motion).

const SVG = 'http://www.w3.org/2000/svg';

// Positions on a unit circle (x to the right, y towards the nose), as in the usual flat drawing.
const ELECTRODES = [
  ['Fp1', -0.31, 0.95], ['Fp2', 0.31, 0.95],
  ['F7', -0.81, 0.59], ['F3', -0.39, 0.52], ['Fz', 0, 0.5], ['F4', 0.39, 0.52], ['F8', 0.81, 0.59],
  ['T7', -1, 0], ['C3', -0.5, 0], ['Cz', 0, 0], ['C4', 0.5, 0], ['T8', 1, 0],
  ['P7', -0.81, -0.59], ['P3', -0.39, -0.52], ['Pz', 0, -0.5], ['P4', 0.39, -0.52], ['P8', 0.81, -0.59],
  ['O1', -0.31, -0.95], ['O2', 0.31, -0.95],
];

function el(name, attrs = {}, ...children) {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  for (const c of children) if (c) node.append(c);
  return node;
}

export function montageFigure() {
  const C = 200; // the centre of the 400 × 400 drawing
  const HEAD = 140; // the head outline
  const R = 0.84 * HEAD; // the electrodes, inside the outline
  const ink = '#FDFCFB';
  const centre = '#FFFFFF';
  const svg = el('svg', { viewBox: '0 0 400 400', class: 'montage', 'aria-hidden': 'true', focusable: 'false' });
  // Guides: the two axes and a ring at half the radius, as on a drawing board.
  svg.append(
    el('path', { d: `M${C} 24V376M24 ${C}H376`, stroke: ink, 'stroke-opacity': 0.12, 'stroke-width': 1, fill: 'none' }),
    el('circle', { cx: C, cy: C, r: HEAD / 2, fill: 'none', stroke: ink, 'stroke-opacity': 0.18, 'stroke-dasharray': '2 4' }),
  );
  // The head: dashed outline, nose and ears.
  svg.append(
    el('circle', { cx: C, cy: C, r: HEAD, fill: 'none', stroke: ink, 'stroke-opacity': 0.55, 'stroke-dasharray': '5 5' }),
    el('path', { d: `M${C - 14} ${C - HEAD + 2}L${C} ${C - HEAD - 18}L${C + 14} ${C - HEAD + 2}`, fill: 'none', stroke: ink, 'stroke-opacity': 0.55 }),
    el('rect', { x: C - HEAD - 9, y: C - 22, width: 9, height: 44, fill: 'none', stroke: ink, 'stroke-opacity': 0.4 }),
    el('rect', { x: C + HEAD, y: C - 22, width: 9, height: 44, fill: 'none', stroke: ink, 'stroke-opacity': 0.4 }),
  );
  // Each electrode joined to Cz.
  const lines = el('g', { stroke: ink, 'stroke-opacity': 0.2, 'stroke-width': 1 });
  const nodes = el('g', {});
  for (const [name, x, y] of ELECTRODES) {
    const px = C + x * R;
    const py = C - y * R;
    if (name === 'Cz') {
      nodes.append(el('circle', { cx: px, cy: py, r: 8, fill: centre }));
      nodes.append(el('text', { x: px + 12, y: py - 10, class: 'montage-label' }, document.createTextNode(name)));
      continue;
    }
    lines.append(el('line', { x1: C, y1: C, x2: px, y2: py }));
    nodes.append(el('circle', { cx: px, cy: py, r: 4, fill: 'none', stroke: ink, 'stroke-opacity': 0.8, 'stroke-width': 1 }));
    const right = x >= 0;
    nodes.append(el('text', { x: px + (right ? 8 : -8), y: py + 14, 'text-anchor': right ? 'start' : 'end', class: 'montage-label' },
      document.createTextNode(name)));
  }
  svg.append(lines, nodes);
  // Three nodes on a dashed orbit.
  const ORBIT = 176;
  const orbit = el('g', { class: 'orbit' },
    el('circle', { cx: C, cy: C, r: ORBIT, fill: 'none', stroke: ink, 'stroke-opacity': 0.3, 'stroke-dasharray': '1 6' }));
  [['#FF9A3C', -90], ['#F4D35E', 30], ['#5E8FE0', 150]].forEach(([fill, deg]) => {
    const a = (deg * Math.PI) / 180;
    const x = C + ORBIT * Math.cos(a);
    const y = C + ORBIT * Math.sin(a);
    orbit.append(el('line', { x1: C, y1: C, x2: x, y2: y, stroke: ink, 'stroke-opacity': 0.12 }));
    orbit.append(el('circle', { cx: x, cy: y, r: 6, fill }));
  });
  svg.append(orbit);
  // Coordinates in the corners, as on a drawing.
  [['A', 12, 20, 'start'], ['B', 388, 20, 'end'], ['C', 12, 392, 'start'], ['D', 388, 392, 'end']].forEach(([t, x, y, anchor]) =>
    svg.append(el('text', { x, y, 'text-anchor': anchor, class: 'montage-label faint' }, document.createTextNode(t))));
  return svg;
}
