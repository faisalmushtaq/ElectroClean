"""The commands that remain now that ElectroClean runs in the browser, and the package without Qt.

``python -m electroclean`` names the commands and how to start the demonstration; the commands are
the console scripts of pyproject.toml; and no module of the package, the browser version's server
included, needs a desktop toolkit.
"""

from __future__ import annotations

import importlib
import json
import re
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest

from electroclean import __version__
from electroclean.__main__ import main

REPO = Path(__file__).resolve().parents[1]
DESKTOP_PACKAGES = ("PySide6", "PySide2", "PyQt5", "PyQt6", "qtpy", "mne_qt_browser", "pyqtgraph", "shiboken6")


def scripts() -> dict[str, str]:
    data = tomllib.loads((REPO / "pyproject.toml").read_text(encoding="utf-8"))
    return data["project"]["scripts"]


def test_python_m_electroclean_names_the_commands_and_the_demonstration(capsys):
    assert main([]) == 0
    out = capsys.readouterr().out
    named = set(re.findall(r"^  (electroclean-[a-z]+)\s", out, flags=re.MULTILINE))
    assert named == set(scripts())  # every command, and only the commands that exist
    assert "electroclean-web demo" in out and "http://localhost:8000/" in out
    assert __version__ in out and "--help" in out
    assert main(["--help"]) == 0
    assert main(["--version"]) == 0 and capsys.readouterr().out.strip().endswith(__version__)


def test_anything_else_is_refused_in_plain_words(capsys):
    assert main(["--dataset", "x"]) == 2
    assert "is not something python -m electroclean can do" in capsys.readouterr().err


def test_python_m_electroclean_runs_as_a_module():
    res = subprocess.run([sys.executable, "-m", "electroclean"], capture_output=True, text=True, cwd=REPO,
                         timeout=120)
    assert res.returncode == 0 and "electroclean-agreement" in res.stdout


@pytest.mark.parametrize("name", sorted(scripts()))
def test_every_command_explains_itself(name, capsys):
    module, _, func = scripts()[name].partition(":")
    entry = getattr(importlib.import_module(module), func)
    with pytest.raises(SystemExit) as info:
        entry(["--help"])
    assert info.value.code == 0 and "usage:" in capsys.readouterr().out


def test_no_desktop_application_is_installed():
    assert "electroclean" not in scripts()
    data = tomllib.loads((REPO / "pyproject.toml").read_text(encoding="utf-8"))
    wanted = data["project"]["dependencies"] + [
        line for line in (REPO / "requirements.txt").read_text(encoding="utf-8").splitlines()
        if line and not line.startswith("#")]
    for dep in wanted:
        name = re.split(r"[=<>!~;\[ ]", dep, maxsplit=1)[0].lower()
        assert not name.startswith(("pyside", "pyqt", "qtpy", "mne-qt-browser", "pyqtgraph", "shiboken")), dep


def test_no_module_of_the_package_imports_a_desktop_toolkit():
    # A fresh interpreter, so that nothing imported by other tests counts.
    code = (
        "import importlib, json, pkgutil, sys\n"
        "import electroclean\n"
        "names = [m.name for m in pkgutil.walk_packages(electroclean.__path__, 'electroclean.')]\n"
        "for name in names:\n"
        "    importlib.import_module(name)\n"
        f"print(json.dumps({{'modules': names, 'qt': [m for m in {DESKTOP_PACKAGES!r} if m in sys.modules]}}))\n"
    )
    res = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=REPO, timeout=300)
    assert res.returncode == 0, res.stderr[-2000:]
    found = json.loads(res.stdout.strip().splitlines()[-1])
    assert "electroclean.web.service" in found["modules"] and "electroclean.reliability.report" in found["modules"]
    removed = {"electroclean.app.gui", "electroclean.app.main", "electroclean.app.selftest",
               "electroclean.reliability.gui", "electroclean.training.gui", "electroclean.training.guided_gui"}
    assert not removed & set(found["modules"])
    assert found["qt"] == []
