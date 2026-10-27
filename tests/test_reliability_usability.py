"""Agreement tools: clear inputs, clear results, nothing overwritten (usability review).

Covers the library (strict name checks, header rows for empty tables,
"nothing to compare"), the command line (help, default results folder, exit
statuses), the HTML report (key results, captions, readable headings, sparse
categories) and the dialog (input checks, background thread, confirmation
before replacing results).
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from electroclean.app.annotations.timing import RecordingTiming
from electroclean.app.io.canonical import write_annotations_json
from electroclean.reliability.analysis import (
    TABLE_COLUMNS,
    AnalysisCancelled,
    has_earlier_results,
    run_analysis,
    write_outputs,
)
from electroclean.reliability.cli import EXIT_NOTHING_TO_COMPARE, build_parser, main
from electroclean.reliability.config import AnalysisConfig
from electroclean.synthetic import default_artifact_plan, simulate_rater, truth_document


def _write_annotations(folder: Path, annotators=("A01", "A02", "A03"), n_recordings: int = 2) -> Path:
    """An Annotated_Events-like folder with simulated annotators, inside a BIDS-like dataset folder."""
    folder.parent.mkdir(parents=True, exist_ok=True)
    (folder.parent / "dataset_description.json").write_text('{"Name": "test"}', encoding="utf-8")
    for k in range(n_recordings):
        rng = np.random.default_rng(k)
        rid = f"sub-00{k + 1}/eeg/sub-00{k + 1}_task-rest_eeg.vhdr"
        truth = truth_document(rid, default_artifact_plan(60.0, rng), RecordingTiming(250.0, 15000))
        for i, aid in enumerate(annotators):
            doc = simulate_rater(truth, aid, seed=10 * k + i)
            write_annotations_json(folder / f"annotator-{aid}" / f"sub-00{k + 1}" / "eeg"
                                   / f"sub-00{k + 1}_task-rest_eeg_annotator-{aid}_annotations.json", doc)
    return folder


@pytest.fixture
def annotations(tmp_path):
    return _write_annotations(tmp_path / "study" / "Annotated_Events")


# ------------------------------------------------------------------ library
def test_table_columns_match_a_full_analysis(annotations):
    res = run_analysis([annotations], AnalysisConfig(resolutions_s=(0.1,)))
    for name, cols in TABLE_COLUMNS.items():
        assert list(res.tables[name].columns) == cols, name


def test_one_annotator_gives_headers_and_a_plain_warning(tmp_path):
    folder = _write_annotations(tmp_path / "s" / "Annotated_Events", annotators=("A01",))
    res = run_analysis([folder], AnalysisConfig(resolutions_s=(0.1,)))
    assert not res.has_comparisons
    assert res.settings_record["warnings"][0].startswith("No recording was annotated by at least two")
    paths = write_outputs(res, tmp_path / "out")
    header = paths["timeresolved_pairwise"].read_text(encoding="utf-8").splitlines()
    assert header == ["\t".join(TABLE_COLUMNS["timeresolved_pairwise"])]  # header row, no data rows
    report = paths["report"].read_text(encoding="utf-8")
    assert "Nothing to compare." in report and "Key results" not in report


def test_partly_comparable_data_is_reported(tmp_path):
    folder = _write_annotations(tmp_path / "s" / "Annotated_Events", annotators=("A01", "A02"))
    lone = _write_annotations(tmp_path / "t" / "Annotated_Events", annotators=("A03",), n_recordings=3)
    res = run_analysis([folder, lone], AnalysisConfig(resolutions_s=(0.1,)))
    assert res.has_comparisons and res.settings_record["n_comparable_recordings"] == 2
    assert any("1 of 3 recordings were annotated by only one" in w for w in res.settings_record["warnings"])


def test_strict_mode_names_unknown_categories_annotators_and_reference(annotations):
    with pytest.raises(ValueError, match="Did you mean 'EMG-artifact'"):
        run_analysis([annotations], AnalysisConfig(categories=("EMG",)), strict=True)
    with pytest.raises(ValueError, match="'B99'"):
        run_analysis([annotations], AnalysisConfig(annotators=("A01", "B99")), strict=True)
    with pytest.raises(ValueError, match="Did you mean 'A01'"):
        run_analysis([annotations], AnalysisConfig(reference_annotator="A010"), strict=True)
    # Without strict (the library default) an unknown reference is only a warning, as before.
    res = run_analysis([annotations], AnalysisConfig(resolutions_s=(0.1,), reference_annotator="Z"))
    assert any("reference annotator Z" in w for w in res.settings_record["warnings"])


def test_empty_folder_is_explained(tmp_path):
    (tmp_path / "empty").mkdir()
    with pytest.raises(FileNotFoundError, match=r"No annotation files \(\*_annotations.json\)"):
        run_analysis([tmp_path / "empty"])


def test_cancelling_writes_nothing(annotations, tmp_path):
    steps = []
    with pytest.raises(AnalysisCancelled):
        run_analysis([annotations], AnalysisConfig(), progress=steps.append, cancel=lambda: len(steps) >= 2)
    assert steps == ["Reading the annotation files", "Counting the annotations"]
    res = run_analysis([annotations], AnalysisConfig(resolutions_s=(0.1,)))
    with pytest.raises(AnalysisCancelled):
        write_outputs(res, tmp_path / "out", cancel=lambda: True)
    assert not (tmp_path / "out").exists()


# -------------------------------------------------------------------- report
def test_report_has_key_results_captions_and_readable_headings(annotations, tmp_path):
    res = run_analysis([annotations], AnalysisConfig(resolutions_s=(0.1,), min_events_per_category=6))
    report = write_outputs(res, tmp_path / "out")["report"].read_text(encoding="utf-8")
    key = report.index("Key results")
    assert key < report.index("1. Recordings and annotations")
    assert "Positive agreement, any artifact" in report[key:key + 4000] and "Mean over pairs" in report
    assert "<th title='Agreement corrected for chance" in report  # readable heading with an explanation
    assert "[cohen_kappa]" in report  # the TSV name is in the tooltip
    assert "class='caption'" in report and "class='nowrap'" in report
    assert "Not in the figure, because they have fewer than 6 annotations" in report
    # The TSV keeps its column names for scripts.
    tsv = pd.read_csv(tmp_path / "out" / "timeresolved_pairwise.tsv", sep="\t")
    assert list(tsv.columns) == TABLE_COLUMNS["timeresolved_pairwise"]
    # The event table puts F1, precision and recall right after the pair.
    ev_table = report[report.index("4. Event matching"):]
    head = ev_table[ev_table.index("<thead>"):ev_table.index("</thead>")]
    assert head.index(">F1<") < head.index(">Events, reference<")


# ----------------------------------------------------------------------- CLI
def test_cli_help_explains_every_option():
    text = build_parser().format_help()
    for option in ("--channel-modes", "--iou-thresholds", "--onset-tolerance", "--offset-tolerance",
                   "--allow-many-to-one", "--min-channel-jaccard", "--min-events", "--overwrite"):
        assert option in text
    assert "(default: 0.5)" in text and "seconds" in text and "examples:" in text and "reliability_guide.md" in text
    assert "exit status" in text


def test_cli_results_folder_exit_statuses_and_typos(annotations, tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    assert main([str(annotations), "--resolutions", "0.1"]) == 0
    made = [p for p in tmp_path.iterdir() if p.name.startswith("agreement_")]
    assert len(made) == 1 and (made[0] / "agreement_report.html").is_file()
    out = tmp_path / "res"
    assert main([str(annotations), "--out", str(out), "--resolutions", "0.1", "--no-html"]) == 0
    assert main([str(annotations), "--out", str(out)]) == 2
    assert "already holds the results" in capsys.readouterr().err
    assert main([str(annotations), "--out", str(out), "--overwrite", "--resolutions", "0.1", "--no-html"]) == 0
    assert main([str(annotations), "--out", str(tmp_path / "r2"), "--categories", "EMG"]) == 2
    assert "Did you mean 'EMG-artifact'?" in capsys.readouterr().err
    assert main([str(annotations), "--out", str(tmp_path / "r3"), "--annotators", "a01", "B99"]) == 2
    assert "'B99'" in capsys.readouterr().err
    assert main([str(annotations), "--out", str(tmp_path / "r4"), "--annotators", "A01", "--no-html",
                 "--resolutions", "0.1"]) == EXIT_NOTHING_TO_COMPARE
    assert "warning: No recording was annotated by at least two" in capsys.readouterr().out


# -------------------------------------------------------------------- dialog
pytest.importorskip("PySide6")


@pytest.fixture(scope="module")
def qapp():
    import pyqtgraph as pg

    return pg.mkQApp("ElectroClean-tests")


def _dialog(input_dir, prompts=None, synchronous=True):
    from electroclean.app.gui.dialogs import ScriptedPrompts
    from electroclean.reliability.gui import AgreementDialog

    return AgreementDialog(None, input_dir, prompts or ScriptedPrompts(), synchronous=synchronous, open_report=False)


@pytest.mark.gui
def test_dialog_refuses_missing_or_empty_inputs(qapp, tmp_path):
    dlg = _dialog(None)
    assert dlg.out.text() == ""
    dlg.run()
    assert "Choose the annotation folder" in dlg.status.text() and dlg.last_result is None
    dlg.inputs.setText(".")
    dlg.run()
    assert "Choose the annotation folder" in dlg.status.text()
    dlg.inputs.setText(str(tmp_path / "missing"))
    dlg.run()
    assert "Folder not found" in dlg.status.text()
    (tmp_path / "empty").mkdir()
    dlg.inputs.setText(str(tmp_path / "empty"))
    dlg._inputs_changed()
    dlg.run()
    assert "No annotation files" in dlg.status.text() and "No annotation files" in dlg.inputs_hint.text()


@pytest.mark.gui
def test_dialog_runs_and_never_replaces_results_silently(qapp, annotations):
    from electroclean.app.gui.dialogs import ScriptedPrompts

    prompts = ScriptedPrompts({"Replace earlier results?": False})
    dlg = _dialog(annotations, prompts)
    out = Path(dlg.out.text())
    assert out.parent == annotations.parent / "derivatives" / "electroclean_agreement"  # dated, in derivatives
    assert "annotation file(s) found" in dlg.inputs_hint.text()
    dlg.resolutions.setText("0.1")
    dlg.run()
    assert dlg.last_result is not None and "Finished" in dlg.status.text()
    assert dlg.result_paths["report"].is_file() and dlg.open_btn.isEnabled() and dlg.run_btn.isEnabled()
    assert "href=" in dlg.status.text()  # the report can be opened from the status line
    first = dlg.result_paths["report"].stat().st_mtime_ns
    dlg.run()  # same folder again: asked, and the answer is no
    assert any(t == "Replace earlier results?" for _k, t, _x in prompts.log)
    assert "Not run" in dlg.status.text() and dlg.result_paths["report"].stat().st_mtime_ns == first
    assert has_earlier_results(out)


@pytest.mark.gui
def test_dialog_settings_and_plain_errors(qapp, annotations):
    dlg = _dialog(annotations)
    dlg.criterion.setCurrentIndex(1)  # onset and offset tolerance
    assert dlg.criterion.currentText() == "Onset and offset tolerance"
    assert not dlg.thresholds.isEnabled() and dlg.tol_on.isEnabled()
    dlg.criterion.setCurrentIndex(0)
    assert dlg.thresholds.isEnabled() and not dlg.tol_on.isEnabled()
    dlg.resolutions.setText("0.1 abc")
    dlg.run()
    assert "'abc' is not a number" in dlg.status.text()
    dlg.resolutions.setText("0.1")
    dlg.mode_time.setChecked(False)
    dlg.mode_channel.setChecked(False)
    dlg.run()
    assert "tick 'Time only'" in dlg.status.text()
    from qtpy.QtCore import Qt

    dlg.mode_time.setChecked(True)
    dlg._set_all_categories(Qt.Unchecked)
    dlg.run()
    assert "tick at least one artifact category" in dlg.status.text()
    dlg._set_all_categories(Qt.Checked)
    dlg.category_list.item(0).setCheckState(Qt.Unchecked)
    assert dlg.config().categories is not None and len(dlg.config().categories) == dlg.category_list.count() - 1
    dlg.annotators.setText("A01 B99")
    dlg.run()
    assert "'B99'" in dlg.status.text()


@pytest.mark.gui
def test_dialog_shows_nothing_to_compare(qapp, tmp_path):
    folder = _write_annotations(tmp_path / "s" / "Annotated_Events", annotators=("A01",))
    dlg = _dialog(folder)
    dlg.resolutions.setText("0.1")
    dlg.run()
    assert not dlg.warnings.isHidden() and "Nothing to compare" in dlg.warnings.text()


@pytest.mark.gui
def test_dialog_runs_in_a_background_thread(qapp, annotations):
    import time

    from qtpy.QtWidgets import QApplication

    dlg = _dialog(annotations, synchronous=False)
    dlg.resolutions.setText("0.1")
    dlg.run()
    assert dlg.worker is not None and not dlg.run_btn.isEnabled() and dlg.cancel_btn.isEnabled()
    # time.sleep releases Python's lock so the worker thread can run (QTest.qWait does not);
    # the application's own event loop does the same.
    for _ in range(1200):
        if dlg.worker is None:
            break
        QApplication.processEvents()
        time.sleep(0.05)
    assert dlg.worker is None and "Finished" in dlg.status.text()
    settings = json.loads((Path(dlg.out.text()) / "analysis_settings.json").read_text(encoding="utf-8"))
    assert settings["n_recordings"] == 2
