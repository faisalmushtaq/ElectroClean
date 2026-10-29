// Pop-up menus: the right-click menu on annotations, the full type menu of the toolbar and the More
// menus. A menu takes the focus while it is open and gives it back to what opened it when it closes
// by Esc, by Tab or by a choice (a dialog opened by the choice then returns the focus there too); a
// press elsewhere closes it and leaves the focus where the press put it.

import { h } from './dom.js';
import { icon } from '../views/common.js';

let current = null;

export function closeMenu() {
  if (current) { current.close(); current = null; }
}

/** Give the focus back to the opener, when it is still on the page. */
function refocus(el) {
  if (el && el.isConnected) try { el.focus({ preventScroll: true }); } catch { /* gone */ }
}

/**
 * Show a menu at (x, y) (client coordinates). Items: {label, onSelect, shortcut, disabled, swatch, italic, title}
 * or {section: 'Heading'} or {separator: true} or {label, submenu: [items]}. `opener` is the control
 * that opened it, such as a More button, which takes the focus back; a menu opened on the EEG has none.
 */
export function showMenu(items, x, y, { className = '', minWidth = 0, opener = null } = {}) {
  closeMenu();
  const back = opener && typeof opener.focus === 'function' ? opener : null;
  const root = h(`div.menu${className ? '.' + className : ''}`, { role: 'menu', style: minWidth ? { minWidth: minWidth + 'px' } : {} });
  const entries = [];
  let submenu = null;
  let subOwner = null; // the item that opened the submenu, which takes the focus back when it closes
  const closeSub = () => { if (submenu) { submenu.remove(); submenu = null; } };
  const leaveSub = () => { const owner = subOwner; closeSub(); if (owner) owner.focus(); };
  const build = (container, list, isSub) => {
    for (const it of list) {
      if (it.separator) { container.appendChild(h('div.menu-sep', { role: 'separator' })); continue; }
      if (it.section) { container.appendChild(h('div.menu-section', {}, it.section)); continue; }
      const el = h(`button.menu-item${it.disabled ? '.disabled' : ''}${it.italic ? '.italic' : ''}${it.checked ? '.checked' : ''}`, {
        type: 'button', role: 'menuitem', disabled: Boolean(it.disabled), title: it.title || null, tabindex: '-1',
      },
      it.swatch ? h('span.swatch', { style: { background: it.swatch } }) : null,
      h('span.menu-label', {}, it.label),
      it.shortcut ? h('span.menu-shortcut', {}, it.shortcut) : null,
      it.submenu ? h('span.menu-arrow', {}, icon('chevron-right')) : null);
      if (it.submenu) {
        const open = () => {
          closeSub();
          submenu = h('div.menu.sub', { role: 'menu' });
          subOwner = el;
          build(submenu, it.submenu, true);
          document.body.appendChild(submenu);
          const r = el.getBoundingClientRect();
          place(submenu, r.right - 2, r.top - 4);
          const first = submenu.querySelector('.menu-item:not(.disabled)');
          if (first) first.focus();
        };
        el.addEventListener('mouseenter', open);
        el.addEventListener('click', open);
        el._open = open;
      } else {
        el.addEventListener('mouseenter', () => { if (!isSub) closeSub(); el.focus(); });
        el.addEventListener('click', () => {
          if (it.disabled) return;
          closeMenu();
          refocus(back); // before the choice, so that a dialog it opens returns the focus to the opener
          if (it.onSelect) it.onSelect();
        });
      }
      container.appendChild(el);
      if (!isSub) entries.push(el);
    }
  };
  build(root, items, false);
  document.body.appendChild(root);
  place(root, x, y);
  const onDown = (e) => {
    if (!root.contains(e.target) && !(submenu && submenu.contains(e.target))) closeMenu();
  };
  const onKey = (e) => {
    const active = document.activeElement;
    const list = submenu && submenu.contains(active)
      ? [...submenu.querySelectorAll('.menu-item:not(.disabled)')]
      : entries.filter((x) => !x.classList.contains('disabled'));
    const i = list.indexOf(active);
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (submenu && submenu.contains(active)) leaveSub(); else { closeMenu(); refocus(back); }
      return;
    }
    // Tab leaves the menu: it closes, and the focus moves on from the control that opened it.
    if (e.key === 'Tab') { closeMenu(); refocus(back); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); (list[i + 1] || list[0])?.focus(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); (list[i - 1] || list[list.length - 1])?.focus(); return; }
    if (e.key === 'ArrowRight' && active && active._open) { e.preventDefault(); e.stopPropagation(); active._open(); return; }
    if (e.key === 'ArrowLeft' && submenu) { e.preventDefault(); e.stopPropagation(); leaveSub(); return; }
    if (e.key === 'Enter' || e.key === ' ') { if (active && root.contains(active) || (submenu && submenu.contains(active))) { e.preventDefault(); e.stopPropagation(); active.click(); } return; }
    e.stopPropagation();
  };
  setTimeout(() => document.addEventListener('mousedown', onDown, true), 0);
  document.addEventListener('keydown', onKey, true);
  current = {
    el: root,
    close() {
      closeSub();
      root.remove();
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    },
  };
  const first = entries.find((x) => !x.classList.contains('disabled') && x.classList.contains('checked')) ||
    entries.find((x) => !x.classList.contains('disabled'));
  if (first) first.focus({ preventScroll: false });
  return current;
}

function place(el, x, y) {
  const r = el.getBoundingClientRect();
  const W = window.innerWidth;
  const H = window.innerHeight;
  el.style.left = Math.max(4, Math.min(x, W - r.width - 4)) + 'px';
  el.style.top = Math.max(4, Math.min(y, H - r.height - 4)) + 'px';
}
