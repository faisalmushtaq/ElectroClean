"""Autosave of unfinished work and resuming it later."""

from __future__ import annotations

import json
import time

import pytest

from electrotag.app.session.autosave import autosaves_for, find_autosave, read_autosave
from electrotag.app.session.register import CompletionRegister
from tests.conftest import SUB1, make_session


def _open(layout, settings, catalogue, loaded, **kw):
    s = make_session(layout, settings, catalogue, loaded, **kw)
    s.start()
    s.start_timer()
    return s


def test_autosave_is_written_only_when_useful(layout, settings, catalogue, loaded):
    s = _open(layout, settings, catalogue, loaded)
    assert not s.autosave()  # nothing worth keeping yet
    s.store.add_interval("EMG-artifact", 2.0, 3.0)
    assert s.autosave(min_interval_s=0)
    assert not s.autosave(min_interval_s=0)  # nothing changed
    s.store.add_interval("Eye-blink-artifact", 5.0, 5.4)
    assert not s.autosave(min_interval_s=60)  # changed, but too soon
    assert s.autosave(min_interval_s=0)
    rec = read_autosave(s.autosave_path)
    assert rec.n_annotations == 2 and rec.recording_id == SUB1 and rec.session_id == s.session_id


def test_unfinished_work_is_restored_with_its_time(layout, settings, catalogue, loaded):
    s = _open(layout, settings, catalogue, loaded)
    s.store.add_interval("EMG-artifact", 2.0, 3.0)
    time.sleep(0.05)
    # The autosave holds the time spent when it was written. Writing it (with a flush to disk) can take
    # tens of milliseconds, notably on Windows, so the clock is read on both sides of the save.
    before = s.elapsed_s
    s.autosave(force=True)
    after = s.elapsed_s
    s.lock.release()  # the computer crashed: no Save and Finish, no abandon
    record = find_autosave(layout, SUB1, "A01", "standard", "")
    assert record is not None and record.problems_with(loaded) == []
    assert before - 0.001 <= record.elapsed_s <= after + 0.001
    s2 = _open(layout, settings, catalogue, loaded, resume=record)
    assert [a.label for a in s2.store.annotations()] == ["EMG-artifact"]
    assert s2.elapsed_s >= record.elapsed_s
    res = s2.finish()
    assert res.elapsed_s >= record.elapsed_s
    meta = json.loads(res.commit.paths["session_json"].read_text(encoding="utf-8"))
    assert meta["timing"]["elapsed_in_earlier_sessions_seconds"] == pytest.approx(record.elapsed_s)
    assert meta["timing"]["resumed_from_autosave"][0]["session_id"] == s.session_id
    assert not s2.autosave_path.exists()  # saved: the autosave is removed
    assert CompletionRegister(layout).is_completed(SUB1, "A01")


def test_discarding_removes_the_autosave_and_finishing_later_keeps_it(layout, settings, catalogue, loaded):
    s = _open(layout, settings, catalogue, loaded)
    s.store.add_interval("EMG-artifact", 2.0, 3.0)
    s.abandon("closed to finish later", keep_autosave=True)
    assert s.autosave_path.exists() and not s.lock.path.exists()
    s2 = _open(layout, settings, catalogue, loaded, resume=find_autosave(layout, SUB1, "A01", "standard", ""))
    s2.abandon()  # discard and close
    assert not s2.autosave_path.exists()


def test_autosave_that_no_longer_fits_the_recording_is_detected(layout, settings, catalogue, loaded):
    s = _open(layout, settings, catalogue, loaded)
    s.store.add_interval("EMG-artifact", 2.0, 3.0)
    s.autosave(force=True)
    record = find_autosave(layout, SUB1, "A01", "standard", "")
    record.source_fingerprint = {"eeg": {"size": 1, "sha256": "0" * 64}}
    assert record.problems_with(loaded) == ["the eeg file has changed"]
    assert [r.recording_id for r in autosaves_for(layout, "A01", "standard", "")] == [SUB1]
    assert autosaves_for(layout, "B02", "standard", "") == []
