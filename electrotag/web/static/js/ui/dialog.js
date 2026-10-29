// In-page dialogs (the application never uses alert, confirm or prompt: they do not work in every
// page, and they cannot be styled or logged).

import { h } from './dom.js';

let openCount = 0;
let logger = null;

/** The interaction logger records every dialog shown and closed (title and button only). */
export function setDialogLogger(l) { logger = l; }

/** Presses this soon after a dialog opened belong to the press that opened it (a double click). */
const DOUBLE_PRESS_MS = 500;

export function dialogOpen() { return openCount > 0; }

/**
 * Show a modal dialog. `buttons` is a list of {label, value, kind: 'primary'|'destructive'|'quiet'}.
 * Resolves with the chosen button's value, or `cancelValue` on Esc or a click outside. The focus
 * goes back to `returnFocus`, or to what had it when the dialog opened, when that is still on the page.
 */
export function showDialog({ title, body, buttons = [{ label: 'OK', value: true, kind: 'primary' }], cancelValue = null,
  wide = false, className = '', onOpen = null, dismissable = true, logText = null, returnFocus = null }) {
  return new Promise((resolve) => {
    const prev = returnFocus || document.activeElement;
    const content = typeof body === 'string' ? h('p.dialog-text', {}, body) : body;
    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      openCount -= 1;
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      if (logger) logger.event('dialog_closed', { dialog: className || 'message', title, button: buttons.find((b) => b.value === value)?.label ?? null, result: typeof value === 'string' ? value : value === null ? null : String(value) });
      if (prev && prev.focus && prev.isConnected) try { prev.focus({ preventScroll: true }); } catch { /* gone */ }
      resolve(value);
    };
    const btns = buttons.map((b) => h(`button.btn${b.kind ? '.' + b.kind : ''}`, {
      type: 'button', onclick: () => close(b.value), 'data-value': String(b.value),
    }, b.label));
    const box = h(`div.dialog${wide ? '.wide' : ''}${className ? '.' + className : ''}`, { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      title ? h('h2.dialog-title', {}, title) : null,
      h('div.dialog-body', {}, content),
      buttons.length ? h('div.dialog-buttons', {}, btns) : null);
    // A press outside closes the dialog, except straight after it opened: the second press of a
    // double click on the button that opened it would otherwise close it at once.
    const openedAt = Date.now();
    const overlay = h('div.dialog-overlay', {
      onmousedown: (e) => { if (e.target === overlay && dismissable && Date.now() - openedAt > DOUBLE_PRESS_MS) close(cancelValue); },
    }, box);
    const onKey = (e) => {
      if (e.key === 'Escape' && dismissable) { e.preventDefault(); e.stopPropagation(); close(cancelValue); return; }
      if (e.key === 'Tab') { // keep the focus inside the dialog
        const f = [...box.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled);
        if (!f.length) return;
        const i = f.indexOf(document.activeElement);
        if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
      // Other keys go on to the dialog's own fields; the application's keys check dialogOpen().
    };
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    openCount += 1;
    if (logger) logger.event('dialog_shown', { dialog: className || 'message', title, buttons: buttons.map((b) => b.label), ...(logText ? { text: logText } : {}) });
    const primary = btns.find((_, i) => buttons[i].kind === 'primary') || btns[0];
    if (onOpen) onOpen({ box, close });
    if (!box.contains(document.activeElement) && primary) primary.focus();
  });
}

/** Ask a yes/no question; resolves true for the first button. */
export async function ask(title, text, { yes = 'Yes', no = 'No', defaultYes = true, destructive = false } = {}) {
  const body = h('div', {}, String(text).split('\n\n').map((p) => h('p.dialog-text', {}, p)));
  const buttons = defaultYes
    ? [{ label: no, value: false }, { label: yes, value: true, kind: destructive ? 'destructive' : 'primary' }]
    : [{ label: yes, value: true, kind: destructive ? 'destructive' : '' }, { label: no, value: false, kind: 'primary' }];
  return Boolean(await showDialog({ title, body, buttons, cancelValue: false, logText: String(text) }));
}

export function inform(title, text) {
  const body = h('div', {}, String(text).split('\n\n').map((p) => h('p.dialog-text', {}, p)));
  return showDialog({ title, body, buttons: [{ label: 'OK', value: true, kind: 'primary' }], cancelValue: true, logText: String(text) });
}

/** Several choices; resolves with the chosen label (the last one if the dialog is closed). */
export async function choose(title, text, options, defaultIndex = 0) {
  const body = h('div', {}, String(text).split('\n\n').map((p) => h('p.dialog-text', {}, p)));
  const buttons = options.map((o, i) => ({ label: o, value: o, kind: i === defaultIndex ? 'primary' : '' }));
  return showDialog({ title, body, buttons, cancelValue: options[options.length - 1], logText: String(text) });
}
