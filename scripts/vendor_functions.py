"""Copy the ElectroClean code the Cloud Functions need into their folder (run before deploying).

    python scripts/vendor_functions.py [functions_folder]

firebase.json runs this as the functions' predeploy step. Firebase uploads only the functions
folder, so the ``electroclean`` package is copied into it, without the activity analysis, the
browser application and the functions themselves. The copy is ignored by git.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DEFAULT = REPO / "electroclean" / "web" / "firebase" / "functions"
#: Left out of the copy (paths relative to the electroclean package).
EXCLUDE = (
    "activity",
    "web/static",
    "web/firebase/functions",
)


def vendor(dest_functions: Path = DEFAULT) -> Path:
    src = REPO / "electroclean"
    dest = Path(dest_functions) / "electroclean"
    if dest.exists():
        shutil.rmtree(dest)

    def ignore(folder: str, names: list[str]) -> list[str]:
        rel = Path(folder).resolve().relative_to(src.resolve())
        out = []
        for n in names:
            p = (rel / n).as_posix()
            if n == "__pycache__" or n.endswith((".pyc", ".pyo")) or any(p == e or p.startswith(e + "/")
                                                                        for e in EXCLUDE):
                out.append(n)
        return out

    shutil.copytree(src, dest, ignore=ignore)
    return dest


if __name__ == "__main__":
    where = vendor(Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT)
    print(f"Copied the ElectroClean code for the functions into {where}")
