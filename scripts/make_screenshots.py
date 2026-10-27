"""Render the screenshots used in docs/user_guide.md from synthetic data.

    QT_QPA_PLATFORM=offscreen python scripts/make_screenshots.py [output_folder]

Everything is generated in a temporary folder; nothing outside the output
folder (default docs/images) is written.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("QT_API", "pyside6")
REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))



def desktop_size(ws) -> None:  # noqa: ANN001
    """The off-screen 'screen' is small; show the annotation window at a typical desktop size."""
    from qtpy.QtCore import Qt

    ws.browser.resize(1600, 950)
    ws.browser.resizeDocks([ws.annotation_dock], [470], Qt.Horizontal)
    ws.browser.resizeDocks([ws.annotation_dock, ws.info_dock], [540, 340], Qt.Vertical)

def main() -> int:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO / "docs" / "images"
    out.mkdir(parents=True, exist_ok=True)
    import mne
    import pyqtgraph as pg
    from qtpy.QtTest import QTest
    from qtpy.QtWidgets import QApplication

    mne.set_log_level("error")
    app = pg.mkQApp("ElectroClean")
    app.setApplicationName("ElectroClean")

    from electroclean.app.annotations.labels import default_catalogue
    from electroclean.app.annotations.model import AnnotationDocument
    from electroclean.app.eeg.loading import load_recording
    from electroclean.app.gui.annotation_window import AnnotationWorkspace
    from electroclean.app.gui.app_controller import AppController
    from electroclean.app.gui.dialogs import ChannelDialog, ScriptedPrompts
    from electroclean.app.gui.filter_dialog import FilterDialog
    from electroclean.app.io.discovery import discover_recordings
    from electroclean.app.io.naming import OutputLayout
    from electroclean.app.session.session import AnnotationSession
    from electroclean.config.settings import load_settings
    from electroclean.synthetic import make_synthetic_dataset, simulate_rater
    from electroclean.training.assessment import feedback_html, practice_feedback
    from electroclean.training.gui import AdminDialog, QuizWindow, ReviewSession, prepare_review_window, review_store
    from electroclean.training.quiz import QuizSession
    from electroclean.training.reference import QuizItem, ReferenceSet, reference_sets_dir

    tmp = Path(tempfile.mkdtemp(prefix="electroclean-shots-"))
    try:
        root = tmp / "MyStudy"
        truths = make_synthetic_dataset(root, n_subjects=3, duration_s=60.0, seed=11)
        cat = default_catalogue()
        settings, study = load_settings(root)

        def settle(ms: int = 250) -> None:
            QTest.qWait(ms)
            QApplication.processEvents()

        def grab(widget, name: str) -> None:
            settle()
            widget.grab().save(str(out / name))
            print("saved", out / name)

        # Start window
        ctrl = AppController(prompts=ScriptedPrompts(), synchronous_loading=True)
        sw = ctrl.start_window
        sw.dataset.setText(str(root))
        sw.annotator.setEditText("A01")
        sw.display_name.setText("Annotator one")
        sw.refresh()
        sw.resize(660, 640)
        sw.show()
        grab(sw, "start_window.png")
        sw.hide()

        # Viewing options
        dlg = FilterDialog(None, settings.filters, "sub-002/eeg/sub-002_task-rest_eeg.vhdr")
        dlg.show()
        grab(dlg, "viewing_options.png")
        dlg.close()

        # Annotation window
        recs = {r.recording_id: r for r in discover_recordings(root)}
        rid = "sub-001/eeg/sub-001_task-rest_eeg.vhdr"
        lr = load_recording(recs[rid], settings, settings.filters, cat)
        session = AnnotationSession(layout=OutputLayout(tmp / "out"), settings=settings, filters=settings.filters,
                                    catalogue=cat, loaded=lr, annotator_id="A01", display_name="Annotator one")
        session.start()
        ws = AnnotationWorkspace(session, settings, prompts=ScriptedPrompts())
        ws.show()
        desktop_size(ws)
        QTest.qWaitForWindowExposed(ws.browser)
        st = session.store
        st.add_interval("Eye-blink-artifact", 2.96, 3.44, ["Fp1", "Fp2", "VEOG"])
        st.add_interval("Eye-blink-artifact", 9.46, 9.90, ["Fp1", "Fp2", "VEOG"])
        st.add_interval("EMG-artifact", 9.2, 10.8, ["F7", "F8", "T7", "T8"])
        st.add_interval("Electrode-pops-artifact", 14.0, 14.5, ["C3"])
        st.add_interval("Horizontal-eye-movement-artifact", 18.0, 19.2, ["F7", "F8", "HEOG"])
        st.add_interval("Movement-artifact", 24.0, 26.0)
        ws.controller.set_scope("channels")
        ws.controller.set_selected_channels(["T7", "T8"])
        ws.controller.set_current_label("Chewing-artifact")
        settle(300)
        ws.controller.jump_to(st.annotations()[2].annotation_id)
        settle(400)
        grab(ws.browser, "annotation_window.png")

        chans = ChannelDialog(None, lr.info.ch_names, ["F7", "F8", "T7", "T8"], title="Channels affected by this EMG-artifact",
                              allow_whole_montage=True, ch_types=dict(zip(lr.view_raw.ch_names, lr.view_raw.get_channel_types())))
        chans.show()
        grab(chans, "channel_dialog.png")
        chans.close()

        ws.info_tabs.setCurrentIndex(1)
        ws.controller.jump_to(st.annotations()[0].annotation_id)
        settle(300)
        grab(ws.browser, "annotation_window_help.png")
        ws._closing_ok = True
        ws.browser.close()
        settle()

        # Practice feedback and review
        _, study = load_settings(root)
        rs = ReferenceSet.create(reference_sets_dir(root, study), "pilot", name="Pilot training set",
                                 method="single_expert", experts=["EXP1"])
        for r in sorted(truths):
            rs.add_reference(AnnotationDocument(truths[r].recording, "EXP1", list(truths[r].annotations), cat, session_id="e"),
                             use="practice" if r == rid else "assessment", method="single_expert", experts=["EXP1"])
        rs.add_quiz_item(QuizItem("q1", rid, 2.96, 3.44, "Eye-blink-artifact"), cat.label_names)
        mine = simulate_rater(truths[rid], "A01", seed=3, miss_probability=0.2, false_alarms=1,
                              confusion={"Eye-blink-artifact": "Vertical-eye-movement-artifact"}, confusion_probability=0.5)
        fb = practice_feedback(mine, rs.reference_document(rid), rs)
        from qtpy.QtWidgets import QDialog, QTextBrowser, QVBoxLayout

        fd = QDialog()
        fd.setWindowTitle("Practice feedback")
        fd.resize(760, 600)
        lay = QVBoxLayout(fd)
        tb = QTextBrowser()
        tb.setHtml(feedback_html(fb))
        lay.addWidget(tb)
        fd.show()
        grab(fd, "practice_feedback.png")
        fd.close()

        store, prefix = review_store(lr, list(mine.annotations), list(rs.reference_document(rid).annotations), cat)
        review = AnnotationWorkspace(ReviewSession(lr, store, "A01", settings.filters, "pilot"), settings,  # type: ignore[arg-type]
                                     prompts=ScriptedPrompts(), read_only=True, display_prefix=prefix,
                                     window_title="ElectroClean – review: YOU versus REF")
        prepare_review_window(review)
        review.show()
        desktop_size(review)
        QTest.qWaitForWindowExposed(review.browser)
        settle(300)
        review.controller.jump_to(sorted(store.annotations(), key=lambda a: a.onset_sample)[0].annotation_id)
        settle(300)
        grab(review.browser, "practice_review.png")
        review.browser.close()
        lr.close()

        # Quiz
        ctrl.request = type("R", (), {"annotator_id": "A01", "mode": "assessment"})()
        ctrl.settings = settings
        ctrl.layout = OutputLayout(tmp / "out")
        ctrl.recordings = list(recs.values())
        ctrl.reference_set = rs
        quiz = QuizWindow(ctrl, QuizSession(rs, "A01", "practice"))
        quiz.show()
        grab(quiz, "quiz_window.png")
        quiz.close()

        # Administrator tools
        adm = AdminDialog(ctrl, root, ScriptedPrompts())
        adm.tabs.setCurrentIndex(1)
        adm.show()
        grab(adm, "admin_reference_sets.png")
        adm.tabs.setCurrentIndex(2)
        grab(adm, "admin_criteria.png")
        adm.close()

        # Agreement report (rendered with Playwright if available)
        from electroclean.app.io.canonical import write_annotations_json
        from electroclean.reliability.analysis import run_analysis, write_outputs
        from electroclean.reliability.config import AnalysisConfig

        ann_dir = tmp / "ann"
        for i, (r, t) in enumerate(sorted(truths.items())):
            for j, aid in enumerate(["A01", "A02", "A03"]):
                d = simulate_rater(t, aid, seed=10 * i + j, boundary_jitter_s=0.05 + 0.04 * j, false_alarms=j)
                write_annotations_json(ann_dir / aid / f"{Path(r).stem}_annotator-{aid}_annotations.json", d)
        paths = write_outputs(run_analysis([ann_dir], AnalysisConfig()), tmp / "agreement")
        node = shutil.which("node")
        if node:
            js = tmp / "shot.js"
            js.write_text(
                "const { chromium } = require('playwright');(async()=>{const b=await chromium.launch();"
                "const p=await b.newPage({viewport:{width:1200,height:1500}});"
                f"await p.goto('file://{paths['report']}');"
                f"await p.screenshot({{path:'{out / 'agreement_report.png'}'}});await b.close();}})();"
            )
            env = dict(os.environ)
            npm_root = subprocess.run(["npm", "root", "-g"], capture_output=True, text=True).stdout.strip()
            env["NODE_PATH"] = npm_root
            subprocess.run([node, str(js)], check=False, env=env)
            print("saved", out / "agreement_report.png")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
