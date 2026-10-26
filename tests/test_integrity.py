"""Data-integrity edge cases: concurrent sessions, relocated folders, failing moves, leftovers.

Each test reproduces a failure found in review and checks that ElectroClean
now keeps the outputs and the completion register consistent.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import time

import pytest

import electroclean.app.session.transaction as tx
from electroclean.app.eeg.loading import RecordingLoadError, load_recording
from electroclean.app.io.discovery import discover_recordings
from electroclean.app.io.locking import FileLock, LockError
from electroclean.app.io.naming import OutputLayout
from electroclean.app.io.tsv import parse_tsv_text
from electroclean.app.session.register import CompletionRegister
from electroclean.app.session.session import SessionError
from electroclean.app.session.transaction import ExportCommitError, recover_interrupted_exports
from tests.conftest import SUB1, SUB2, make_session

FINAL = ("annotator-A01", "sub-001", "eeg")


def _open(layout, settings, catalogue, loaded, **kw):
    s = make_session(layout, settings, catalogue, loaded, **kw)
    s.start()
    s.start_timer()
    s.store.add_interval("EMG-artifact", 2.0, 3.0)
    return s


# ------------------------------------------------------------ concurrency
@pytest.mark.parametrize("stage", ["write:events_json", "validate", "commit:annotations_json", "register"])
def test_recovery_leaves_a_save_in_progress_alone(layout, settings, catalogue, loaded, stage):
    """Another window starting up while this one is saving must not roll the save back."""
    s = _open(layout, settings, catalogue, loaded)
    seen = []

    def other_instance_starts(name):
        if name == stage:
            seen.extend(a.action for a in recover_interrupted_exports(layout, CompletionRegister(layout)))

    s.finish(fault=other_instance_starts)
    assert seen == ["in_progress"]
    assert CompletionRegister(layout).is_completed(SUB1, "A01")
    assert len(list(layout.root.joinpath(*FINAL).iterdir())) == 5
    assert not layout.quarantine.exists() or not any(layout.quarantine.iterdir())


def test_breaking_a_stale_lock_never_steals_a_fresh_one(tmp_path):
    path = tmp_path / "register.lock"
    path.write_text(json.dumps({"pid": 999999, "host": socket.gethostname()}))  # crashed process
    x, y = FileLock(path, {"who": "X"}, stale_after_s=300), FileLock(path, {"who": "Y"}, stale_after_s=300)
    original = FileLock._break_stale
    state = {"raced": False}

    def racing_break(self, judged):
        # Y has judged the old lock stale; before it breaks it, X breaks it and takes the lock.
        if self is y and not state["raced"]:
            state["raced"] = True
            x.acquire()
        return original(self, judged)

    try:
        FileLock._break_stale = racing_break
        with pytest.raises(LockError):
            y.acquire()
    finally:
        FileLock._break_stale = original
    assert x.held and not y.held and x.owns()
    assert FileLock.read_owner(path)["who"] == "X"
    x.release()
    assert not path.exists()


def test_lock_age_uses_the_folders_clock_and_heartbeat(tmp_path, monkeypatch):
    path = tmp_path / "rec.lock"
    held = FileLock(path, stale_after_s=300).acquire()
    # Another computer whose clock is ten minutes ahead does not see a fresh lock as stale.
    import electroclean.app.io.locking as locking

    monkeypatch.setattr(locking.socket, "gethostname", lambda: "LAB-PC-2")
    real_time = time.time
    monkeypatch.setattr(locking.time, "time", lambda: real_time() + 600)
    other = FileLock(path, stale_after_s=300)
    assert not other.is_stale(FileLock.read_owner(path))
    # A lock that has not been refreshed for longer than the limit is stale; refreshing it cures that.
    old = real_time() - 900
    os.utime(path, (old, old))
    assert other.is_stale(FileLock.read_owner(path))
    monkeypatch.undo()
    assert held.refresh()
    assert not FileLock(path, stale_after_s=300).is_stale(FileLock.read_owner(path))


def test_session_heartbeat_and_lost_lock(layout, settings, catalogue, loaded):
    s = _open(layout, settings, catalogue, loaded)
    old = time.time() - 4 * 3600
    os.utime(s.lock.path, (old, old))
    assert s.heartbeat(interval_s=0)  # refreshes the lock
    assert time.time() - s.lock.path.stat().st_mtime < 60
    # The lock is lost (another computer broke it while this one slept) and nobody holds it now.
    s.lock.path.unlink()
    assert not s.heartbeat(interval_s=0)
    s.finish()  # takes the lock again and saves
    assert CompletionRegister(layout).is_completed(SUB1, "A01")


def test_lost_lock_taken_by_another_session_blocks_saving(layout, settings, catalogue, loaded):
    s = _open(layout, settings, catalogue, loaded)
    s.lock.path.unlink()
    FileLock(s.lock.path, {"annotator_id": "A01"}).acquire()  # the same annotator on another computer
    with pytest.raises(SessionError, match="another session"):
        s.finish()
    assert not CompletionRegister(layout).is_completed(SUB1, "A01")


# --------------------------------------------------------- recovery paths
def test_recovery_after_the_results_folder_is_reached_by_another_path(dataset, layout, settings, catalogue, loaded):
    s = _open(layout, settings, catalogue, loaded)

    def register_unavailable(name):
        if name == "register":
            raise OSError("register busy")

    with pytest.raises(ExportCommitError) as err:
        s.finish(fault=register_unavailable)
    assert err.value.committed
    root, _ = dataset
    moved = root.parent / "dataset-moved"
    shutil.move(str(root), str(moved))  # e.g. another drive letter, or the folder was moved
    new_layout = OutputLayout(moved / "Annotated_Events")
    reg = CompletionRegister(new_layout)
    actions = recover_interrupted_exports(new_layout, reg)
    assert [a.action for a in actions] == ["rolled_forward"]
    assert reg.is_completed(SUB1, "A01")
    assert len(list(new_layout.root.joinpath(*FINAL).iterdir())) == 5


def test_failed_rollback_is_retried(layout, settings, catalogue, loaded, monkeypatch):
    s = _open(layout, settings, catalogue, loaded)
    real_replace = os.replace
    blocked = {"on": True}

    def sharing_violation(src, dst):
        if blocked["on"] and str(src).endswith("_events.tsv") and "annotator-A01" in str(src):
            raise PermissionError("[WinError 32] The file is being used by another process")
        return real_replace(src, dst)

    def fail_on_verify(name):
        if name == "verify":
            raise OSError("network drive hiccup")

    monkeypatch.setattr(tx.os, "replace", sharing_violation)
    with pytest.raises(ExportCommitError, match="will retry"):
        s.finish(fault=fail_on_verify)
    final_dir = layout.root.joinpath(*FINAL)
    assert [p.name for p in final_dir.iterdir()] == ["sub-001_task-rest_eeg_annotator-A01_events.tsv"]
    reg = CompletionRegister(layout)
    assert [a.action for a in recover_interrupted_exports(layout, reg)] == ["rollback_incomplete"]
    blocked["on"] = False  # the other program closed the file
    assert [a.action for a in recover_interrupted_exports(layout, reg)] == ["rolled_back"]
    assert not any(final_dir.iterdir()) and not reg.is_completed(SUB1, "A01")
    assert not any(layout.staging.iterdir())


def test_unreadable_journal_keeps_staged_files(layout):
    staging = layout.staging / "S1"
    staging.mkdir(parents=True)
    (staging / "transaction.json").write_text("{not json")
    (staging / "x_events.tsv").write_text("onset\n")
    (action,) = recover_interrupted_exports(layout, CompletionRegister(layout))
    assert action.action == "rolled_back"
    assert (layout.quarantine / "S1" / "x_events.tsv").exists()
    assert (layout.quarantine / "S1" / "transaction-unreadable.json").exists()


def test_failure_after_the_register_update_still_counts_as_saved(layout, settings, catalogue, loaded, monkeypatch):
    s = _open(layout, settings, catalogue, loaded)
    real = tx._write_journal

    def flaky(staging, journal):
        if journal["state"] == "complete":
            raise OSError("[WinError 5] Access is denied")
        return real(staging, journal)

    monkeypatch.setattr(tx, "_write_journal", flaky)
    result = s.finish()  # no error: the outputs are final and registered
    assert result.commit.register_updated and s.state == "finished"
    monkeypatch.setattr(tx, "_write_journal", real)
    # Whatever is left of the journal is tidied up without a second register row.
    assert all(a.action in ("rolled_forward", "cleaned_up")
               for a in recover_interrupted_exports(layout, CompletionRegister(layout)))
    assert len(CompletionRegister(layout).entries()) == 1


def test_completed_list_is_regenerated_if_it_was_not_written(layout):
    reg = CompletionRegister(layout)
    entry = {"recording_id": SUB1, "annotator_id": "A01", "mode": "standard", "session_id": "S1"}
    reg.add(entry)
    layout.completed_list("A01").unlink()
    assert reg.add(entry) is False  # already registered
    assert layout.completed_list("A01").read_text() == SUB1 + "\n"


# --------------------------------------------------------------- leftovers
def test_unregistered_complete_outputs_are_registered_at_start(layout, settings, catalogue, loaded):
    s = _open(layout, settings, catalogue, loaded)
    s.finish()
    reg = CompletionRegister(layout)
    layout.register.unlink()  # the register row was lost
    assert not reg.is_completed(SUB1, "A01")
    s2 = make_session(layout, settings, catalogue, loaded)
    with pytest.raises(SessionError, match="already saved"):
        s2.start()
    assert reg.is_completed(SUB1, "A01")
    assert not s2.lock.path.exists()


def test_incomplete_leftover_outputs_are_moved_aside_at_start(layout, settings, catalogue, loaded):
    final_dir = layout.root.joinpath(*FINAL)
    final_dir.mkdir(parents=True)
    (final_dir / "sub-001_task-rest_eeg_annotator-A01_events.tsv").write_text("onset\tduration\n")
    s = _open(layout, settings, catalogue, loaded)
    assert any("moved to" in w for w in loaded.warnings)
    s.finish()  # not blocked by the leftover
    assert CompletionRegister(layout).is_completed(SUB1, "A01")
    assert len(list(final_dir.iterdir())) == 5
    assert list(layout.quarantine.glob("leftover-*/*_events.tsv"))


# ------------------------------------------------------------- inputs
def test_symlinked_recordings_keep_their_dataset_path(tmp_path, dataset):
    root, _ = dataset
    store = tmp_path / "annex"
    store.mkdir()
    vhdr = root / "sub-002" / "eeg" / "sub-002_task-rest_eeg.vhdr"
    target = store / "SHA256E-s123--abc.vhdr"
    shutil.move(str(vhdr), str(target))
    try:
        vhdr.symlink_to(target)
    except OSError:
        pytest.skip("symbolic links not available")
    ids = [r.recording_id for r in discover_recordings(root)]
    assert ids == [SUB1, SUB2]


def test_results_folder_excluded_by_path_not_name(tmp_path, dataset):
    root, _ = dataset
    ids = [r.recording_id for r in discover_recordings(root, exclude_dir_names=(), exclude_paths=(root / "sub-001",))]
    assert ids == [SUB2]
    # A results folder called "eeg" must not hide every BIDS eeg folder.
    ids = [r.recording_id for r in discover_recordings(root, exclude_dir_names=(), exclude_paths=(root / "eeg",))]
    assert ids == [SUB1, SUB2]


def test_sidecars_with_bom_or_nan_and_inherited_fingerprints(dataset, settings, catalogue):
    root, _ = dataset
    ev_json = root / "sub-001" / "eeg" / "sub-001_task-rest_events.json"
    original = json.loads(ev_json.read_text())
    original["TestNote"] = "made in Notepad"
    ev_json.write_bytes(b"\xef\xbb\xbf" + json.dumps(original).encode())
    inherited = root / "task-rest_events.json"
    inherited.write_text('{"value": {"Description": "code"}, "Offset": NaN}')
    rec = {r.recording_id: r for r in discover_recordings(root)}[SUB1]
    lr = load_recording(rec, settings, settings.filters, catalogue)
    try:
        assert lr.events_sidecar["TestNote"] == "made in Notepad"
        assert any("NaN" in w for w in lr.warnings)
        assert "events_json_inherited_1" in lr.fingerprint
        s = make_session(OutputLayout(root / "Annotated_Events"), settings, catalogue, lr)
        s.start()
        s.start_timer()
        s.finish()  # NaN does not prevent saving
    finally:
        lr.close()


def test_events_tsv_with_electroclean_columns_refused_at_load(dataset, settings, catalogue):
    root, _ = dataset
    ev = root / "sub-001" / "eeg" / "sub-001_task-rest_events.tsv"
    lines = ev.read_text().splitlines()
    ev.write_text("\n".join([lines[0] + "\tannotator_id"] + [ln + "\tX" for ln in lines[1:]]) + "\n")
    rec = {r.recording_id: r for r in discover_recordings(root)}[SUB1]
    with pytest.raises(RecordingLoadError, match="ElectroClean uses"):
        load_recording(rec, settings, settings.filters, catalogue)


def test_tsv_rows_of_empty_cells_are_kept():
    cols, rows = parse_tsv_text("a\tb\n1\t2\n\t\n\n")
    assert cols == ["a", "b"] and rows == [["1", "2"], ["", ""]]
