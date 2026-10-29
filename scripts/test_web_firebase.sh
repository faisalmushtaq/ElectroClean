#!/usr/bin/env bash
# Runs the browser application against a study on the Firebase Emulator Suite
# (web_tests/firebase_e2e.mjs): the Auth, Firestore and Functions emulators, the Python Cloud
# Functions in electrotag/web/firebase/functions, and Chromium through Playwright.
#
#     scripts/test_web_firebase.sh [--screenshots DIR]
#
# Needs what scripts/test_firebase_emulators.sh needs (Node.js, Java 21, requirements-dev.txt) and
# Playwright with Chromium. Nothing is sent to a real Firebase project: the project ID starts with
# "demo-", which the emulators keep entirely local.
set -euo pipefail
cd "$(dirname "$0")/.."
PY=${PYTHON:-python3}
FN=electrotag/web/firebase/functions
FIREBASE_TOOLS=firebase-tools@15.34.1
if [ ! -x "$FN/venv/bin/python" ]; then
  "$PY" -m venv "$FN/venv"
  "$FN/venv/bin/python" -m pip install -q -r "$FN/requirements.txt"
fi
"$PY" scripts/vendor_functions.py
export PYTHON="$PY"
npx --yes "$FIREBASE_TOOLS" emulators:exec --only auth,firestore,functions --project demo-electrotag \
  "node web_tests/firebase_e2e.mjs $*"
