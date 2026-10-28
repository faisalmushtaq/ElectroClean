// Pieces shared by the views: the header bar, the brand mark and the small-screen notice.

import { h } from '../ui/dom.js';

const SVG = 'http://www.w3.org/2000/svg';

export function brandMark(size = 28) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('brand-mark');
  const rect = document.createElementNS(SVG, 'rect');
  Object.entries({ x: 1, y: 1, width: 30, height: 30, rx: 8, fill: '#0066CC' }).forEach(([k, v]) => rect.setAttribute(k, String(v)));
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', 'M5 17h4l2.5-6 3.5 12 3-9 2 3h7');
  Object.entries({ fill: 'none', stroke: '#FFFFFF', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }).forEach(([k, v]) => path.setAttribute(k, String(v)));
  svg.append(rect, path);
  return svg;
}

/** The header bar. Administrators also get the way into the admin area (or, inside it, back to their recordings). */
export function appHeader(app, { title = '', admin = false } = {}) {
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
    me ? h('div.who', {},
      switcher,
      h('span.who-name', {}, `${me.annotator_id}${me.display_name ? ` · ${me.display_name}` : ''}`),
      h('button.btn.quiet', { type: 'button', 'data-log': 'sign-out', onclick: () => app.signOut() }, 'Sign out')) : null);
}

export function smallScreenNotice() {
  return h('div.small-screen', { role: 'note' },
    h('div.card', {}, brandMark(40),
      h('h1', {}, 'ElectroClean needs a computer screen'),
      h('p', {}, 'Annotating EEG needs room for the traces, a mouse or trackpad and a keyboard. Please open this page on a laptop or desktop computer, with the browser window at least 900 pixels wide.'),
      h('p.caption', {}, 'You can still sign in here; your work waits for you on the computer.')));
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
