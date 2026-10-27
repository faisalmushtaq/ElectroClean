"""Entry script shared by the three frozen ElectroClean executables.

PyInstaller builds ``ElectroClean`` (windowed), ``electroclean-agreement`` and
``electroclean-admin`` (console) from this one script, so that all three are
made from a single analysis and use exactly the same bundled modules. Each
executable runs the entry point matching its own file name; the names are set
in ``electroclean.spec`` and correspond to the console scripts declared in
``pyproject.toml``.
"""

from __future__ import annotations

import os
import sys


def _entry_point():  # noqa: ANN202
    name = os.path.splitext(os.path.basename(sys.executable))[0].lower()
    if name == "electroclean-agreement":
        from electroclean.reliability.cli import main
    elif name == "electroclean-admin":
        from electroclean.training.cli import main
    else:
        from electroclean.app.main import main
    return main


if __name__ == "__main__":
    sys.exit(_entry_point()())
