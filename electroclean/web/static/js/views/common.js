// Pieces shared by the views: the header bar, the brand mark, the icons and the small-screen notice.

import { h } from '../ui/dom.js';

const SVG = 'http://www.w3.org/2000/svg';

export function brandMark(size = 28, colour = '#1E1E1E') {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('brand-mark');
  // A head seen from above (a thin circle) with an EEG trace running through it, drawn in one line weight.
  const circle = document.createElementNS(SVG, 'circle');
  Object.entries({ cx: 16, cy: 16, r: 14.25, fill: 'none', stroke: colour, 'stroke-width': 1.5 }).forEach(([k, v]) => circle.setAttribute(k, String(v)));
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', 'M3.5 16.5h5l2.4-5.5 3.6 11.5 3.1-9 2 3.5h8.9');
  Object.entries({ fill: 'none', stroke: colour, 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }).forEach(([k, v]) => path.setAttribute(k, String(v)));
  svg.append(circle, path);
  return svg;
}

/** A drawn icon in the colour of the text around it (the --i-* masks of app.css): arrow-right,
 * arrow-left, arrow-up, arrow-down, arrow-up-right, chevron-down, chevron-right, check, close, star
 * and star-empty. Icons stand beside words, so they are hidden from screen readers. */
export function icon(name) {
  return h(`span.ico.ico-${name}`, { 'aria-hidden': 'true' });
}

/** Stars earned out of those possible, drawn (★★☆ for 2 of 3); one star for long counts, whose
 * number the text beside it gives. */
export function starIcons(stars, maxStars) {
  const n = maxStars <= 9 ? maxStars : 1;
  const out = h('span.stars', { 'aria-hidden': 'true' });
  for (let i = 0; i < n; i++) out.append(icon(i < stars ? 'star' : 'star-empty'));
  return out;
}

/** The header bar. Administrators also get the way into the admin area (or, inside it, back to their recordings). */
export function appHeader(app, { title = '', admin = false, tools = null } = {}) {
  const me = app.me;
  const study = me && me.study ? me.study.name : app.backend && app.backend.health ? app.backend.health.study : '';
  const switcher = app.isAdmin
    ? h('button.btn.quiet.admin-switch', { type: 'button', 'data-log': admin ? 'leave-admin' : 'admin',
      onclick: () => (admin ? app.showHome() : app.showAdmin('admin')) }, admin ? 'My recordings' : 'Admin')
    : null;
  return h('header.app-header', {},
    h('div.brand', {}, brandMark(26), h('span.brand-name', {}, 'ElectroClean'),
      study && !(app.backend && app.backend.isDemo) ? h('span.brand-study', {}, study) : null, title ? h('span.brand-study', {}, title) : null,
      admin ? h('span.chip.active.admin-chip', {}, 'Admin') : null,
      app.backend && app.backend.isDemo ? h('span.chip.warning', {}, 'Demonstration') : null),
    tools,
    me ? h('div.who', {},
      switcher,
      h('span.who-name', {}, `${me.annotator_id}${me.display_name ? ` · ${me.display_name}` : ''}`),
      h('button.btn.quiet', { type: 'button', 'data-log': 'sign-out', onclick: () => app.signOut() }, 'Sign out')) : null);
}

export function smallScreenNotice() {
  return h('div.small-screen', { role: 'note' },
    h('div.card', {}, brandMark(40),
      h('h1', {}, 'ElectroClean needs a larger screen'),
      h('p', {}, 'Annotating EEG needs room for the traces. Please open this page on a tablet such as an iPad, or on a laptop or desktop computer.'),
      h('p.caption', {}, 'You can still sign in here; your work waits for you on the larger screen.')));
}

/** Download files (Blob) through the browser; harmless where downloads are not allowed. */
export function downloadFiles(files) {
  for (const f of files) {
    try {
      const url = URL.createObjectURL(f.blob);
      const a = h('a', { href: url, download: f.name, hidden: true });
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
    } catch { /* downloads not allowed here */ }
  }
}
