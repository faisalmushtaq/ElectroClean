// Pieces shared by the views: the header bar, the brand mark, the icons and the small-screen notice.

import { h } from '../ui/dom.js';
import { CTRL, session } from '../util.js';

const SVG = 'http://www.w3.org/2000/svg';

/**
 * The ElectroTag mark: a stretch of EEG marked as an artifact, drawn as the application draws an
 * annotation (a shaded band with its two edges), in a rounded frame. icon.svg is the same drawing.
 * On the dark sign-in panel it is drawn in white with a lighter blue.
 */
export function brandMark(size = 28, ink = '#0D0D0D', accent = '#2B4392') {
  const svg = document.createElementNS(SVG, 'svg');
  Object.entries({ viewBox: '0 0 32 32', width: size, height: size, 'aria-hidden': 'true' }).forEach(([k, v]) => svg.setAttribute(k, String(v)));
  svg.classList.add('brand-mark');
  const part = (tag, attrs) => {
    const el = document.createElementNS(SVG, tag);
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, String(v)));
    svg.append(el);
  };
  part('rect', { x: 1.75, y: 1.75, width: 28.5, height: 28.5, rx: 7, fill: 'none', stroke: ink, 'stroke-width': 1.5 });
  part('rect', { x: 12, y: 6, width: 8.5, height: 20, fill: accent, 'fill-opacity': 0.22 });
  part('path', { d: 'M12 6v20M20.5 6v20', stroke: accent, 'stroke-width': 1.5 });
  part('path', { d: 'M4.5 18.5c1.2 0 1.6-2 2.6-2s1.3 2.4 2.4 2.4 1.2-1.4 2.5-1.4c1.6 0 1.8-7.5 4.2-7.5s2.6 7.5 4.3 7.5c1.2 0 1.3 1.4 2.4 1.4s1.4-2 2.5-2 1.5 1.6 2.1 1.6',
    fill: 'none', stroke: ink, 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
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

/**
 * The header bar. Administrators also get the way into the admin area, and experts into the expert area
 * (or, inside either, back to their recordings).
 */
export function appHeader(app, { title = '', admin = false, expert = false, tools = null } = {}) {
  const me = app.me;
  const study = me && me.study ? me.study.name : app.backend && app.backend.health ? app.backend.health.study : '';
  const switcher = admin || expert
    ? [h('button.btn.quiet.admin-switch', { type: 'button', 'data-log': admin ? 'leave-admin' : 'leave-expert', onclick: () => app.showHome() }, 'My recordings'),
      // an administrator in the expert area goes back to the admin area in one press
      expert && app.isAdmin ? h('button.btn.quiet.admin-switch', { type: 'button', 'data-log': 'expert-to-admin', onclick: () => app.showAdmin('admin') }, 'Admin') : null]
    : app.isAdmin
      ? h('button.btn.quiet.admin-switch', { type: 'button', 'data-log': 'admin', onclick: () => app.showAdmin('admin') }, 'Admin')
      : app.isExpert
        ? h('button.btn.quiet.admin-switch', { type: 'button', 'data-log': 'expert', onclick: () => app.showExpert('expert') }, 'Expert work')
        : null;
  return h('header.app-header', {},
    h('div.brand', {}, brandMark(26), h('span.brand-name', {}, 'ElectroTag'),
      study && !(app.backend && app.backend.isDemo) ? h('span.brand-study', {}, study) : null, title ? h('span.brand-study', {}, title) : null,
      admin ? h('span.chip.active.admin-chip', {}, 'Admin') : null,
      expert ? h('span.chip.active.admin-chip', {}, 'Expert') : null,
      app.backend && app.backend.isDemo ? h('span.chip.warning', {}, 'Demonstration') : null),
    tools,
    me ? h('div.who', {},
      switcher,
      h('span.who-name', {}, `${me.annotator_id}${me.display_name ? ` · ${me.display_name}` : ''}`),
      h('button.btn.quiet', { type: 'button', 'data-log': 'sign-out', onclick: () => app.signOut() }, 'Sign out')) : null);
}

/**
 * This page's address to open on another device: without the view's hash, and with the study
 * server's address when the page did not come from that server (?server=, as choose.js reads it).
 */
export function studyLink(app) {
  try {
    const url = new URL(location.href);
    url.hash = '';
    const b = app && app.backend;
    if (b && b.kind === 'server' && b.server && !url.searchParams.has('server')) {
      const base = new URL('.', url.href).href.replace(/\/+$/, '');
      if (b.server !== base) url.searchParams.set('server', b.server);
    }
    return url.href;
  } catch { return ''; }
}

/** A mailto: link that sends this page's address to oneself (the mail program asks for the address). */
export function emailLinkHref(app) {
  const link = studyLink(app);
  const study = app && app.me && app.me.study && app.me.study.name ? ` (${app.me.study.name})` : '';
  return `mailto:?subject=${encodeURIComponent(`ElectroTag${study}: open on a tablet or computer`)}` +
    `&body=${encodeURIComponent(`Open this link on a tablet or a computer to annotate:\n${link}`)}`;
}

/** Where the choice to carry on in a small window is kept, for this tab only (sessionStorage). */
const SMALL_OK_KEY = 'electrotag.small-screen-ok';

/** Carry on in a small window: the views come back (app.css lets body.small-screen-ok through the gate). */
export function allowSmallScreen() {
  session.set(SMALL_OK_KEY, true);
  document.body.classList.add('small-screen-ok');
}

/**
 * Shown instead of the views on a phone-sized screen (the gate in app.css), once someone has signed
 * in: annotating needs a tablet or a computer. It offers to email the page's address and to sign
 * out; administrators can go on to the admin area, which works on a phone. On a computer the window
 * may only look small because the page is zoomed in: the notice says how to make room, and Continue
 * in this window (shown where the pointer is a mouse or a trackpad) brings the views back for this
 * tab, which then scroll where they need more height.
 */
export function smallScreenNotice(app = null) {
  const me = app && app.me;
  if (session.get(SMALL_OK_KEY, false) && typeof document !== 'undefined') document.body.classList.add('small-screen-ok');
  return h('div.small-screen', { role: 'note' },
    h('div.card', {}, brandMark(40),
      h('h1', {}, 'ElectroTag needs a larger screen'),
      h('p', {}, 'Annotating EEG needs room for the traces, so it works on a tablet such as an iPad, or on a laptop or desktop computer. Your work waits for you there.'),
      me ? h('p.caption.small-screen-id', {}, `You are signed in as ${me.annotator_id}; sign in there with the same account.`) : null,
      h('p.caption.continue-small', {}, `If the page has been made larger with the browser's zoom, ${CTRL} and minus makes room again.`),
      me ? h('div.btn-row.center', {},
        h('a.btn.primary', { href: emailLinkHref(app), 'data-log': 'email-link' }, 'Email me this link'),
        h('button.btn.continue-small', { type: 'button', 'data-log': 'continue-small-screen', onclick: () => allowSmallScreen() }, 'Continue in this window'),
        app.isAdmin ? h('button.btn', { type: 'button', 'data-log': 'admin', onclick: () => app.showAdmin('admin') }, 'Open the admin area') : null,
        h('button.btn', { type: 'button', 'data-log': 'sign-out', onclick: () => app.signOut() }, 'Sign out')) : null,
      me && app.isAdmin ? h('p.caption', {}, 'The admin area works on a phone, to check the study\'s progress.') : null));
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
