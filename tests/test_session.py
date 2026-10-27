"""Safe completion, per-annotator tracking, locking and recovery (tests 15, 16, 17)."""

from __future__ import annotations

import json
import os
import random
import time

import pytest

from electroclean.app.eeg.loading import RecordingLoadError, load_recording
from electroclean.app.io.discovery import discover_recordings
from electroclean.app.io.locking import FileLock, LockError
from electroclean.app.session.failures import FailureLog, SessionLog
from electroclean.app.session.register import CompletionRegister
from electroclean.app.session.selection import balanced_allocation, select_next, seeded_order
from electroclean.app.session.session import SessionError
from electroclean.app.session.transaction import ExportCommitError, recover_interrupted_exports
from tests.conftest import SUB1, SUB2, make_session


def _finish(session, label="EMG-artifact"):
    session.start()
    session.start_timer()
    session.store.add_interval(label, 2.0, 3.0)
    time.sleep(0.02)
    return session.finish()


def test_full_session_outputs(layout, settings, catalogue, loaded):
    s = make_session(layout, settings, catalogue, loaded, display_name="Dr Test")
    res = _finish(s)
    assert res.elapsed_s >= 0.02
    names = sorted(p.name for p in res.commit.paths.values())
    assert names == sorted(
        [
            "sub-001_task-rest_eeg_annotator-A01_events.tsv",
            "sub-001_task-rest_eeg_annotator-A01_events.json",
            "sub-001_task-rest_eeg_annotator-A01_annotations.json",
            "sub-001_task-rest_eeg_annotator-A01_time_viewed.txt",
            "sub-001_task-rest_eeg_annotator-A01_session.json",
        ]
    )
    assert res.commit.final_dir == layout.root / "annotator-A01" / "sub-001" / "eeg"
    assert float(res.commit.paths["time_viewed"].read_text()) == pytest.approx(res.elapsed_s)
    meta = json.loads(res.commit.paths["session_json"].read_text())
    for key in ("start_timestamp", "finish_timestamp", "elapsed_seconds"):
        assert meta["timing"][key] is not None
    assert meta["annotator"] == {"annotator_id": "A01", "display_name": "Dr Test"}
    assert meta["application"]["version"]
    assert meta["filters"]["selected"]["notch_hz"] == 50.0
    assert meta["annotations"]["n_annotations"] == 1
    assert not list(layout.staging.iterdir())
    assert not s.lock.path.exists()


def test_completion_is_per_annotator(dataset, layout, settings, catalogue, recordings, loaded):
    _finish(make_session(layout, settings, catalogue, loaded, "A01"))
    reg = CompletionRegister(layout)
    assert reg.is_completed(SUB1, "A01")
    assert not reg.is_completed(SUB1, "A02")
    recs = list(recordings.values())
    r1 = select_next(recs, annotator_id="A01", completed=reg.completed("A01"), failed=(), strategy="seeded", seed=1)
    assert r1.recording.recording_id == SUB2
    r2 = select_next(recs, annotator_id="A02", completed=reg.completed("A02"), failed=(), strategy="manual",
                     manual_assignments={"A02": (SUB1,)})
    assert r2.recording.recording_id == SUB1  # still available to another annotator
    # The second annotator can complete the same recording independently.
    _finish(make_session(layout, settings, catalogue, loaded, "A02"))
    assert reg.annotators_for(SUB1) == {"A01", "A02"}
    assert layout.completed_list("A01").read_text() == SUB1 + "\n"
    assert layout.completed_list("A02").read_text() == SUB1 + "\n"


def test_completed_recording_not_reopened_or_overwritten(layout, settings, catalogue, loaded):
    _finish(make_session(layout, settings, catalogue, loaded))
    again = make_session(layout, settings, catalogue, loaded)
    with pytest.raises(SessionError):
        again.start()
    # An administrator-approved repeat gets a new attempt number, never overwrites.
    repeat = make_session(layout, settings, catalogue, loaded, allow_repeat=True)
    res = _finish(repeat)
    assert "attempt-02" in res.output_basename
    assert len(list((layout.root / "annotator-A01" / "sub-001" / "eeg").glob("*_annotations.json"))) == 2


