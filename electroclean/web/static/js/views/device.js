// Recordings kept on this device (js/data/device_store.js), as the annotator sees them: the choices
// remembered for each annotator, keeping a copy when a recording opens, reopening it, the panel
// "Recordings on this device" with its removals, removing a recording when it is finished, and the
// offer at signing out. The interaction log records what happened with sizes and counts, never
// file names or links.

import { h, clear } from '../ui/dom.js';
import { ask, showDialog } from '../ui/dialog.js';
import { logger } from '../log/logger.js';
import { local } from '../util.js';
import { formatBytes } from '../data/links.js';
import { DeviceStore, DeviceStoreError, ownerKey, finishedState, finishedToRemove, summarise } from '../data/device_store.js';

const DEFAULT_PREFS = Object.freeze({ keepLinks: true, keepChosen: false, removeWhenFinished: false });

/** The store of the signed-in annotator in this study (null before signing in). */
export function deviceStore(app) {
  if (!app.me || !app.backend) return null;
  const study = app.me.study || {};
  const owner = ownerKey({ backend: app.backend.kind || '', studyId: study.study_id || study.name || '', annotatorId: app.me.annotator_id || '' });
  if (!app._deviceStore || app._deviceStore.owner !== owner) app._deviceStore = new DeviceStore({ owner });
  return app._deviceStore;
}

/** The annotator's choices, remembered in this browser (localStorage; defaults when it is blocked). */
export function devicePrefs(app) {
  const store = deviceStore(app);
  const key = `electroclean.device.${store ? store.owner : ''}`;
  const saved = local.get(key, {}) || {};
  const prefs = { ...DEFAULT_PREFS, ...saved };
  return {
    get: (name) => prefs[name],
    set: (name, value) => { prefs[name] = Boolean(value); local.set(key, prefs); },
  };
}

/** A remembered tick box. */
function prefCheck(app, name, text, logName) {
  const prefs = devicePrefs(app);
  const box = h('input', { type: 'checkbox', name: logName, 'data-log': logName, onchange: () => prefs.set(name, box.checked) });
  box.checked = Boolean(prefs.get(name));
  return { el: h('label.check', {}, box, h('span', {}, text)), box };
}

const CANNOT_KEEP = 'This browser cannot keep recordings on this device (in a private window, for example).';

/** A keeping tick box that gives way to a plain sentence where the browser refuses to store files. */
function keepCheck(app, name, text, logName) {
  const c = prefCheck(app, name, text, logName);
  deviceStore(app).usable().then((ok) => {
    if (ok) return;
    c.box.checked = false;
    c.el.replaceWith(h('p.caption.device-cannot', {}, CANNOT_KEEP));
  });
  return c;
}

// ------------------------------------------------------------------------- the open view
/** The tick box under the link field: keep what is fetched from a link. */
export function keepLinkCheck(app) {
  return deviceStore(app) && deviceStore(app).available
    ? keepCheck(app, 'keepLinks', 'Keep a copy on this device, so that it opens again without downloading', 'keep-link') : null;
}

/** The row under the drop zone: keep chosen files too, and the way to the panel. */
export function deviceRow(app, onChange = null) {
  const store = deviceStore(app);
  if (!store || !store.available) return { el: null, box: null };
  const c = keepCheck(app, 'keepChosen', 'Also keep files I choose here on this device', 'keep-chosen');
  const el = h('div.device-row', {}, c.el,
    h('button.btn.quiet', { type: 'button', 'data-log': 'device-manage', onclick: async () => { await showDevicePanel(app); if (onChange) onChange(); } }, 'Recordings on this device…'));
  return { el, box: c.box };
}

/**
 * Keep the files of a recording that has just opened, when the annotator asked for it (in the
 * background: the recording is already open from memory). A full device is told once, with the
 * offer to remove finished recordings.
 */
export async function keepOnDevice(app, recording, match, sha) {
  const src = recording && recording.source;
  const store = deviceStore(app);
  if (!src || !src.keep || !store || !store.available || !recording.sourceFiles || !/^[0-9a-f]{64}$/.test(sha || '')) return;
  if (!(await store.usable())) return;
  try {
    const first = (await store.list()).length === 0;
    const meta = await store.keep({ sha256: sha, recordingId: match.recording_id, fileName: recording.fileName, files: recording.sourceFiles });
    logger.event('device_kept', { files: meta.files.length, size_bytes: meta.size, source: src.kind, store: store.kind });
    if (first) {
      const granted = await DeviceStore.persist();
      logger.event('device_persist', { granted });
    }
  } catch (e) {
    if (e instanceof DeviceStoreError && e.kind === 'full') {
      const size = recording.sourceFiles.reduce((a, f) => a + f.size, 0);
      logger.event('device_full', { size_bytes: size });
      await offerRoomDialog(app, size);
    } else {
      app.deviceProblem = `${e && e.name}: ${e && e.message}`; // for the browser tests
      logger.event('device_keep_failed', { reason: String(e && e.name || 'error') });
    }
  }
}

