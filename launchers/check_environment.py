"""Used by the launchers: is ElectroClean's private environment (.venv) complete and up to date?

    .venv/bin/python launchers/check_environment.py check            exit 0 if it is, 1 if it needs (re)installing
    .venv/bin/python launchers/check_environment.py check-packages   the same, ignoring the marker (after installing)
    .venv/bin/python launchers/check_environment.py write            record that requirements.txt has been installed

"Up to date" means two things. A marker file in .venv holds the SHA-256 of the
requirements.txt that was installed, so an update of ElectroClean that changes
requirements.txt reinstalls them. And every package pinned in requirements.txt
must be installed at exactly its pinned version, so an installation that was
interrupted (for example by a network failure) is repaired at the next start
instead of failing every time. Only the standard library is used.
"""

from __future__ import annotations

import hashlib
import re
import sys
from importlib import metadata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REQUIREMENTS = ROOT / "requirements.txt"
MARKER = ROOT / ".venv" / "electroclean-requirements.sha256"
_PIN = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*==\s*([^\s;#]+)")


def requirements_digest() -> str:
    return hashlib.sha256(REQUIREMENTS.read_bytes()).hexdigest()


def pinned() -> list[tuple[str, str]]:
    out = []
    for line in REQUIREMENTS.read_text(encoding="utf-8").splitlines():
        m = _PIN.match(line)
        if m:
            out.append((m.group(1), m.group(2)))
    return out


def problems(*, marker: bool = True) -> list[str]:
    found = []
    if marker:
        try:
            recorded = MARKER.read_text(encoding="ascii").strip()
        except OSError:
            recorded = ""
        if recorded != requirements_digest():
            found.append("requirements.txt has not been installed in this environment yet")
    for name, version in pinned():
        try:
            have = metadata.version(name)
        except metadata.PackageNotFoundError:
            found.append(f"{name} is not installed")
            continue
        if have != version:
            found.append(f"{name} {have} is installed but {version} is required")
    return found


def main(argv: list[str]) -> int:
    command = argv[1] if len(argv) > 1 else "check"
    if command == "write":
        MARKER.write_text(requirements_digest() + "\n", encoding="ascii")
        return 0
    if command in ("check", "check-packages"):
        issues = problems(marker=command == "check")
        for issue in issues[:5]:
            print(f"  {issue}")
        if len(issues) > 5:
            print(f"  ... and {len(issues) - 5} more")
        return 1 if issues else 0
    print(f"Unknown command {command!r}; use 'check', 'check-packages' or 'write'", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