def test_simultaneous_sessions_blocked_by_lock(layout, settings, catalogue, loaded):
    s1 = make_session(layout, settings, catalogue, loaded)
    s1.start()
    s2 = make_session(layout, settings, catalogue, loaded)
    with pytest.raises(LockError):
        s2.start()
    # A different annotator is not blocked.
    s3 = make_session(layout, settings, catalogue, loaded, "A02")
    s3.start()
    s1.abandon()
    s3.abandon()
    s2.start()  # free again after the first session ended
    s2.abandon()


def test_stale_lock_from_dead_process_is_broken(tmp_path):
    path = tmp_path / "x.lock"
    import socket

    path.write_text(json.dumps({"pid": 999999, "host": socket.gethostname(), "created_epoch": time.time()}))
    FileLock(path).acquire()
    path2 = tmp_path / "y.lock"
    path2.write_text(json.dumps({"pid": 1, "host": "elsewhere", "created_epoch": time.time() - 7200}))
    old = time.time() - 7200  # age is judged from the lock file's modification time
    os.utime(path2, (old, old))
    with pytest.raises(LockError):
        FileLock(path2, stale_after_s=3 * 3600).acquire()
    FileLock(path2, stale_after_s=3600).acquire()


@pytest.mark.parametrize(
    "stage", ["write:events_tsv", "write:session_json", "validate", "commit:events_tsv", "commit:session_json", "verify"]
)
def test_write_failure_never_marks_complete(layout, settings, catalogue, loaded, stage):
    s = make_session(layout, settings, catalogue, loaded)
    s.start()
    s.start_timer()
    s.store.add_interval("EMG-artifact", 2, 3)

    def fault(name):
        if name == stage:
            raise OSError(f"simulated failure at {name}")

    with pytest.raises(ExportCommitError):
        s.finish(fault=fault)
    reg = CompletionRegister(layout)
    assert not reg.is_completed(SUB1, "A01")
    final_dir = layout.root / "annotator-A01" / "sub-001" / "eeg"
    assert not final_dir.exists() or not any(final_dir.iterdir())
    assert s.state == "open"  # the annotator can retry
    res = s.finish()  # retry succeeds
    assert reg.is_completed(SUB1, "A01")
    assert len(list(final_dir.iterdir())) == 5
    assert res.n_annotations == 1


def test_register_failure_is_recovered_on_next_start(layout, settings, catalogue, loaded):
    s = make_session(layout, settings, catalogue, loaded)
    s.start()
    s.start_timer()

    def fault(name):
        if name == "register":
            raise OSError("register on an unavailable network drive")

    with pytest.raises(ExportCommitError) as err:
        s.finish(fault=fault)
    assert err.value.committed
    reg = CompletionRegister(layout)
    assert not reg.is_completed(SUB1, "A01")
    actions = recover_interrupted_exports(layout, reg, SessionLog(layout))
    assert [a.action for a in actions] == ["rolled_forward"]
    assert reg.is_completed(SUB1, "A01")


class Crash(BaseException):
    """Simulates the process dying (not caught by the commit's error handling)."""


@pytest.mark.parametrize("stage,expected", [("validate", "rolled_back"), ("commit:time_viewed", "rolled_back"), ("register", "rolled_forward")])
def test_crash_recovery(layout, settings, catalogue, loaded, stage, expected):
    s = make_session(layout, settings, catalogue, loaded)
    s.start()
    s.start_timer()
    s.store.add_interval("EMG-artifact", 2, 3)

    def fault(name):
        if name == stage:
            raise Crash()

    with pytest.raises(Crash):
        s.finish(fault=fault)
    reg = CompletionRegister(layout)
    assert not reg.is_completed(SUB1, "A01")
    actions = recover_interrupted_exports(layout, reg)
    assert [a.action for a in actions] == [expected]
    final_dir = layout.root / "annotator-A01" / "sub-001" / "eeg"
    if expected == "rolled_forward":
        assert reg.is_completed(SUB1, "A01")
        assert len(list(final_dir.iterdir())) == 5
    else:
        assert not reg.is_completed(SUB1, "A01")
        assert not final_dir.exists() or not any(final_dir.iterdir())
        assert any((layout.quarantine).iterdir())
    assert not any(layout.staging.iterdir())


