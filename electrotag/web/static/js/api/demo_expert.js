// The expert area's operations in the sandbox (docs/web/api.md, "Experts"), as electrotag/web/expert.py
// does them on a server: `expert(op, body)` checks that the caller is an expert or an administrator and
// runs one operation of the registry below. Each part of the expert work brings its operations in a
// module of its own (demo_corrections.js, demo_tasks.js, ...), listed in PARTS with one line each; an
// operation is a function (expert, body) that returns the answer and may throw an ApiError.
//
// What the sandbox cannot do in the browser (conflicts and their adjudication need ElectroTag's Python
// code) is answered with the error that says a study server or Firebase is needed (needsServer).

import { ApiError } from './http.js';
import { needsServer } from './demo_admin.js';
import { rolesOf } from '../admin/model.js';
import { nowLocalIso } from '../util.js';
import { CORRECTION_FEEDBACK, CORRECTION_OPEN_OPS, CORRECTION_OPS } from './demo_corrections.js';
import { SNIPPET_EXPERT_OPS } from './demo_training_stages.js';

/** Replay consent: whether trainees may watch replays of the caller's own sessions (expert.py, the same names). */
const CONSENT_OPS = {
  replay_consent_get(x) { return x.consentAnswer(); },
  replay_consent_set(x, body) {
    if (typeof body.teaching !== 'boolean') {
      throw new ApiError(400, 'bad_request', 'teaching must be true (trainees may watch replays of your sessions) or false');
    }
    const aid = x.b._aid();
    const records = x.b.state.records || (x.b.state.records = {});
    const mine = records[aid] || (records[aid] = {});
    const before = mine.replay_consent && typeof mine.replay_consent === 'object' ? mine.replay_consent : null;
    const changed = !before || (before.teaching === true) !== body.teaching;
    if (changed) {
      mine.replay_consent = { teaching: body.teaching, changed_at: nowLocalIso() };
      x.b._admin._audit('replay_consent_set', `${aid} ${body.teaching ? 'agreed' : 'no longer agrees'} to trainees watching replays of their sessions`,
        { annotator_id: aid, teaching: body.teaching });
      x.b._save();
    }
    return { ...x.consentAnswer(), changed };
  },
};

/** The parts of the expert work in the sandbox: one line each. */
const PARTS = [
  CONSENT_OPS,
  CORRECTION_OPS, // corrections of saved work and replays (demo_corrections.js)
  SNIPPET_EXPERT_OPS, // the training path's snippets (demo_training_stages.js)
];

/** Operations that people without the expert role may ask for too (expert.py OPEN_OPS); each checks the rest itself. */
export const OPEN_EXPERT = new Set([...CORRECTION_OPEN_OPS]);
/** What GET /me/feedback lists, by part (expert.py FEEDBACK_PARTS): (expert) => [item]. */
export const FEEDBACK_PARTS = { ...CORRECTION_FEEDBACK };

/** Operations of the expert area that the sandbox answers with needsServer (their part has no stand-in). */
export const SERVER_ONLY_EXPERT = {};

/** Every operation of the registry, by name (a name is given once). */
export function expertOps(parts = PARTS) {
  const out = {};
  for (const part of parts) {
    for (const [name, fn] of Object.entries(part)) {
      if (out[name]) throw new Error(`The expert operation ${name} is given twice`);
      out[name] = fn;
    }
  }
  return out;
}

const OPS = expertOps();

export class DemoExpert {
  /** @param backend the DemoBackend whose state and accounts this works on */
  constructor(backend) {
    this.b = backend;
  }

  /** The caller's ID, when they are an expert or an administrator (403 forbidden otherwise). */
  actor() {
    const aid = this.b._aid();
    const u = this.b._admin.user(aid);
    const roles = u ? rolesOf(u) : [];
    if (!u || u.status !== 'active' || !(roles.includes('expert') || roles.includes('admin'))) {
      throw new ApiError(403, 'forbidden', 'Only the study\'s experts and administrators can use the expert area');
    }
    return aid;
  }

  consentAnswer() {
    const rec = ((this.b.state.records || {})[this.b._aid()] || {}).replay_consent;
    const r = (this.b._admin.s.settings || {}).replay || {};
    return {
      consent: { teaching: Boolean(rec && rec.teaching === true), changed_at: (rec && rec.changed_at) || null },
      replays: { enabled: r.enabled !== false, trainees_watch_experts: r.trainees_watch_experts !== false },
    };
  }

  async run(op, body = {}) {
    if (OPEN_EXPERT.has(op)) this.b._aid(); else this.actor();
    if (SERVER_ONLY_EXPERT[op]) throw needsServer(SERVER_ONLY_EXPERT[op]);
    const fn = OPS[op];
    if (typeof fn !== 'function') throw new ApiError(404, 'not_found', `This study does not offer the expert operation '${op}'`);
    const out = await fn(this, body && typeof body === 'object' ? body : {});
    return JSON.parse(JSON.stringify(out));
  }

  /** The items of one part of GET /me/feedback (corrections, adjudications), or [] for a part not offered here. */
  feedback(part) {
    const fn = FEEDBACK_PARTS[part];
    return fn ? JSON.parse(JSON.stringify(fn(this))) : [];
  }
}
