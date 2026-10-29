// The sign-in view: an annotator ID (server and demonstration) or an email address (Firebase), the
// password, and where the study is.

import { h } from '../ui/dom.js';
import { brandMark } from './common.js';
import { montageFigure } from './montage.js';
import { eegArt } from './eegart.js';
import { inform } from '../ui/dialog.js';

export function signinView(app, { message = '', error = '' } = {}) {
  const b = app.backend;
  const where = app.where || {};
  const byEmail = b && b.signInWith === 'email';
  const idField = h('input.field', byEmail
    ? { type: 'email', id: 'signin-id', name: 'email', autocomplete: 'username', required: true, spellcheck: 'false' }
    : { type: 'text', id: 'signin-id', name: 'annotator_id', autocomplete: 'username', required: true, spellcheck: 'false', autocapitalize: 'characters' });
  const pw = h('input.field', { type: 'password', id: 'signin-password', name: 'password', autocomplete: 'current-password', required: true });
  const err = h('p.error', { role: 'alert', hidden: !error }, error);
  const submit = h('button.btn.primary.wide', { type: 'submit' }, 'Sign in');
  const form = h('form.signin-form', {
    novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      err.hidden = true;
      if (!b) return;
      if (!idField.value.trim() || !pw.value) {
        err.textContent = byEmail ? 'Enter your email address and password.' : 'Enter your annotator ID and password.';
        err.hidden = false;
        return;
      }
      submit.disabled = true;
      submit.textContent = 'Signing in…';
      try {
        await app.signIn(idField.value, pw.value);
      } catch (exc) {
        err.textContent = exc.message || 'Signing in did not work.';
        err.hidden = false;
        submit.disabled = false;
        submit.textContent = 'Sign in';
        pw.select();
      }
    },
  },
  h('label.form-label', { for: 'signin-id' }, byEmail ? 'Email address' : 'Annotator ID'), idField,
  h('label.form-label', { for: 'signin-password' }, 'Password'), pw,
  err, submit,
  byEmail ? h('button.link', { type: 'button', onclick: async () => {
    const email = idField.value.trim();
    if (!email) { err.textContent = 'Enter your email address first, then choose Forgot password?'; err.hidden = false; return; }
    try {
      await b.resetPassword(email);
      inform('Check your email', `If ${email} has an account for this study, a message with a link to choose a new password is on its way.`);
    } catch (exc) { err.textContent = exc.message; err.hidden = false; }
  } }, 'Forgot password?') : null);

  let studyLine;
  if (!b) studyLine = h('p.subtitle', {}, 'Connecting…');
  else if (b.isDemo) studyLine = h('p.subtitle', {}, 'Demonstration: everything stays in this browser.');
  else if (b.kind === 'firebase') studyLine = h('p.subtitle', {}, `Study: ${b.study || 'not named'}`);
  else studyLine = h('p.subtitle', {}, `Study: ${(b.health && b.health.study) || 'ElectroTag study'}`, h('br'), h('span.caption', {}, b.server || 'this site'));

  const demoHint = b && b.isDemo ? h('div.note.demo-hint', {},
    h('p', {}, 'Sign in as ', h('b', {}, 'A01'), ' to annotate, as ', h('b', {}, 'T01'), ' to follow the training programme, or as ',
      h('b', {}, 'ADMIN'), ' to run the study in the admin area. The password is ', h('b', {}, 'demo'), '.'),
    h('div.btn-row', {},
      h('button.btn.small', { type: 'button', onclick: () => { idField.value = 'A01'; pw.value = 'demo'; pw.focus(); } }, 'Fill in A01'),
      h('button.btn.small', { type: 'button', onclick: () => { idField.value = 'T01'; pw.value = 'demo'; pw.focus(); } }, 'Fill in T01'),
      h('button.btn.small', { type: 'button', onclick: () => { idField.value = 'ADMIN'; pw.value = 'demo'; pw.focus(); } }, 'Fill in ADMIN'))) : null;

  // Where the study is: the address of a study server (not for Firebase, which config.json names).
  let connect = null;
  if (where.kind !== 'firebase') {
    const addr = h('input.field', { type: 'url', id: 'study-address', name: 'study_address', placeholder: 'https://study.example.org', autocomplete: 'url', spellcheck: 'false', value: b && !b.isDemo ? b.server : '' });
    const cerr = h('p.error', { role: 'alert', hidden: true });
    const go = h('button.btn', { type: 'button', onclick: async () => {
      cerr.hidden = true;
      if (!addr.value.trim()) { cerr.textContent = 'Enter the address your study team gave you.'; cerr.hidden = false; return; }
      go.disabled = true;
      go.textContent = 'Connecting…';
      try {
        await app.connectTo(addr.value);
      } catch (exc) {
        cerr.textContent = exc.message;
        cerr.hidden = false;
        go.disabled = false;
        go.textContent = 'Connect';
      }
    } }, 'Connect');
    addr.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go.click(); } });
    const fields = h('div.connect-fields', {}, h('label.form-label', { for: 'study-address' }, 'Study address'), h('div.row', {}, addr, go), cerr,
      h('p.caption', {}, 'The address is in the link or email from your study team. It is remembered in this browser.'));
    if (b && !b.isDemo) {
      connect = h('details.connect', {}, h('summary', {}, 'Change the study address'), fields,
        h('p', {}, h('button.link', { type: 'button', onclick: () => app.useDemo() }, 'Try the demonstration instead')));
    } else {
      connect = h('details.connect', { open: Boolean(where.error) }, h('summary', {}, 'Taking part in a study? Enter its address'), fields);
    }
  }

  const problem = where.error ? h('div.banner', { role: 'alert' }, h('p', {}, where.error),
    h('div.btn-row', {}, h('button.btn.small', { type: 'button', onclick: () => location.reload() }, 'Try again'),
      h('button.btn.small', { type: 'button', onclick: () => app.useDemo() }, 'Try the demonstration instead'))) : null;

  // On a phone (the gate in app.css shows it): annotating needs a larger screen, the admin area does not.
  const phone = h('div.note.phone-note', { role: 'note' },
    h('p', {}, h('b', {}, 'Annotating needs a tablet or a computer. '),
      'A phone has no room for the EEG traces. Administrators can sign in here to check the study\'s progress.'));
  const card = h('div.card.signin-card', {},
    h('h1', {}, 'Sign in'), studyLine, phone,
    message ? h('p.success', { role: 'status' }, message) : null,
    problem, b ? form : null, demoHint, connect);
  setTimeout(() => (b ? idField : null)?.focus(), 0);
  return signinFrame(app, card);
}

