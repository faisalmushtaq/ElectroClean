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
