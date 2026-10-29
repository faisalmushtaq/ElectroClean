"""The commands that remain now that ElectroTag runs in the browser, and the package without Qt.

``electrotag`` (or ``python -m electrotag``) names the tools and how to start the demonstration,
and runs each of them: ``electrotag web demo`` is ``electrotag-web demo``. The tools are also console
scripts of their own in pyproject.toml, and no module of the package, the browser version's server
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

from electrotag import __version__
from electrotag import cli as dispatcher
from electrotag.cli import TOOLS, main

REPO = Path(__file__).resolve().parents[1]
DESKTOP_PACKAGES = ("PySide6", "PySide2", "PyQt5", "PyQt6", "qtpy", "mne_qt_browser", "pyqtgraph", "shiboken6")


def scripts() -> dict[str, str]:
    data = tomllib.loads((REPO / "pyproject.toml").read_text(encoding="utf-8"))
    return data["project"]["scripts"]


def test_electrotag_alone_names_the_tools_and_the_demonstration(capsys):
    assert main([]) == 0
    out = capsys.readouterr().out
    assert out.startswith("usage: electrotag ")
    named = set(re.findall(r"^    ([a-z]+)\s{2,}", out, flags=re.MULTILINE))
    assert named == set(TOOLS)
    assert "electrotag web demo" in out and "http://localhost:8000/" in out
    assert __version__ in out and "electrotag web --help" in out
    for _module, alias, _help in TOOLS.values():
        assert alias in out  # the tools' own names are mentioned once


def test_every_tool_is_a_command_of_its_own_too():
    found = scripts()
    assert found.pop("electrotag") == "electrotag.cli:main"
    assert found == {alias: f"{module}:main" for module, alias, _help in TOOLS.values()}


def test_help_and_version_at_the_top(capsys):
    with pytest.raises(SystemExit) as info:
        main(["--help"])
    assert info.value.code == 0
    assert "electrotag web demo" in capsys.readouterr().out
    with pytest.raises(SystemExit) as info:
        main(["--version"])
    assert info.value.code == 0 and capsys.readouterr().out.strip() == f"ElectroTag {__version__}"


def test_an_unknown_tool_or_option_is_refused_in_plain_words(capsys):
    assert main(["agreemnt", "x"]) == 2
    err = capsys.readouterr().err
    assert "'agreemnt' is not one of the tools" in err and "web, agreement, admin, activity" in err
    with pytest.raises(SystemExit) as info:
        main(["--dataset", "x"])
    assert info.value.code == 2 and "--dataset" in capsys.readouterr().err


@pytest.mark.parametrize("tool", sorted(TOOLS))
def test_each_tool_explains_itself_under_its_name_in_electrotag(tool, capsys):
    with pytest.raises(SystemExit) as info:
        main([tool, "--help"])
    assert info.value.code == 0
    out = capsys.readouterr().out
    assert out.startswith(f"usage: electrotag {tool} ")
    assert TOOLS[tool][1] + " " not in out  # its examples use the name it was started by


def test_the_rest_of_the_line_goes_to_the_tool_unchanged(monkeypatch):
    seen = []

    def fake_main(argv, prog):
        seen.append((argv, prog))
        return 3

    monkeypatch.setattr(dispatcher, "tool_main", lambda name: fake_main)
    line = ["/data/Annotated_Events", "--out", "x", "--", "-odd-name", "--help"]
    assert main(["agreement", *line]) == 3
    assert seen == [(line, "electrotag agreement")]


def test_a_tools_own_errors_and_exit_status_come_through(tmp_path, capsys):
    assert main(["activity", str(tmp_path / "missing")]) == 2
    assert "Not found" in capsys.readouterr().err
    assert main(["web"]) == 2  # without a command the server's tool explains itself
    assert capsys.readouterr().out.startswith("usage: electrotag web ")


def test_python_m_electrotag_runs_as_a_module():
    res = subprocess.run([sys.executable, "-m", "electrotag"], capture_output=True, text=True, cwd=REPO,
                         timeout=120)
    assert res.returncode == 0 and "agreement" in res.stdout and "electrotag web demo" in res.stdout
    res = subprocess.run([sys.executable, "-m", "electrotag", "admin", "--help"], capture_output=True, text=True,
                         cwd=REPO, timeout=120)
    assert res.returncode == 0 and res.stdout.startswith("usage: electrotag admin ")


@pytest.mark.parametrize("name", sorted(scripts()))
def test_every_command_explains_itself(name, capsys):
    module, _, func = scripts()[name].partition(":")
    entry = getattr(importlib.import_module(module), func)
    with pytest.raises(SystemExit) as info:
        entry(["--help"])
    assert info.value.code == 0 and "usage:" in capsys.readouterr().out


def test_no_desktop_application_is_installed():
    data = tomllib.loads((REPO / "pyproject.toml").read_text(encoding="utf-8"))
    assert {target.partition(":")[0] for target in scripts().values()} <= {
        "electrotag.cli", *(module for module, _alias, _help in TOOLS.values())}
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
        "import electrotag\n"
        "names = [m.name for m in pkgutil.walk_packages(electrotag.__path__, 'electrotag.')]\n"
        "for name in names:\n"
        "    importlib.import_module(name)\n"
        f"print(json.dumps({{'modules': names, 'qt': [m for m in {DESKTOP_PACKAGES!r} if m in sys.modules]}}))\n"
    )
    res = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=REPO, timeout=300)
    assert res.returncode == 0, res.stderr[-2000:]
    found = json.loads(res.stdout.strip().splitlines()[-1])
    assert "electrotag.web.service" in found["modules"] and "electrotag.reliability.report" in found["modules"]
    removed = {"electrotag.app.gui", "electrotag.app.main", "electrotag.app.selftest",
               "electrotag.reliability.gui", "electrotag.training.gui", "electrotag.training.guided_gui"}
    assert not removed & set(found["modules"])
    assert found["qt"] == []
