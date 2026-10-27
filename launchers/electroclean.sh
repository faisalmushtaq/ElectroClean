#!/usr/bin/env bash
# Start ElectroClean on macOS or Linux.
# On first use this creates a private Python environment in ElectroClean/.venv
# and installs the pinned dependencies (from ./wheels if that folder exists,
# otherwise from the internet). Afterwards it works offline. When requirements.txt
# changes (an update of ElectroClean), or an earlier installation was interrupted,
# the dependencies are installed again at the next start.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

find_python() {
  for c in python3.13 python3.12 python3; do
    if command -v "$c" >/dev/null 2>&1 \
      && "$c" -c 'import sys; sys.exit(0 if sys.version_info[:2] in ((3, 12), (3, 13)) else 1)'; then
      echo "$c"
      return 0
    fi
  done
  return 1
}

install_requirements() {
  if [ -d wheels ]; then
    .venv/bin/python -m pip install --no-index --find-links wheels -r requirements.txt
  else
    .venv/bin/python -m pip install --upgrade pip && .venv/bin/python -m pip install -r requirements.txt
  fi
}

failed() {
  echo
  echo "Installation failed: $1"
  echo "The partly installed environment has been removed, so the next start tries again from the beginning."
  echo "If it keeps failing, send the messages above to the study administrator."
  rm -rf .venv
  exit 1
}

if [ -x .venv/bin/python ] && .venv/bin/python launchers/check_environment.py check; then
  :  # up to date
else
  if [ -d .venv ]; then
    echo "Updating ElectroClean's Python environment..."
  else
    echo "Setting up ElectroClean for first use..."
  fi
  if ! { [ -x .venv/bin/python ] && .venv/bin/python -c "import sys" >/dev/null 2>&1; }; then
    rm -rf .venv
    PY="$(find_python)" || {
      echo "Python 3.12 or 3.13 was not found. Install it from https://www.python.org/downloads/ and try again."
      exit 1
    }
    "$PY" -m venv .venv || failed "the Python environment could not be created"
  fi
  install_requirements || failed "the packages in requirements.txt could not be installed"
  .venv/bin/python launchers/check_environment.py check-packages \
    || failed "the installed packages do not match requirements.txt"
  .venv/bin/python launchers/check_environment.py write
fi
# Run from the ElectroClean folder, so the package does not need to be installed.
exec .venv/bin/python -m electroclean "$@"
