"""The installation self-test (``electroclean --self-test``) used to check the frozen applications."""

from __future__ import annotations

import pytest

pytest.importorskip("PySide6")
pytest.importorskip("pybv")

from electroclean.app.main import main  # noqa: E402

pytestmark = [pytest.mark.gui, pytest.mark.slow]


def test_self_test_passes_and_writes_log(tmp_path, capsys):
    log = tmp_path / "selftest.log"
    assert main(["--self-test", str(log)]) == 0
    text = log.read_text(encoding="utf-8")
    assert "ElectroClean self-test passed" in text
    assert "ElectroClean self-test passed" in capsys.readouterr().out


def test_self_test_needs_nothing_from_the_browser_version(tmp_path, monkeypatch):
    """The stand-alone applications leave out electroclean.web and the packages it needs (FastAPI,
    Firebase), so the self-test must pass without them."""
    import sys

    for name in [m for m in sys.modules if m == "electroclean.web" or m.startswith("electroclean.web.")]:
        monkeypatch.delitem(sys.modules, name)
    for name in ("fastapi", "uvicorn", "starlette", "firebase_admin", "firebase_functions", "google.cloud.firestore"):
        monkeypatch.setitem(sys.modules, name, None)  # importing them now fails, as in the frozen build
    assert main(["--self-test", str(tmp_path / "selftest.log")]) == 0
