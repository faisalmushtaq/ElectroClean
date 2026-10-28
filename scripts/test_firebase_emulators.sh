#!/usr/bin/env bash
# Runs the Firebase tests (tests/test_web_firestore.py) on the Firebase Emulator Suite: the Auth and
# Firestore emulators and the Python Cloud Functions in electroclean/web/firebase/functions.
#
#     scripts/test_firebase_emulators.sh [pytest options]
#
# Needs Node.js (for npx), Java 21 (for the Firestore emulator) and the test requirements
# (requirements-dev.txt). Nothing is sent to a real Firebase project: the project ID starts with
# "demo-", which the emulators keep entirely local.
set -euo pipefail
cd "$(dirname "$0")/.."
PY=${PYTHON:-python3}
FN=electroclean/web/firebase/functions
FIREBASE_TOOLS=firebase-tools@15.34.1
if [ ! -x "$FN/venv/bin/python" ]; then
  "$PY" -m venv "$FN/venv"
  "$FN/venv/bin/python" -m pip install -q -r "$FN/requirements.txt"
fi
"$PY" scripts/vendor_functions.py
export ELECTROCLEAN_FUNCTIONS_URL=http://127.0.0.1:5001/demo-electroclean/europe-west2
export QT_QPA_PLATFORM=offscreen
npx --yes "$FIREBASE_TOOLS" emulators:exec --only auth,firestore,functions --project demo-electroclean \
  "$PY -m pytest -q tests/test_web_firestore.py $*"
