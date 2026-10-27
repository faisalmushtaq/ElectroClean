"""Interaction logs: what is recorded during a real session, what is never recorded, and the analytics."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from electroclean.activity.cli import main as activity_main
from electroclean.activity.cli import write_activity
from electroclean.activity.logs import find_logs, read_logs, read_visit_log
from electroclean.activity.summary import active_seconds, summarise
from electroclean.app.session.interaction_log import NULL_LOG, InteractionLog
from tests.activity_logs_helper import LogBuilder, demo_logs

T0 = datetime(2026, 10, 1, 9, 0, tzinfo=timezone.utc)


def rows_for(*paths):
    visits, warnings = read_logs(paths)
    return summarise(visits, warnings=warnings)


# ------------------------------------------------------------------ the log
def test_log_lines_header_context_and_null_log(tmp_path):
    log = InteractionLog(tmp_path / "v.jsonl", {"annotator_id": "A01"})
    log.context["recording"] = "sub-001"
    log.event("thing", value=float("nan"), items=(1, 2), path=tmp_path, kind="field called kind")
    log.close(reason="test")
    lines = [json.loads(x) for x in (tmp_path / "v.jsonl").read_text(encoding="utf-8").splitlines()]
    assert lines[0]["type"] == "header" and lines[0]["annotator_id"] == "A01"
    assert lines[1]["type"] == "thing" and lines[1]["recording"] == "sub-001" and lines[1]["value"] is None
    assert lines[1]["items"] == [1, 2] and lines[1]["seq"] == 1 and lines[1]["t"] >= 0
    assert lines[1]["kind"] == "field called kind"
    assert lines[-1]["type"] == "log_closed" and lines[-1]["reason"] == "test"
    NULL_LOG.event("nothing")  # takes events and does nothing
    assert not NULL_LOG.enabled


# --------------------------------------------------------------- analytics
def test_active_time_caps_long_gaps_and_leaves_out_inactive_time():
    assert active_seconds([10, 20, 100], 0, 110, 30) == pytest.approx(10 + 10 + 30 + 10)
    # ElectroClean inactive from 30 to 40 s: inside the (capped) gap from 20 to 50 s.
    assert active_seconds([10, 20, 100], 0, 110, 30, [(30, 40)]) == pytest.approx(10 + 10 + 20 + 10)


def test_recording_row_numbers(tmp_path):
    b = LogBuilder(tmp_path / "interaction_logs" / "annotator-A01" / "v1.jsonl", "A01", T0)
    b.recording(0.0, "sub-001", 1, duration_s=60, clicks=[10.0, 100.0], annotations=[20.0],
                views=[(1.0, 0.0, 10.0), (15.0, 5.0, 10.0), (50.0, 50.0, 10.0)], finish=110.0)
    b.event(30.0, "app_state", state="inactive")
    b.event(40.0, "app_state", state="active")
    b.write()
    t = rows_for(b.path)
    (row,) = t.recordings
    assert row["outcome"] == "finished" and row["wall_s"] == pytest.approx(110)
    assert row["active_s"] == pytest.approx(50)  # 10 + 10 + (30 - 10 inactive) + 10
    assert row["inactive_s"] == pytest.approx(10) and row["idle_s"] == pytest.approx(50)
    assert row["clicks"] == 2 and row["annotations_created"] == 1 and row["final_annotations"] == 1
    assert row["created_by_drag"] == 1
    assert row["seconds_per_annotation"] == pytest.approx(50)
    assert row["share_seen"] == pytest.approx(25 / 60)  # 0-15 and 50-60 of 60 s
    assert row["screens_viewed"] == 3 and row["time_to_first_annotation_s"] == pytest.approx(20)
    (visit,) = t.visits
    assert visit["recordings_finished"] == 1 and visit["annotations_saved"] == 1 and visit["screen"] == "1920x1080"


def test_order_runs_across_visits_and_modes(tmp_path):
    for day, mode in ((0, "practice"), (1, "standard")):
        b = LogBuilder(tmp_path / f"v{day}.jsonl", "A01", T0 + timedelta(days=day), mode=mode)
        b.recording(0.0, "r1", 1, annotations=[5.0], finish=10.0)
        b.recording(20.0, "r2", 2, annotations=[25.0], finish=30.0)
        b.write()
    t = rows_for(tmp_path / "v1.jsonl", tmp_path / "v0.jsonl")
    assert [(r["mode"], r["recording"], r["order"], r["order_in_mode"]) for r in t.recordings] == [
        ("practice", "r1", 1, 1), ("practice", "r2", 2, 2), ("standard", "r1", 3, 1), ("standard", "r2", 4, 2)]


def test_training_measures_are_summarised(tmp_path):
    b = LogBuilder(tmp_path / "v.jsonl", "A01", T0, mode="practice", context_id="pilot")
    b.recording(0.0, "r1", 1, annotations=[5.0], finish=None)
    b.context = {"recording": "r1", "window_no": 1}
    b.event(6.0, "guided_check", ok=False)
    b.event(7.0, "guided_step_completed", attempts=2, stars=2, seconds=7.0)
    b.event(9.0, "guided_show_me")
    b.event(12.0, "guided_step_completed", attempts=3, stars=1, seconds=5.0, used_show_me=True)
    b.event(13.0, "recording_finished", n_annotations=1)
    b.context = {}
    b.event(14.0, "practice_scored", recording_id="r1", event_f1=0.75, passed=False)  # after the window closed
    for i, ok in enumerate((True, False, True, True)):
        b.event(20.0 + i, "quiz_answer", item_id=f"q{i}", correct=ok, response_time_s=2.0 + i)
    b.write()
    rows = {r["segment"]: r for r in rows_for(b.path).recordings}
    rec, quiz = rows["recording"], rows["quiz"]
    # One press of Show me (its event), which the second step's used_show_me does not count again.
    assert rec["guided_steps"] == 2 and rec["guided_attempts"] == 5 and rec["guided_show_me"] == 1
    assert rec["guided_stars_mean"] == pytest.approx(1.5) and rec["guided_seconds_per_step"] == pytest.approx(6)
    assert rec["practice_score"] == pytest.approx(0.75) and rec["score"] == pytest.approx(0.75)
    assert rec["practice_passed"] is False
    assert quiz["quiz_items"] == 4 and quiz["quiz_correct"] == 3 and quiz["score"] == pytest.approx(0.75)
    assert quiz["quiz_mean_response_s"] == pytest.approx(3.5)


def test_crashed_and_foreign_logs_are_read_safely(tmp_path):
    b = LogBuilder(tmp_path / "a.jsonl", "A01", T0)
    b.recording(0.0, "r1", 1, annotations=[5.0])
    path = b.write(closed=None)
    with path.open("a", encoding="utf-8") as fh:
        fh.write('{"seq": 99, "t": 1')  # cut short by a crash
    v = read_visit_log(path)
    assert v.bad_lines == 1 and not v.closed and v.close_reason.startswith("not closed")
    (tmp_path / "other.jsonl").write_text('{"hello": 1}\n', encoding="utf-8")
    newer = tmp_path / "newer.jsonl"
    newer.write_text(json.dumps({"type": "header", "schema": "electroclean.interaction_log",
                                 "schema_version": "9.0.0"}) + "\n", encoding="utf-8")
    visits, warnings = read_logs(find_logs([tmp_path]))
    assert [x.path.name for x in visits] == ["a.jsonl"]
    assert any("not an ElectroClean" in w for w in warnings) and any("not supported" in w for w in warnings)
    assert any("could not be read" in w for w in warnings)
    (row,) = summarise(visits).recordings
    assert row["outcome"] == "not_finished" and row["final_annotations"] == 1


def test_cli_writes_tables_and_report(tmp_path, capsys):
    root = demo_logs(tmp_path / "results")
    out = tmp_path / "out"
    assert activity_main([str(root), "--out", str(out), "--events"]) == 0
    for name in ("visits.tsv", "recordings.tsv", "events.tsv", "about_these_tables.txt", "activity_report.html"):
        assert (out / name).is_file(), name
    header = (out / "recordings.tsv").read_text(encoding="utf-8").splitlines()[0].split("\t")
    assert header[:5] == ["annotator_id", "visit_id", "mode", "context_id", "recording"]
    page = (out / "activity_report.html").read_text(encoding="utf-8")
    assert "Active minutes per recording" in page and "<svg" in page and "A02" in page
    assert "18 recording(s) finished" in capsys.readouterr().out
    # Annotators got faster in the demo: the change from first to last recordings is negative.
    tables, _ = write_activity([root], tmp_path / "out2", report=False)
    a01 = [r for r in tables.recordings if r["annotator_id"] == "A01"]
    assert a01[-1]["seconds_per_annotation"] < a01[0]["seconds_per_annotation"]
    assert activity_main([str(tmp_path / "empty_dir_missing")]) == 2
    (tmp_path / "empty").mkdir()
    assert activity_main([str(tmp_path / "empty")]) == 1


# ------------------------------------------------------------- real sessions
pytest.importorskip("PySide6")

import pyqtgraph as pg  # noqa: E402
from qtpy.QtCore import Qt  # noqa: E402
from qtpy.QtTest import QTest  # noqa: E402
from qtpy.QtWidgets import QApplication, QInputDialog, QLineEdit, QMessageBox  # noqa: E402


@pytest.fixture(scope="module")
def qapp():
    return pg.mkQApp("ElectroClean-tests")


def wait(ms: int = 60) -> None:
    QTest.qWait(ms)
    QApplication.processEvents()


def _events(path):
    return [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines()]


@pytest.mark.gui
def test_a_real_session_is_logged(qapp, dataset):
    from electroclean.app.gui.app_controller import AppController
    from electroclean.app.gui.dialogs import ScriptedPrompts
    from electroclean.app.gui.start_window import StartRequest
    from tests.test_gui import desktop_size

    root, _ = dataset
    ctrl = AppController(prompts=ScriptedPrompts({"Continue?": "Back to the start window"}), synchronous_loading=True)
    assert ctrl.begin(StartRequest(annotator_id="A01", display_name="Private Name", dataset_root=root,
                                   output_root=None, mode="standard"))
    ws = ctrl.workspace
    assert ws.log is ctrl.log and ctrl.log.enabled
    desktop_size(ws)
    wait(300)
    QTest.keyClick(ws.browser, Qt.Key_3)
    wait()
    ws.browser._fake_click((4.0, 5.0), xform="data", kind="drag", add_points=[(5.0, 5.0)])
    wait()
    QTest.keyClick(ws.browser, Qt.Key_Right)
    wait(400)
    times = iter([12.0, 13.0])
    ws.pointer_time = lambda: next(times)  # where the pointer is when M is pressed
    QTest.keyClick(ws.browser, Qt.Key_M)
    QTest.keyClick(ws.browser, Qt.Key_M)
    wait()
    QTest.keyClick(ws.browser, Qt.Key_Z, Qt.ControlModifier)
    wait()
    assert ws.save_and_finish()
    wait(100)
    assert ctrl.log is NULL_LOG  # the visit ended (back to the start window)
    (path,) = list((ctrl.layout.root / "interaction_logs" / "annotator-A01").glob("*_standard.jsonl"))
    text = path.read_text(encoding="utf-8")
    assert "Private Name" not in text  # the display name is never logged
    ev = _events(path)
    head = ev[0]
    assert head["annotator_id"] == "A01" and head["mode"] == "standard" and head["screens"]
    kinds = [e["type"] for e in ev]
    for k in ("visit_started", "recording_opened", "viewer_ready", "view", "shortcut", "mouse_press",
              "annotation_created", "undo", "recording_finished", "log_closed"):
        assert k in kinds, k
    rid = next(e for e in ev if e["type"] == "recording_opened")["recording"]
    inside = ev[kinds.index("recording_opened"):kinds.index("recording_finished") + 1]
    assert all(e.get("recording") == rid and e.get("window_no") == 1 for e in inside)
    assert any(e["type"] == "shortcut" and e["action"].startswith("Type 3") for e in ev)
    press = next(e for e in ev if e["type"] == "mouse_press" and e.get("area") == "eeg")
    assert press["eeg_t"] == pytest.approx(4.0, abs=0.1) and press.get("eeg_channel")
    created = [e for e in ev if e["type"] == "annotation_created"]
    assert [e["via"] for e in created] == ["eeg_drag", "shortcut:Mark start, then end"]
    assert created[0]["annotations"][0]["label"] == "EMG-artifact"
    assert next(e for e in ev if e["type"] == "recording_finished")["n_annotations"] == 1
    assert ev[-1]["type"] == "log_closed" and ev[-1]["reason"] == "back_to_start"
    (row,) = rows_for(path).recordings
    assert (row["annotations_created"], row["created_by_drag"], row["created_by_keys"]) == (2, 1, 1)
    assert row["undos"] == 1 and row["final_annotations"] == 1 and row["shortcuts"] >= 4
    assert 0 < row["share_seen"] <= 1 and row["outcome"] == "finished"


@pytest.mark.gui
def test_logging_can_be_switched_off(qapp, dataset):
    from electroclean.app.gui.app_controller import AppController
    from electroclean.app.gui.dialogs import ScriptedPrompts
    from electroclean.app.gui.start_window import StartRequest, StartWindow

    root, _ = dataset
    (root / "electroclean_study.json").write_text(json.dumps({"settings": {"logging": {"interactions": False}}}),
                                                  encoding="utf-8")
    sw = StartWindow()
    sw.dataset.setText(str(root))
    sw.refresh()
    assert not sw.logging_note.isVisibleTo(sw)  # the notice only shows when the study records interactions
    ctrl = AppController(prompts=ScriptedPrompts(), synchronous_loading=True)
    assert ctrl.begin(StartRequest(annotator_id="A01", display_name="", dataset_root=root, output_root=None,
                                   mode="standard"))
    assert ctrl.log is NULL_LOG and ctrl.recorder is None
    ctrl.workspace._closing_ok = True
    ctrl.workspace.browser.close()
    wait()
    assert not (ctrl.layout.root / "interaction_logs").exists()


@pytest.mark.gui
def test_typed_text_and_passwords_are_never_logged(qapp, tmp_path):
    from electroclean.app.gui.interaction_capture import InteractionRecorder

    log = InteractionLog(tmp_path / "v.jsonl", {})
    rec = InteractionRecorder(log, pointer_hz=0, idle_after_s=30)
    plain, secret = QLineEdit(), QLineEdit()
    plain.setObjectName("search")
    secret.setEchoMode(QLineEdit.Password)
    dlg = QInputDialog()
    dlg.setTextEchoMode(QLineEdit.Password)
    for w in (plain, secret, dlg):
        w.show()
    wait()
    QTest.keyClicks(plain, "SECRETWORD")
    QTest.keyClicks(secret, "PASSWORD123")
    QTest.keyClicks(dlg.findChild(QLineEdit), "HIDDENPASS")
    plain.clearFocus()
    secret.clearFocus()
    for w in (plain, secret, dlg):
        w.hide()
    wait()
    rec.close("test")
    text = (tmp_path / "v.jsonl").read_text(encoding="utf-8")
    for word in ("SECRETWORD", "PASSWORD123", "HIDDENPASS"):
        assert word not in text
    ev = _events(tmp_path / "v.jsonl")
    assert not any(e["type"] == "key" for e in ev)  # no keys typed into fields, one by one
    edited = [e for e in ev if e["type"] == "field_edited"]
    assert [e.get("name") for e in edited] == ["search"]  # the plain field, not the password ones
    for w in (plain, secret, dlg):
        w.deleteLater()


@pytest.mark.gui
def test_dialogs_idle_periods_and_closing(qapp, tmp_path):
    import time

    from electroclean.app.gui.interaction_capture import InteractionRecorder, current_recorder

    log = InteractionLog(tmp_path / "v.jsonl", {})
    rec = InteractionRecorder(log, pointer_hz=5, idle_after_s=30)
    assert current_recorder() is rec
    box = QMessageBox(QMessageBox.Question, "Save and Finish", "Save 3 annotations?")
    box.setProperty("ec_title", "Save and Finish")  # as UserPrompts does: macOS ignores message-box titles
    yes = box.addButton("Save and Finish", QMessageBox.AcceptRole)
    box.addButton("Keep annotating", QMessageBox.RejectRole)
    box.show()
    wait()
    yes.click()
    wait()
    rec.check_idle(now=time.monotonic() + 31)  # half a minute without input
    QTest.keyClick(box, Qt.Key_A)  # any input ends the idle period
    rec.close("test")
    rec.close("again")  # closing twice is harmless
    assert current_recorder() is None
    ev = _events(tmp_path / "v.jsonl")
    shown = next(e for e in ev if e["type"] == "dialog_shown")
    closed = next(e for e in ev if e["type"] == "dialog_closed")
    assert shown["title"] == "Save and Finish" and "Keep annotating" in shown["buttons"]
    assert closed["button"] == "Save and Finish"
    kinds = [e["type"] for e in ev]
    assert kinds.index("idle_start") < kinds.index("idle_end")
    assert kinds.count("log_closed") == 1
    box.deleteLater()


@pytest.mark.gui
def test_admin_tools_write_the_activity_report(qapp, dataset):
    from electroclean.app.gui.app_controller import AppController
    from electroclean.app.gui.dialogs import ScriptedPrompts
    from electroclean.training.gui import AdminDialog

    root, _ = dataset
    demo_logs(root / "Annotated_Events", annotators=("A01",), recordings=2)
    ctrl = AppController(prompts=ScriptedPrompts(), synchronous_loading=True)
    dlg = AdminDialog(ctrl, root, ctrl.prompts)
    dlg.show_activity()
    assert "recording(s) finished" in dlg.p_text.toPlainText()
    reports = list((root / "Annotated_Events" / "activity_reports").rglob("activity_report.html"))
    assert len(reports) == 1
    dlg.deleteLater()
