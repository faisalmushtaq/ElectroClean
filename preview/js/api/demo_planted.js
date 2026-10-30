// Correct the marks in the sandbox (docs/web/api.md, "Correct the marks"): the study makes an exercise
// with ElectroTag's Python code (electrotag/training/planted.py), which the browser does not have, so the
// sandbox has one ready-made exercise, on the first guided recording of its training set, and lets an
// expert look at it and try it (js/expert/planted.js). Making, replacing and removing exercises answer
// that a study server or Firebase is needed. demo_expert.js lists this part with one line.
//
// READY_MADE is plant_errors(the recording's reference, seed 2026), written by
// web_tests/planted_parity.py; web_tests/unit/ui_planted.test.mjs checks that it still is.

import { ApiError } from './http.js';
import { needsServer } from './demo_admin.js';
import { TRAINING_SET } from './demo.js';
import { demoSpecs, truthAnnotations } from '../eeg/synthetic.js';

/** The words of electrotag/web/correct_marks.py INSTRUCTION. */
export const INSTRUCTION = 'Some of these marks are wrong and some artifacts are not marked. Look through the recording, correct '
  + 'the type, start, end or channels of any mark that is wrong, remove marks where there is no artifact '
  + 'and mark what is missing. Then press Save and Finish to see how you did.';

export const READY_MADE = Object.freeze({
  spec: 'demo-01', seed: 2026, counts: {"missing": 1, "type": 1, "boundary": 1, "extra": 1}, capped: false,
  annotations: [
    {"annotation_id": "5228d9fc7d93f7d94e2816435664bb85", "label": "Eye-blink-artifact", "onset_sample": 750, "duration_samples": 100, "channels": ["Fp1", "Fp2", "VEOG"]},
    {"annotation_id": "dd2548e54154116b3874c476263ef4bc", "label": "Movement-artifact", "onset_sample": 2300, "duration_samples": 400, "channels": ["F7", "F8", "T7", "T8"]},
    {"annotation_id": "afd6dda4d1d6bf17e19f1f89d228d651", "label": "Electrode-pops-artifact", "onset_sample": 3500, "duration_samples": 125, "channels": ["C3"]},
    {"annotation_id": "a278a4ed1af71f76f8ffd542aa242392", "label": "Horizontal-eye-movement-artifact", "onset_sample": 4665, "duration_samples": 135, "channels": ["Fp1", "Fp2", "F7", "F8", "HEOG"]},
    {"annotation_id": "e11e300c03d2007226877c52fb23fb41", "label": "Eye-blink-artifact", "onset_sample": 8800, "duration_samples": 95, "channels": ["Fp1", "Fp2", "VEOG"]},
    {"annotation_id": "b94f61d97fa24fc7a1c8ae1440f6a322", "label": "EMG-artifact", "onset_sample": 9412, "duration_samples": 400, "channels": ["F7", "F8", "T7", "T8"]},
  ],
  errors: [
    {"kind": "missing", "reference_id": "demo01ref00400000000000000000000", "planted_id": null, "label": "Movement-artifact", "onset_sample": 6000, "end_sample": 6500, "detail": "The Movement-artifact at 24.00–26.00 s was left out."},
    {"kind": "type", "reference_id": "demo01ref00100000000000000000000", "label": "EMG-artifact", "planted_label": "Movement-artifact", "onset_sample": 2300, "end_sample": 2700, "detail": "The EMG-artifact at 9.20–10.80 s was marked as Movement-artifact.", "planted_id": "dd2548e54154116b3874c476263ef4bc"},
    {"kind": "boundary", "reference_id": "demo01ref00300000000000000000000", "label": "Horizontal-eye-movement-artifact", "edge": "start", "shift_s": 0.66, "onset_sample": 4500, "end_sample": 4800, "planted_onset_sample": 4665, "planted_end_sample": 4800, "detail": "The start of the Horizontal-eye-movement-artifact at 18.00–19.20 s was moved 0.66 s later.", "planted_id": "a278a4ed1af71f76f8ffd542aa242392"},
    {"kind": "extra", "reference_id": null, "planted_id": "b94f61d97fa24fc7a1c8ae1440f6a322", "label": "EMG-artifact", "onset_sample": 9412, "end_sample": 9812, "detail": "An EMG-artifact was added at 37.65–39.25 s, where the experts marked nothing."},
  ],
});

