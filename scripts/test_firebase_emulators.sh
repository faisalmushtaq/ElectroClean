#!/usr/bin/env bash
# Runs the Firebase tests (tests/test_web_firestore.py) on the Firebase Emulator Suite: the Auth and
# Firestore emulators and the Python Cloud Functions in electroclean/web/firebase/functions.
#
#     scripts/test_firebase_emulators.sh [pytest options]
#
# Needs Node.js (for npx), Java 21 (for the Firestore emulator) and the test requirements
# (requirements-dev.txt). Nothing is sent to a real Firebase project: the project ID starts with
# "demo-", which the emulators keep entirely local. The functions' own environment
# (electroclean/web/firebase/functions/venv) is made on first use, and again when their
# requirements.txt changes.
set -euo pipefail
cd "$(dirname "$0")/.."
PY=${PYTHON:-python3}
FN=electroclean/web/firebase/functions
FIREBASE_TOOLS=firebase-tools@15.34.1
WANTED=$("$PY" -c "import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], 'rb').read()).hexdigest())" \
  "$FN/requirements.txt")
if [ ! -x "$FN/venv/bin/python" ] || [ "$(cat "$FN/venv/.requirements-sha256" 2>/dev/null)" != "$WANTED" ]; then
  [ -x "$FN/venv/bin/python" ] || "$PY" -m venv "$FN/venv"
  "$FN/venv/bin/python" -m pip install -q -r "$FN/requirements.txt"
  echo "$WANTED" > "$FN/venv/.requirements-sha256"
fi
"$PY" scripts/vendor_functions.py
export ELECTROCLEAN_FUNCTIONS_URL=http://127.0.0.1:5001/demo-electroclean/europe-west2
export QT_QPA_PLATFORM=offscreen
npx --yes "$FIREBASE_TOOLS" emulators:exec --only auth,firestore,functions --project demo-electroclean \
  "$PY -m pytest -q tests/test_web_firestore.py $*"