async function offerRoomDialog(app, size) {
  const store = deviceStore(app);
  const kept = await store.list().catch(() => []);
  const { remove, bytes } = finishedToRemove(kept, app.assignments && app.assignments.items);
  const text = `The recording is open, but this device has no room to keep a copy of it (${formatBytes(size)}).`
    + (remove.length ? ` Removing the ${remove.length === 1 ? 'recording' : `${remove.length} recordings`} you have finished frees ${formatBytes(bytes)}. Your annotations and results are not affected.` : '');
  const buttons = remove.length
    ? [{ label: 'Not now', value: false }, { label: 'Remove finished recordings', value: true, kind: 'primary' }]
    : [{ label: 'OK', value: false, kind: 'primary' }];
  const yes = await showDialog({ title: 'This device is full', body: h('div', {}, h('p.dialog-text', {}, text)), buttons, cancelValue: false, className: 'device-full' });
  if (yes) {
    const r = await store.removeMany(remove);
    logger.event('device_removed', { reason: 'finished', count: r.count, size_bytes: r.bytes });
  }
}

/**
 * The kept copy of the recording the open view expects, if there is one: the files to open
 * (checked again against their fingerprint as they open), or a plain message when the copy is gone.
 * @returns {Promise<{files: File[], meta: object} | {problem: string} | null>}
 */
export async function keptCopy(app, recordingId) {
  const store = deviceStore(app);
  if (!store || !store.available || !recordingId) return null;
  let meta;
  try { meta = await store.findByRecording(recordingId); } catch { return null; }
  if (!meta) return null;
  try {
    const got = await store.open(meta.sha256);
    if (!got) return { problem: 'The copy of this recording kept on this device is no longer there (the browser may have cleared it). Choose the file, or open its link again.' };
    logger.event('device_opened', { files: got.files.length, size_bytes: got.meta.size });
    return got;
  } catch (e) {
    logger.event('device_removed', { reason: 'broken', count: 1, size_bytes: meta.size || 0 });
    return { problem: 'The copy of this recording kept on this device could not be read, so it has been removed. Choose the file, or open its link again.' };
  }
}

/** The copy turned out not to be the recording it was kept as: remove it. */
export async function dropBrokenCopy(app, sha256) {
  const store = deviceStore(app);
  if (!store) return;
  await store.remove(sha256).catch(() => {});
  logger.event('device_removed', { reason: 'broken', count: 1 });
}