const SPEC = demoSpecs().find((s) => s.id === READY_MADE.spec);
const round4 = (x) => Math.round(x * 1e4) / 1e4;
const wire = ({ annotation_id, label, onset_sample, duration_samples, channels }) => ({ annotation_id, label, onset_sample, duration_samples, channels: [...channels] });

/** The guided recording of the ready-made exercise (the first of the training set). */
export const READY_RID = TRAINING_SET.guided[0].rid;

function plantedOut() {
  const sf = SPEC.sfreq;
  return {
    annotations: READY_MADE.annotations.map((a) => ({ ...a, channels: [...a.channels] })),
    errors: READY_MADE.errors.map((e) => ({ ...e, onset_s: round4(e.onset_sample / sf), offset_s: round4(e.end_sample / sf) })),
    n_errors: READY_MADE.errors.length, seed: READY_MADE.seed, counts: { ...READY_MADE.counts }, capped: READY_MADE.capped, notes: [],
    method: 'auto', made_by: 'ElectroTag', made_at: '2026-10-30T10:00:00.000+00:00', stale: false,
  };
}

/** The guided recording asked for, refused as electrotag/web/correct_marks.py refuses it. */
function guided(body) {
  if (typeof body.set_id !== 'string' || !body.set_id) throw needsServerOr400('set_id is missing');
  if (typeof body.recording_id !== 'string' || !body.recording_id.trim()) throw needsServerOr400('recording_id is missing');
  if (body.set_id !== TRAINING_SET.set_id) throw needsServer('make exercises in other training sets');
  const rid = body.recording_id.trim();
  if (TRAINING_SET.practice.includes(rid)) {
    throw new ApiError(409, 'not_guided', `Correct the marks uses a recording for learning with the experts (guided); ${rid} is used for practice. `
      + 'Change what it is used for in Training first.');
  }
  if (!TRAINING_SET.guided.some((g) => g.rid === rid)) throw new ApiError(404, 'not_in_set', `${rid} is not one of the recordings of ${TRAINING_SET.name}`);
  return rid;
}

function needsServerOr400(message) { return new ApiError(400, 'bad_request', message); }

const WHAT = 'make, replace or remove correct-the-marks exercises (the sandbox has one ready-made exercise to try)';

export const PLANTED_OPS = Object.freeze({
  async planted_list(x) {
    const rows = TRAINING_SET.guided.map((g) => {
      const spec = demoSpecs().find((s) => g.rid.includes(s.stem));
      return { recording_id: g.rid, n_reference: spec ? truthAnnotations(spec).length : 0,
        planted: g.rid === READY_RID ? { n_errors: READY_MADE.errors.length, seed: READY_MADE.seed, method: 'auto', made_by: 'ElectroTag',
          made_at: '2026-10-30T10:00:00.000+00:00', capped: READY_MADE.capped, stale: false } : null };
    });
    return { sets: [{ set_id: TRAINING_SET.set_id, name: TRAINING_SET.name, recordings: rows }] };
  },
  async planted_get(x, body) {
    const rid = guided(body);
    const spec = demoSpecs().find((s) => rid.includes(s.stem));
    const manifest = await x.b._publicManifest(rid);
    return { set_id: TRAINING_SET.set_id, set_name: TRAINING_SET.name, recording_id: rid, file_name: manifest.file_name, manifest,
      reference: truthAnnotations(spec).map(wire), tolerance: x.b._tolerance(), planted: rid === READY_RID ? plantedOut() : null,
      done_by: 0, instruction: INSTRUCTION };
  },
  set_planted_make() { throw needsServer(WHAT); },
  set_planted_from() { throw needsServer(WHAT); },
  set_planted_remove() { throw needsServer(WHAT); },
});
