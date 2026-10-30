// Small helpers shared by the whole application. No DOM access at import time, so the pure parts
// can be imported by the unit tests in Node.

/** Clamp a number between lo and hi. */
export function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

/** "1 annotation", "3 annotations". */
export function plural(n, word, many = `${word}s`) { return `${n} ${n === 1 ? word : many}`; }

/** A length of time as a person reads it: "45 s", "3 min 05 s", "1 h 02 min". */
export function friendlyDuration(s) {
  s = Math.round(s);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** "00:05:12" from seconds. */
export function formatHms(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

/** Local time with its UTC offset and milliseconds, as the desktop application writes it. */
export function nowLocalIso(date = new Date()) {
  const p = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:` +
    `${p(date.getMinutes())}:${p(date.getSeconds())}.${p(date.getMilliseconds(), 3)}` +
    `${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}

/** A new annotation identifier: 32 hexadecimal characters, like Python's uuid4().hex. */
export function newId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID().replace(/-/g, '');
  const bytes = new Uint8Array(16);
  if (c && c.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 'an' before a vowel (an Eye-blink-artifact, an EMG-artifact), otherwise 'a'. */
export function article(word) {
  return 'AEIOU'.includes((word || '').charAt(0).toUpperCase()) ? 'an' : 'a';
}

/** 'Fp1', 'Fp1 and Fp2', 'Fp1, Fp2 and VEOG'. */
export function listWords(items) {
  const a = [...items];
  if (a.length <= 1) return a.join('');
  return a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
}

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Storage that never throws: sandboxed pages, private windows and blocked site data all just
 *  behave as if nothing was stored. */
function safeStorage(kind) {
  const get = () => {
    try { return globalThis[kind] || null; } catch { return null; }
  };
  return {
    get(key, fallback = null) {
      try {
        const s = get();
        const v = s ? s.getItem(key) : null;
        return v === null ? fallback : JSON.parse(v);
      } catch { return fallback; }
    },
    set(key, value) {
      try { const s = get(); if (s) s.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
    },
    remove(key) {
      try { const s = get(); if (s) s.removeItem(key); } catch { /* nothing to do */ }
    },
  };
}

export const local = safeStorage('localStorage');
export const session = safeStorage('sessionStorage');

/** Call fn at most every `ms` milliseconds (trailing call kept). */
export function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  let pending = null;
  return (...args) => {
    pending = args;
    const now = Date.now();
    const run = () => { last = Date.now(); timer = null; fn(...pending); };
    if (now - last >= ms) run();
    else if (!timer) timer = setTimeout(run, ms - (now - last));
  };
}

export function debounce(fn, ms) {
  let timer = null;
  const d = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  d.cancel = () => clearTimeout(timer);
  return d;
}

/** The text and background colours that read best on a label colour. */
export function readableTextColour(hex) {
  const c = hexToRgb(hex);
  const luminance = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  return luminance > 150 ? '#000000' : '#FFFFFF';
}

export function hexToRgb(hex) {
  const h = String(hex || '#808080').replace('#', '');
  const v = h.length === 3 ? h.split('').map((x) => x + x).join('') : h.padEnd(6, '0');
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

export function rgba(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Contrast ratio (WCAG) between two colours. */
export function contrast(a, b) {
  const lum = (hex) => {
    const ch = hexToRgb(hex).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** A darker version of a colour that reaches 4.5:1 on white (for text in the colour of a type). */
export function legibleOnWhite(hex) {
  let [r, g, b] = hexToRgb(hex);
  for (let i = 0; i < 20 && contrast(toHex(r, g, b), '#FFFFFF') < 4.5; i++) {
    r = Math.round(r * 0.85); g = Math.round(g * 0.85); b = Math.round(b * 0.85);
  }
  return toHex(r, g, b);
}

function toHex(r, g, b) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** "12.340 s" */
export function secs(t, digits = 3) {
  return `${Number(t).toFixed(digits)} s`;
}

/** The channels of an annotation as shown in lists: "Whole montage", "C3", "40 ch: A5, A12, …". */
export function channelsText(channels, maxShown = 3) {
  if (!channels || channels.length === 0) return 'Whole montage';
  if (channels.length === 1) return channels[0];
  const shown = channels.slice(0, maxShown).join(', ');
  return `${channels.length} ch: ${shown}${channels.length > maxShown ? ', …' : ''}`;
}

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
/** An iPad or iPhone (iPadOS presents itself as a Mac, so a Mac with a touch screen counts). */
export const IS_IOS = typeof navigator !== 'undefined' && (/iPad|iPhone|iPod/.test(navigator.userAgent || '') ||
  (/Mac/.test(navigator.platform || navigator.userAgent || '') && (navigator.maxTouchPoints || 0) > 1));
/** Whether a person can choose a whole folder (Safari on an iPad or iPhone cannot). */
export const CAN_CHOOSE_FOLDER = !IS_IOS;
/**
 * The `accept` list of a file input. On an iPad or iPhone the file picker greys out files whose
 * extension the system does not know (.edf, .vhdr and others), so there every file can be chosen and
 * the application checks what it is given, as it always does.
 */
export function acceptFiles(list) { return IS_IOS ? undefined : list; }
/** Whether the main pointer is a finger (a touch screen without a mouse or trackpad in use). */
export function touchFirst() {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}
export const CTRL = IS_MAC ? '⌘' : 'Ctrl';
export const UNDO_HINT = `${CTRL}+Z to undo`;