/**
 * The sign-in page around a card: on the left, an illustration of EEG with the name and what
 * ElectroTag is for; on the right, the card (the sign-in form, or the welcome of an invitation).
 */
export function signinFrame(app, card) {
  const b = app.backend;
  const status = !b ? h('span.chip', {}, 'Connecting')
    : b.isDemo ? h('span.chip', {}, 'Demonstration')
      : h('span.chip', {}, b.kind === 'firebase' ? 'Study on Firebase' : 'Study server');
  const art = h('section.signin-art', {}, eegArt(),
    h('div.signin-art-inner', {},
      h('div.signin-status', {}, brandMark(28, '#FFFFFF'), status),
      h('div', {},
        h('p.signin-display', {}, 'ElectroTag'),
        h('p.signin-lede', {}, 'Artifact annotation for continuous EEG. ',
          h('span.tone-soft', {}, 'Your recordings stay on this computer, and only your annotations go to the study.'))),
      h('div.signin-foot', { 'aria-hidden': 'true' },
        h('p.figure-caption', {}, 'Fig. 01 · the 10-20 montage, 19 electrodes'), montageFigure())));
  const panel = h('section.signin-panel', {}, card,
    h('p.caption.footnote', {}, 'ElectroTag reads each recording in this browser, and the EEG stays on this computer: the study receives the recording\'s fingerprint and your annotations.'));
  return h('main.page.signin', { 'data-view': 'signin' }, h('div.signin-split', {}, art, panel));
}