def test_abandoned_session_is_incomplete(layout, settings, catalogue, loaded):
    s = make_session(layout, settings, catalogue, loaded)
    s.start()
    s.start_timer()
    s.store.add_interval("EMG-artifact", 2, 3)
    s.abandon()
    assert not CompletionRegister(layout).is_completed(SUB1, "A01")
    events = [e["event"] for e in SessionLog(layout).entries()]
    assert events == ["session_started", "session_incomplete"]


def test_source_change_during_session_blocks_completion(layout, settings, catalogue, loaded):
    s = make_session(layout, settings, catalogue, loaded)
    s.start()
    s.start_timer()
    ev = loaded.files.events_tsv
    time.sleep(0.01)
    ev.write_text(ev.read_text())  # touched: new modification time
    with pytest.raises(SessionError):
        s.finish()
    assert not CompletionRegister(layout).is_completed(SUB1, "A01")


def test_failure_log_and_exclusion(dataset, layout, settings, catalogue):
    root, _ = dataset
    eeg = root / "sub-002" / "eeg" / "sub-002_task-rest_eeg.eeg"
    eeg.write_bytes(eeg.read_bytes()[:999])
    recs = {r.recording_id: r for r in discover_recordings(root)}
    log = FailureLog(layout)
    with pytest.raises(RecordingLoadError) as err:
        load_recording(recs[SUB2], settings, settings.filters, catalogue)
    log.record(recs[SUB2], SUB2, err.value.kind, str(err.value), annotator_id="A01")
    line = layout.failed_load_txt.read_text().strip().split("\t")
    assert line[1] == SUB2 and "truncated" in line[2]
    assert set(log.unresolved(list(recs.values()), {})) == {SUB2}
    sel = select_next(list(recs.values()), annotator_id="A01", completed=set(), failed=log.unresolved(list(recs.values()), {}),
                      strategy="random")
    assert sel.recording.recording_id == SUB1
    # Fixing the file makes it eligible again.
    time.sleep(0.01)
    eeg.write_bytes(b"\0" * 21 * 4 * 15000)
    assert log.unresolved(list(recs.values()), {}) == {}
    # Failures caused by a setting are lifted when the setting changes.
    log.record(recs[SUB1], SUB1, "filter_error", "bad filter", conditions={"highpass_hz": 1.0})
    assert SUB1 in log.unresolved(list(recs.values()), {"highpass_hz": 1.0})
    assert SUB1 not in log.unresolved(list(recs.values()), {"highpass_hz": 0.5})
    log.mark_resolved(SUB1, "admin checked")
    assert SUB1 not in log.unresolved(list(recs.values()), {"highpass_hz": 1.0})


def test_selection_messages(recordings):
    recs = list(recordings.values())
    done = select_next(recs, annotator_id="A01", completed={SUB1, SUB2}, failed=(), strategy="random")
    assert done.recording is None and "All eligible recordings have been completed" in done.message
    none = select_next(recs, annotator_id="A03", completed=set(), failed=(), strategy="manual", manual_assignments={})
    assert none.recording is None and "No recordings are assigned" in none.message
    skipped = select_next(recs, annotator_id="A01", completed=set(), failed=(), strategy="random", session_excluded={SUB1, SUB2})
    assert skipped.recording is None and "skipped" in skipped.message


def test_seeded_selection_is_reproducible(recordings):
    ids = [f"sub-{i:03d}/eeg/x.vhdr" for i in range(20)]
    assert seeded_order(ids, 7, "A01") == seeded_order(ids, 7, "A01")
    assert seeded_order(ids, 7, "A01") != seeded_order(ids, 7, "A02")
    assert seeded_order(ids, 7, "A01") != seeded_order(ids, 8, "A01")


def test_balanced_allocation_controls_overlap():
    ids = [f"r{i:02d}" for i in range(30)]
    alloc = balanced_allocation(ids, ["A", "B", "C", "D", "E"], 2, seed=3)
    counts = [len(v) for v in alloc.values()]
    assert sum(counts) == 60 and max(counts) - min(counts) <= 1
    per_rec = {}
    for a, rs in alloc.items():
        for r in rs:
            per_rec.setdefault(r, set()).add(a)
    assert all(len(v) == 2 for v in per_rec.values()) and len(per_rec) == 30
    assert balanced_allocation(ids, ["A", "B", "C", "D", "E"], 2, seed=3) == alloc
    random.seed(0)
