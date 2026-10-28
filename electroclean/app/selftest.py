"""End-to-end self-test of an ElectroClean installation (``electroclean --self-test``).

The self-test needs no display and no data: it creates a small synthetic BIDS
dataset in a temporary folder, discovers and loads it with the default filters,
opens the real annotation window offscreen, lets two annotators each draw and
save an annotation through the window's own controls, runs the inter-rater
agreement analysis (tables and HTML report) on what they saved, and reads an
EDF+ recording.

Its main purpose is to check a frozen (PyInstaller) build, where a missing
module, Qt plug-in or data file would otherwise only show up when an annotator
first uses the feature, but it works the same from a normal installation.
It prints one line per step and ``ElectroClean self-test passed`` at the end,
and returns 0 on success or 1 (after printing the traceback) on failure.
Because the windowed Windows executable has no console, the output can also
be written to a file (``electroclean --self-test LOG_FILE``).

Writing the synthetic BrainVision files uses ``pybv``, which the frozen
applications therefore bundle (it is small, pure Python and BSD-licensed).
"""

from __future__ import annotations

import os
import platform
import shutil
import sys
import tempfile
import time
import traceback
from pathlib import Path
from typing import Any, TextIO

PASS_MESSAGE = "ElectroClean self-test passed"
FAIL_MESSAGE = "ElectroClean self-test FAILED"


class SelfTestFailure(AssertionError):
    pass


class _Output:
    """Writes to stdout (when there is one) and, optionally, to a log file."""

    def __init__(self, log_file: Path | None) -> None:
        self.streams: list[TextIO] = []
        if sys.stdout is not None:  # None in the windowed Windows executable
            self.streams.append(sys.stdout)
        self._fh: TextIO | None = None
        if log_file is not None:
            log_file.parent.mkdir(parents=True, exist_ok=True)
            self._fh = open(log_file, "w", encoding="utf-8")  # noqa: SIM115
            self.streams.append(self._fh)

    def __call__(self, text: str = "") -> None:
        for s in self.streams:
            try:
                s.write(text + "\n")
                s.flush()
            except (OSError, ValueError, UnicodeError):
                pass

    def close(self) -> None:
        if self._fh is not None:
            self._fh.close()


def _check(condition: Any, message: str) -> None:
    if not condition:
        raise SelfTestFailure(message)


def _process_events(ms: int = 50) -> None:
    """Let Qt run its event loop for ``ms`` milliseconds."""
    from qtpy.QtCore import QEventLoop, QTimer

    loop = QEventLoop()
    QTimer.singleShot(ms, loop.quit)
    loop.exec()


def _annotate_in_window(root: Path, rid: str, annotator: str, t0: float, t1: float, say) -> Any:  # noqa: ANN001
    """Load one recording, open the annotation window, draw one annotation and Save and Finish."""
    from electroclean.app.annotations.labels import default_catalogue
    from electroclean.app.eeg.loading import load_recording
    from electroclean.app.gui.annotation_window import AnnotationWorkspace
    from electroclean.app.gui.dialogs import ScriptedPrompts
    from electroclean.app.io.discovery import discover_recordings
    from electroclean.app.io.naming import OutputLayout
    from electroclean.app.session.register import CompletionRegister
    from electroclean.app.session.session import AnnotationSession
    from electroclean.config.settings import load_settings

    settings, _ = load_settings(root)
    catalogue = default_catalogue()
    _check(len(catalogue.label_names) > 0, "the artifact label catalogue is empty")
    layout = OutputLayout(root / settings.output_directory_name)
    files = {r.recording_id: r for r in discover_recordings(root)}[rid]
    loaded = load_recording(files, settings, settings.filters, catalogue)
    try:
        applied = [step.name for step in loaded.filter_report.steps]
        _check(applied, "no filters were applied while loading (the default settings enable them)")
        say(f"  loaded {rid} for {annotator}: {len(loaded.view_raw.ch_names)} channels, "
            f"{loaded.timing.sfreq:g} Hz, filters: {', '.join(applied)}")
        session = AnnotationSession(layout=layout, settings=settings, filters=settings.filters, catalogue=catalogue,
                                    loaded=loaded, annotator_id=annotator)
        session.start()
        prompts = ScriptedPrompts()
        # The interaction log of this short visit (checked below and by the activity analysis).
        from datetime import datetime

        from electroclean.app.gui.interaction_capture import InteractionRecorder
        from electroclean.app.session.interaction_log import InteractionLog

        log_path = layout.visit_log_path(annotator, "standard", datetime.now())
        log = InteractionLog(log_path, {"annotator_id": annotator, "mode": "standard", "self_test": True})
        recorder = InteractionRecorder(log, pointer_hz=settings.logging_pointer_hz,
                                       idle_after_s=settings.logging_idle_after_s)
        ws = AnnotationWorkspace(session, settings, prompts=prompts, log=log)
        recorder.attach_workspace(ws)
        finished: list[Any] = []
        ws.finished.connect(finished.append)
        ws.show()
        _process_events(300)
        _check(ws.browser.isVisible(), "the annotation window did not open")
        _check(len(ws.browser.mne.traces) > 0, "the EEG browser shows no traces")
        _check(ws._hed, "the HED-SCORE descriptions (config/hed_score_2.2.0_validation.json) were not found")
        aid = ws.controller.create_annotation(t0, t1)
        _process_events()
        _check(aid is not None and len(session.store) == 1, "could not create an annotation in the window")
        _check(ws.save_and_finish() is True, f"Save and Finish failed: {prompts.log[-1] if prompts.log else ''}")
        _process_events()
        log.event("recording_finished", n_annotations=len(session.store))
        recorder.close("self_test")
        from electroclean.activity.logs import read_visit_log
        from electroclean.activity.summary import summarise

        visit = read_visit_log(log_path)
        kinds = {e["type"] for e in visit.events}
        _check({"recording_opened", "annotation_created", "recording_finished"} <= kinds,
               f"the interaction log is incomplete (events: {sorted(kinds)})")
        rows = summarise([visit]).recordings
        _check(len(rows) == 1 and rows[0]["annotations_created"] == 1, "the interaction log could not be summarised")
        _check(finished and finished[0] is not None, "Save and Finish did not report a result")
        _check(CompletionRegister(layout).is_completed(rid, annotator), "the recording was not marked complete")
        paths = finished[0].commit.paths
        missing = [str(p) for p in paths.values() if not Path(p).is_file()]
        _check(not missing, f"output files missing after saving: {missing}")
        say(f"  {annotator} saved {finished[0].n_annotations} annotation(s): "
            + ", ".join(sorted(Path(p).name for p in paths.values())))
        return layout
    finally:
        loaded.close()


