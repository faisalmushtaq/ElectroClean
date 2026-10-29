// Colour science for the palette checks of the unit tests (ui_channel_colours, ui_type_colours):
// distances in OKLab x 100 with full colour vision, and under simulated protanopia and deuteranopia
// (Machado, Oliveira and Fernandes 2009, severity 1), the nearer of the two. Not a test file itself.
const { hexToRgb } = await import('../../electrotag/web/static/js/util.js');

export const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const enc = (c) => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
export function oklab(rgb) {
  const [r, g, b] = rgb.map(lin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const MACHADO = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
};
export const simulate = (hex, kind) => {
  const v = hexToRgb(hex).map(lin);
  return MACHADO[kind].map((row) => enc(Math.min(1, Math.max(0, row[0] * v[0] + row[1] * v[1] + row[2] * v[2]))));
};
const dist = (a, b) => Math.hypot(...a.map((x, i) => (x - b[i]) * 100));
/** The distance between two colours with full colour vision. */
export const normal = (a, b) => dist(oklab(hexToRgb(a)), oklab(hexToRgb(b)));
/** The distance between two colours for someone with red-green colour blindness (the nearer of protan and deutan). */
export const cvd = (a, b) => Math.min(...['protan', 'deutan'].map((k) => dist(oklab(simulate(a, k)), oklab(simulate(b, k)))));