// ------------------------------------------------------------------------------ the panel
/** "Recordings on this device": what is kept, the space, and the removals. */
export async function showDevicePanel(app) {
  const store = deviceStore(app);
  if (!store) return;
  const body = h('div.device-panel');
  let confirm = null; // {what: 'finished'|'all'}
  const render = async () => {
    const kept = await store.list().catch(() => []);
    const items = (app.assignments && app.assignments.items) || [];
    const state = finishedState(kept, items);
    const total = summarise(kept);
    const est = await DeviceStore.estimate();
    clear(body);
    body.append(h('p.dialog-text', {}, 'Copies of recordings you opened, kept in this browser so that they open again without downloading. '
      + 'Removing a copy never touches your annotations, drafts or results, which the study keeps.'));
    if (!kept.length) body.append(h('p.caption.device-empty', {}, 'No recordings are kept on this device.'));
    else {
      const STATE = { done: ['Finished', '.done'], open: ['Not finished', '.active'], other: ['Not one of your recordings now', ''] };
      body.append(h('table.list.device-list', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Recording'), h('th.num', {}, 'Size'), h('th', {}, 'Status'), h('th', {}))),
        h('tbody', {}, kept.map((k, i) => h('tr', {},
          h('td', {}, h('span.file', {}, k.fileName)),
          h('td.num', {}, formatBytes(k.size)),
          h('td', {}, h(`span.chip${STATE[state[i]][1]}`, {}, STATE[state[i]][0])),
          h('td.actions', {}, h('button.btn.small', { type: 'button', 'data-log': 'device-remove-one', onclick: async () => {
            await store.remove(k.sha256);
            logger.event('device_removed', { reason: 'one', count: 1, size_bytes: k.size || 0 });
            await render();
          } }, 'Remove')))))));
    }
    const space = est && est.quota ? ` This site uses ${formatBytes(est.usage)} of this browser's storage; about ${formatBytes(Math.max(0, est.quota - est.usage))} more is available.` : '';
    body.append(h('p.caption', {}, `${total.count} ${total.count === 1 ? 'recording' : 'recordings'}, ${formatBytes(total.bytes)}.${space}`));
    const fin = finishedToRemove(kept, items);
    const actions = h('div.btn-row');
    if (confirm) {
      const all = confirm.what === 'all';
      const n = all ? total.count : fin.remove.length;
      const bytes = all ? total.bytes : fin.bytes;
      actions.append(h('p.dialog-text.device-confirm', {}, `Remove ${all ? 'all' : 'the'} ${n} ${all ? '' : 'finished '}${n === 1 ? 'recording' : 'recordings'} from this device? This frees ${formatBytes(bytes)}. Your annotations and results are not affected.`),
        h('button.btn', { type: 'button', 'data-log': 'device-confirm-no', onclick: () => { confirm = null; render(); } }, 'Cancel'),
        h('button.btn.destructive', { type: 'button', 'data-log': 'device-confirm-yes', onclick: async () => {
          const r = await store.removeMany(all ? kept : fin.remove);
          logger.event('device_removed', { reason: all ? 'all' : 'finished', count: r.count, size_bytes: r.bytes });
          confirm = null;
          await render();
        } }, all ? 'Remove all' : 'Remove finished recordings'));
    } else {
      actions.append(
        h('button.btn', { type: 'button', 'data-log': 'device-remove-finished', disabled: !fin.remove.length, onclick: () => { confirm = { what: 'finished' }; render(); } },
          'Remove finished recordings'),
        h('button.btn', { type: 'button', 'data-log': 'device-remove-all', disabled: !kept.length, onclick: () => { confirm = { what: 'all' }; render(); } }, 'Remove all'));
    }
    body.append(actions, prefCheck(app, 'removeWhenFinished', 'Remove a recording from this device when I finish it', 'device-remove-when-finished').el);
  };
  await render();
  await showDialog({ title: 'Recordings on this device', body, wide: true, className: 'device', buttons: [{ label: 'Close', value: true, kind: 'primary' }], cancelValue: true });
}

/** The home page's line: "3 recordings kept on this device, 1.2 GB. Manage" (nothing when none). */
export function deviceHomeLine(app) {
  const line = h('p.caption.device-line', { hidden: true });
  const fill = async () => {
    const store = deviceStore(app);
    if (!store || !store.available) return;
    const kept = await store.list().catch(() => []);
    clear(line);
    line.hidden = !kept.length;
    if (!kept.length) return;
    const s = summarise(kept);
    line.append(`${s.count} ${s.count === 1 ? 'recording' : 'recordings'} kept on this device, ${formatBytes(s.bytes)}. `,
      h('button.link', { type: 'button', 'data-log': 'device-manage', onclick: async () => { await showDevicePanel(app); fill(); } }, 'Manage'));
  };
  fill();
  return line;
}

// --------------------------------------------------------------- finishing and signing out
/** After Save and Finish has succeeded: remove the copy if the annotator asked for that. */
export async function afterFinishOnDevice(app, recordingId) {
  const store = deviceStore(app);
  if (!store || !store.available || !devicePrefs(app).get('removeWhenFinished')) return;
  const kept = (await store.list().catch(() => [])).filter((k) => k.recordingId === recordingId);
  if (!kept.length) return;
  // only when nothing else of the annotator's still needs this recording
  const { remove } = finishedToRemove(kept, app.assignments && app.assignments.items);
  if (!remove.length) return;
  const r = await store.removeMany(remove);
  logger.event('device_removed', { reason: 'finished_recording', count: r.count, size_bytes: r.bytes });
}

/** At signing out: offer to remove this person's kept recordings (keeping them is the default). */
export async function offerRemovalAtSignOut(app) {
  const store = deviceStore(app);
  if (!store || !store.available) return;
  const kept = await store.list().catch(() => []);
  if (!kept.length) return;
  const s = summarise(kept);
  const keep = await ask('Recordings on this device',
    `${s.count} ${s.count === 1 ? 'recording is' : 'recordings are'} kept on this device for you (${formatBytes(s.bytes)}).\n\n`
    + 'On your own device you can keep them, to open them again without downloading. On a computer that others use, remove them.',
    { yes: 'Keep them', no: 'Remove them' });
  if (keep) return;
  const r = await store.removeMany(kept);
  logger.event('device_removed', { reason: 'sign_out', count: r.count, size_bytes: r.bytes });
}