def _run(work: Path, say) -> None:  # noqa: ANN001
    t_start = time.monotonic()
    from electroclean import __version__

    say(f"ElectroClean {__version__} self-test (Python {platform.python_version()}, {platform.platform()}, "
        f"frozen={bool(getattr(sys, 'frozen', False))})")
    say(f"  working folder: {work}")

    # 1. Libraries, versions (read from bundled package metadata) and Qt.
    import mne
    import pyqtgraph as pg
    from qtpy import API_NAME, QT_VERSION

    mne.set_log_level("error")
    from electroclean.app.gui.browser import check_browser_version
    from electroclean.app.session.session import library_versions

    versions = library_versions()
    say("1. libraries: " + ", ".join(f"{k} {v}" for k, v in versions.items()) + f"; Qt {QT_VERSION} via {API_NAME}")
    _check(mne.__version__ != "0.0.0", "MNE's package metadata is missing (mne.__version__ is 0.0.0)")
    warning = check_browser_version()
    _check(warning is None, warning or "")
    app = pg.mkQApp("ElectroClean")
    say(f"   Qt platform plug-in: {app.platformName()}")

    # Every ElectroClean module (start window, training and agreement windows, command-line tools)
    # must import, and the browser's SVG icons must be readable (Qt's SVG plug-ins).
    import importlib
    import pkgutil

    import mne_qt_browser
    from qtpy.QtGui import QIcon, QImageReader

    import electroclean

    # electroclean.web (the browser version's server and Firebase functions) is not part of the
    # desktop application and needs packages it does not include.
    names = sorted(m.name for m in pkgutil.walk_packages(electroclean.__path__, "electroclean.")
                   if m.name != "electroclean.web" and not m.name.startswith("electroclean.web."))
    for name in names:
        importlib.import_module(name)
    _check(len(names) > 50, f"only {len(names)} ElectroClean modules were found")
    icon = Path(mne_qt_browser.__file__).parent / "icons" / "light" / "actions" / "zoom_in.svg"
    _check(icon.is_file(), f"mne-qt-browser's icons are missing ({icon})")
    _check(b"svg" in [bytes(f) for f in QImageReader.supportedImageFormats()], "Qt cannot read SVG images")
    _check(not QIcon(str(icon)).pixmap(16, 16).isNull(), "Qt could not draw an SVG icon")
    from electroclean.app.gui import style

    theme_icons = sorted(style.ICONS.glob("chevron-*.png"))
    _check(len(theme_icons) == 8, f"ElectroClean's theme icons are missing from {style.ICONS}")
    style.apply_theme()
    say(f"   imported {len(names)} ElectroClean modules; SVG icons and theme OK")

    # 2. Synthetic dataset (writes BrainVision files with pybv).
    from electroclean.app.io.discovery import discover_recordings
    from electroclean.synthetic import make_synthetic_dataset

    root = work / "SelfTestStudy"
    truths = make_synthetic_dataset(root, n_subjects=1, duration_s=20.0, seed=1)
    recs = discover_recordings(root)
    _check(len(recs) == 1, f"expected 1 recording to be discovered, found {len(recs)}")
    rid = recs[0].recording_id
    say(f"2. synthetic dataset: {rid} ({len(truths[rid].annotations)} ground-truth artifacts)")

    # 3. Two annotators annotate in the real window (offscreen) and Save and Finish.
    say("3. annotation window")
    layout = _annotate_in_window(root, rid, "A01", 1.0, 2.0, say)
    _annotate_in_window(root, rid, "A02", 1.1, 2.1, say)

    # 4. Inter-rater agreement analysis, tables and HTML report (matplotlib figures).
    from electroclean.reliability import AnalysisConfig, run_analysis, write_outputs

    result = run_analysis([layout.root], AnalysisConfig())
    _check(sorted(result.dataset.annotators) == ["A01", "A02"],
           f"agreement analysis found annotators {result.dataset.annotators}")
    pairwise = result.table("timeresolved_pairwise")
    _check(len(pairwise) > 0, "the agreement analysis produced no pairwise results")
    out = write_outputs(result, work / "agreement")
    report = Path(out["report"])
    _check(report.is_file() and "data:image/png;base64" in report.read_text(encoding="utf-8"),
           "the agreement report has no figures")
    say(f"4. agreement analysis: {len(result.tables)} tables, {len(pairwise)} pairwise rows, "
        f"report {report.stat().st_size // 1024} KB")
    from electroclean.activity.cli import write_activity

    act, act_paths = write_activity([layout.root], work / "activity")
    _check(len(act.recordings) == 2 and act_paths["report"].is_file(), "the activity report could not be written")
    say(f"   interaction logs: {len(act.visits)} visits, activity report {act_paths['report'].stat().st_size // 1024} KB")

    # 5. An EDF+ recording like a headset export: read, checked, filtered, housekeeping channels hidden.
    from electroclean.app.annotations.labels import default_catalogue
    from electroclean.app.eeg.loading import load_recording
    from electroclean.config.settings import load_settings
    from electroclean.synthetic import ALL_CHANNELS, write_edf_recording

    edf_root = work / "SelfTestEDF"
    write_edf_recording(edf_root / "sub-01" / "eeg", "sub-01_task-rest", duration_s=20.5)
    settings, _ = load_settings(edf_root)
    (edf,) = discover_recordings(edf_root, suffixes=settings.discovery_suffixes)
    lr = load_recording(edf, settings, settings.filters, default_catalogue())
    try:
        _check(lr.info.ch_names == tuple(ALL_CHANNELS), f"EDF channels shown: {lr.info.ch_names}")
        _check(len(lr.info.hidden_channels) == 5, f"EDF channels hidden: {lr.info.hidden_channels}")
        _check(len(lr.filter_report.steps) == 2, "the EDF recording was not filtered")
        say(f"5. EDF recording: {len(lr.info.ch_names)} channels shown, {len(lr.info.hidden_channels)} hidden, "
            f"{len(lr.original_events)} events, filtered")
    finally:
        lr.close()
    say(f"   finished in {time.monotonic() - t_start:.1f} s")


def run_self_test(log_file: Path | str | None = None, keep_files: bool = False) -> int:
    """Run the self-test; return 0 if it passed and 1 if it failed."""
    # Always offscreen: the self-test must run on build machines without a display and should not
    # flash windows on an annotator's screen. Set before any Qt object is created.
    os.environ["QT_QPA_PLATFORM"] = "offscreen"
    os.environ.setdefault("QT_API", "pyside6")
    say = _Output(Path(log_file) if log_file else None)
    work = Path(tempfile.mkdtemp(prefix="electroclean-selftest-"))
    try:
        _run(work, say)
    except BaseException as exc:  # noqa: BLE001  (report everything, including SystemExit from argparse-like code)
        say(traceback.format_exc().rstrip())
        say(f"{FAIL_MESSAGE}: {type(exc).__name__}: {exc}")
        keep_files = True
        return 1
    else:
        say(PASS_MESSAGE)
        return 0
    finally:
        if keep_files:
            say(f"Self-test files kept in {work}")
        else:
            shutil.rmtree(work, ignore_errors=True)
        say.close()


if __name__ == "__main__":
    sys.exit(run_self_test(sys.argv[1] if len(sys.argv) > 1 else None))
