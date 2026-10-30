// Adjudication and the library in the sandbox (docs/web/api.md, "Adjudication and the library"):
// conflicts are found with ElectroTag's Python code (the agreement analysis's matching rules), which the
// browser does not have, so each of these operations answers that a study server or Firebase is needed
// (needsServer), in the sandbox's own words. demo_expert.js lists this part with one line.

import { needsServer } from './demo_admin.js';

/** The operations of electrotag/web/adjudication.py and library.py, by name. */
export const ADJUDICATION_OP_NAMES = Object.freeze(['adjudication_list', 'adjudication_get', 'adjudication_start', 'adjudication_decide',
  'adjudication_finish', 'adjudication_reopen', 'adjudication_reference', 'library_list', 'library_promote', 'tasks_list']);

const WHAT = 'compare annotators\' versions and adjudicate their disagreements';

export const ADJUDICATION_OPS = Object.freeze(Object.fromEntries(ADJUDICATION_OP_NAMES.map((op) => [op, () => { throw needsServer(WHAT); }])));
