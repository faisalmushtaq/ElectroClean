"""The macOS/Linux launcher sets up, updates and repairs its private environment.

A copy of the launcher runs in a temporary folder with a stand-in
``electroclean`` package and a local (empty) ``wheels`` folder, so no network
access is needed. The Windows launcher uses the same helper
(launchers/check_environment.py) and is checked here only for the commands it
relies on.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]

pytestmark = pytest.mark.skipif(
    os.name == "nt" or shutil.which("bash") is None, reason="the shell launcher runs on macOS and Linux"
)


def _project(tmp_path: Path, requirements: str = "# nothing pinned\n") -> Path:
    root = tmp_path / "ElectroClean"
    (root / "launchers").mkdir(parents=True)
    for name in ("electroclean.sh", "check_environment.py"):
        shutil.copy(REPO / "launchers" / name, root / "launchers" / name)
    (root / "requirements.txt").write_text(requirements, encoding="utf-8")
    (root / "wheels").mkdir()  # offline installation from an empty local folder
    pkg = root / "electroclean"
    pkg.mkdir()
    (pkg / "__init__.py").write_text("", encoding="utf-8")
    (pkg / "__main__.py").write_text("import sys\nprint('ElectroClean started', *sys.argv[1:])\n", encoding="utf-8")
    return root


def _run(root: Path, *args: str) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    # The launcher must find a Python 3.12/3.13 of its own; use the one running the tests.
    env["PATH"] = str(Path(sys.executable).parent) + os.pathsep + env.get("PATH", "")
    env.pop("VIRTUAL_ENV", None)
    return subprocess.run(["bash", str(root / "launchers" / "electroclean.sh"), *args], cwd=root, env=env,
                          capture_output=True, text=True, timeout=300)


@pytest.mark.skipif(sys.version_info[:2] not in ((3, 12), (3, 13)), reason="the launcher accepts Python 3.12 and 3.13")
def test_setup_update_and_repair(tmp_path):
    root = _project(tmp_path)
    first = _run(root, "--version-test")
    assert first.returncode == 0, first.stdout + first.stderr
    assert "Setting up ElectroClean for first use" in first.stdout
    assert "ElectroClean started --version-test" in first.stdout
    marker = root / ".venv" / "electroclean-requirements.sha256"
    assert marker.is_file()

    second = _run(root)
    assert second.returncode == 0 and "Setting up" not in second.stdout and "Updating" not in second.stdout

    # An update of ElectroClean that changes requirements.txt reinstalls them.
    (root / "requirements.txt").write_text("# nothing pinned (version 2)\n", encoding="utf-8")
    third = _run(root)
    assert third.returncode == 0 and "Updating ElectroClean's Python environment" in third.stdout

    # An interrupted installation (no marker) is repaired at the next start.
    marker.unlink()
    fourth = _run(root)
    assert fourth.returncode == 0 and "Updating" in fourth.stdout and marker.is_file()


@pytest.mark.skipif(sys.version_info[:2] not in ((3, 12), (3, 13)), reason="the launcher accepts Python 3.12 and 3.13")
def test_failed_installation_removes_the_environment(tmp_path):
    root = _project(tmp_path, "electroclean-package-that-does-not-exist==1.0\n")
    res = _run(root)
    assert res.returncode == 1
    assert "Installation failed" in res.stdout and "next start tries again" in res.stdout
    assert not (root / ".venv").exists()


def test_check_environment_reports_missing_and_wrong_versions(tmp_path, monkeypatch):
    import importlib.util

    spec = importlib.util.spec_from_file_location("check_environment", REPO / "launchers" / "check_environment.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    req = tmp_path / "requirements.txt"
    import pytest as pt

    req.write_text(
        f"# comment\npytest=={pt.__version__}\nnot-a-real-package==1.0\npytest-other==0.1 ; python_version<'3'\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(mod, "REQUIREMENTS", req)
    monkeypatch.setattr(mod, "MARKER", tmp_path / "marker")
    found = mod.problems(marker=False)
    assert found == ["not-a-real-package is not installed", "pytest-other is not installed"]
    assert any("has not been installed" in p for p in mod.problems())
    mod.main(["x", "write"])
    assert mod.problems() == found


def test_windows_launcher_uses_the_same_checks():
    text = (REPO / "launchers" / "ElectroClean.bat").read_text(encoding="utf-8")
    assert "check_environment.py check\n" in text and "check_environment.py check-packages" in text
    assert "check_environment.py write" in text and "rmdir /s /q .venv" in text
