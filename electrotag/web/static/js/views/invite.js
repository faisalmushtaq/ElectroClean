// The welcome of a private invitation link (?invite=<token>): the study asks whose link it is
// (POST /invite/check), the person sees the study and their annotator ID and chooses a password
// twice; the study sets it and signs them in (POST /invite/accept), so they land on their
// recordings. The passwords are never logged: the interaction log skips password fields, and it
// starts only after signing in.

import { h } from '../ui/dom.js';
import { signinFrame } from './signin.js';

function dateText(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * The welcome card, once the study has said whose invitation it is (`info`), or why it cannot be
 * used (`problem`, with the study's `code`). With `retry` the study could not be asked (no
 * connection, a study that is slow to start): the link may still be good, so the card offers to ask
 * again and keeps the link. A link that was used already leads to the sign-in; for one that expired or
 * is not known, the study's answer says whom to ask for a new one (signing in needs the password the
 * link sets), and the sign-in stays for someone who chose a password with an earlier link.
 */
export function inviteView(app, token, { info = null, problem = '', code = '', retry = false } = {}) {
  if (!info) {
    const again = retry ? h('button.btn.primary', { type: 'button', 'data-log': 'invite-retry', onclick: (e) => { e.currentTarget.disabled = true; app.showInvite(token); } }, 'Try again') : null;
    const used = code === 'invite_used';
    const card = h('div.card.signin-card.invite-card', { 'data-invite': retry ? 'unreachable' : 'problem' },
      h('h1', {}, retry ? 'The invitation could not be checked' : 'This link cannot be used'),
      h('div.banner', { role: 'alert' }, h('p', {}, problem || 'The invitation could not be checked. Try again in a moment.')),
      h('div.btn-row', {}, again, h(`button.btn${retry || !used ? '' : '.primary'}`, { type: 'button', onclick: () => app.leaveInvite() }, 'Go to sign in')),
      retry || used ? null : h('p.caption', {}, 'Go to sign in if you have already chosen a password with an earlier link.'));
    return signinFrame(app, card);
  }
  const pw = h('input.field', { type: 'password', id: 'invite-password', name: 'new-password', autocomplete: 'new-password', required: true, minlength: '8' });
  const again = h('input.field', { type: 'password', id: 'invite-password-again', name: 'new-password-again', autocomplete: 'new-password', required: true });
  const err = h('p.error', { role: 'alert', hidden: true });
  const submit = h('button.btn.primary.wide', { type: 'submit' }, 'Choose this password and start');
  const fail = (text) => { err.textContent = text; err.hidden = false; };
  const form = h('form.signin-form.invite-form', {
    novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      err.hidden = true;
      if (pw.value.length < 8) { fail('Choose a password of at least 8 characters.'); pw.focus(); return; }
      if (pw.value !== again.value) { fail('The two passwords are not the same. Type the same password twice.'); again.select(); return; }
      if (submit.disabled) return; // pressed again (or Enter) while the first press waits for the study
      submit.disabled = true;
      submit.textContent = 'Setting your password…';
      try {
        await app.acceptInvite(token, pw.value);
      } catch (exc) {
        fail(exc.message || 'The password could not be set. Please try again.');
        submit.disabled = false;
        submit.textContent = 'Choose this password and start';
      }
    },
  },
  // For password managers: the account the new password belongs to.
  h('input', { type: 'text', name: 'username', autocomplete: 'username', value: info.annotator_id, hidden: true, readonly: true, tabindex: '-1', 'aria-hidden': 'true' }),
  h('label.form-label', { for: 'invite-password' }, 'Choose a password'), pw,
  h('p.caption', {}, 'At least 8 characters. A short sentence is easy to remember and hard to guess.'),
  h('label.form-label', { for: 'invite-password-again' }, 'Type it again'), again,
  err, submit);
  const card = h('div.card.signin-card.invite-card', { 'data-invite': 'welcome' },
    h('h1', {}, 'Welcome'),
    h('p.subtitle', {}, `You are invited to take part in ${info.study_name || 'this study'}.`),
    h('div.invite-id', {}, h('span.caption', {}, 'Your annotator ID'), h('span.invite-id-value', {}, info.annotator_id),
      info.display_name ? h('span.caption', {}, info.display_name) : null),
    h('p', {}, 'You sign in with this ID and the password you choose now. The link works once', info.expires_at ? `, until ${dateText(info.expires_at)}` : '', '.'),
    // On a phone (shown by app.css only there): told before the link is used up.
    h('div.note.phone-note.invite-phone', { role: 'note' },
      h('p', {}, h('b', {}, 'Annotating needs a tablet or a computer. '),
        'You can choose your password here and then sign in on your tablet or computer with your annotator ID, ',
        'or open this link there instead: it works once.')),
    form);
  setTimeout(() => pw.focus(), 0);
  return signinFrame(app, card);
}
