"""Command-line tools refuse mistakes instead of acting on them (usability review).

``electroclean-admin`` must not create study files in mistyped folders, mark
failures resolved that were never logged, or report on annotators who do not
exist; mistyped names get a "did you mean" suggestion.
"""

from __future__ import annotations

import pytest

from electroclean.app.annotations.labels import default_catalogue
from electroclean.app.io.naming import OutputLayout
from electroclean.app.session.failures import FailureLog
from electroclean.config.settings import load_settings
from electroclean.hints import did_you_mean, unknown_names
from electroclean.training.cli import build_parser, main
from electroclean.training.reference import ReferenceSet, reference_sets_dir


def test_did_you_mean():
    labels = default_catalogue().label_names
    assert did_you_mean("EMG", labels) == " Did you mean 'EMG-artifact'?"
    assert did_you_mean("Eye-blink", labels) == " Did you mean 'Eye-blink-artifact'?"
    assert did_you_mean("a01", ["A01", "A02"]) == " Did you mean 'A01'?"
    assert did_you_mean("zzzz", ["A01"]) == ""
    msg = unknown_names("annotator", ["A01", "B99"], ["A01", "A02"])
    assert msg is not None and "'B99'" in msg and "Known annotators: A01, A02" in msg
    assert unknown_names("annotator", ["A01"], ["A01"]) is None


def test_admin_refuses_mistyped_folders(tmp_path, capsys):
    typo = tmp_path / "typo_path"
    assert main(["fix-filters", str(typo)]) == 2
    assert not typo.exists()
    assert "Dataset folder not found" in capsys.readouterr().err
    assert main(["init-study", str(typo), "--study-id", "x"]) == 2
    assert "--create" in capsys.readouterr().err and not typo.exists()
    empty = tmp_path / "empty"
    empty.mkdir()
    assert main(["show", str(empty)]) == 2
    assert "does not look like an ElectroClean dataset" in capsys.readouterr().err
    assert main(["fix-filters", str(empty)]) == 2 and not (empty / "electroclean_study.json").exists()
    # A new study in a new folder is possible when asked for explicitly.
    assert main(["init-study", str(typo), "--study-id", "x", "--create"]) == 0
    captured = capsys.readouterr()
    assert (typo / "electroclean_study.json").is_file() and "no recordings were found" in captured.err
    assert main(["show", str(typo)]) == 0  # a study file is enough


def test_admin_accepts_a_real_dataset(dataset, capsys):
    root, _ = dataset
    assert main(["fix-filters", str(root)]) == 0
    assert main(["show", str(root)]) == 0


def test_resolve_failure_needs_a_logged_failure(dataset, capsys):
    root, _ = dataset
    rid = "sub-001/eeg/sub-001_task-rest_eeg.vhdr"
    assert main(["resolve-failure", str(root), rid, "--note", "x"]) == 2
    err = capsys.readouterr().err
    assert "has no recorded load failure" in err and "Unresolved failures: none" in err
    FailureLog(OutputLayout(root / "Annotated_Events")).record(None, rid, "corrupt_recording", "broken")
    assert main(["resolve-failure", str(root), rid.replace("001", "01"), "--note", "x"]) == 2
    assert f"Did you mean '{rid}'?" in capsys.readouterr().err
    assert main(["resolve-failure", str(root), rid, "--note", "re-copied"]) == 0
    assert main(["resolve-failure", str(root), rid, "--note", "again"]) == 2
    assert "already marked resolved" in capsys.readouterr().err


def test_report_refuses_unknown_annotators(dataset, capsys):
    root, _ = dataset
    _, study = load_settings(root)
    ReferenceSet.create(reference_sets_dir(root, study), "pilot")
    assert main(["init-study", str(root), "--study-id", "s", "--annotators", "CAM"]) == 0
    assert main(["report", str(root), "pilot", "NOBODY"]) == 2
    assert "NOBODY is not an annotator of this study" in capsys.readouterr().err
    assert main(["report", str(root), "pilot", "CAN"]) == 2
    assert "Did you mean 'CAM'?" in capsys.readouterr().err
    assert main(["report", str(root), "pilot", "cam"]) == 0  # listed: an "incomplete" report is useful


def test_admin_help_is_readable():
    parser = build_parser()
    usage = parser.format_usage()
    assert "COMMAND" in usage and len(usage) < 120
    text = parser.format_help()
    assert "fix-filters" in text and "administrator_guide.md" in text
    with pytest.raises(SystemExit):
        parser.parse_args(["fix-filtres", "x"])
