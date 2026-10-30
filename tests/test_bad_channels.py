"""Channels an annotator marks bad for the whole recording, the uncertain type, and the store's merge rule.

The bad channels are part of the store's undo history, are saved in the annotations file (``bad_channels``)
and, when there are any, in a BIDS-style ``_channels.tsv`` (``status`` good or bad, with a
``status_description``) beside it; the save checks both before the recording is complete. They are kept apart
from the study's own bad channels, and the agreement analysis reports them in tables of their own.
"""

from __future__ import annotations

import dataclasses
import json
import time

import pytest

from electrotag.app.annotations.labels import UNCERTAIN_LABEL, needs_review
from electrotag.app.annotations.model import AnnotationError
from electrotag.app.annotations.store import AnnotationStore
from electrotag.app.io.canonical import document_from_dict, document_to_dict
from electrotag.app.io.export import bad_channels_from_channels_tsv, channels_tsv_bytes
from electrotag.app.validation.exports import ValidationError, validate_channels_tsv
from tests.conftest import make_session


def _store(loaded, catalogue, **kw):
    return AnnotationStore(loaded.info, catalogue, **kw)


def test_bad_channels_are_undoable_with_the_annotations(loaded, catalogue):
    s = _store(loaded, catalogue)
    names = loaded.info.ch_names
    assert s.bad_channels == ()
    s.add("EMG-artifact", 100, 50)
    assert s.set_channel_bad(names[2]) is True
    assert s.set_channel_bad(names[0]) is True
    assert s.set_channel_bad(names[0]) is False  # already bad: nothing changes, no step in the history
    assert s.bad_channels == (names[0], names[2])  # in recording order
    assert s.undo_description == f"mark {names[0]} bad"
    s.undo()
    assert s.bad_channels == (names[2],) and len(s) == 1
    s.redo()
    assert s.bad_channels == (names[0], names[2])
    s.set_channel_bad(names[2], False)
    assert s.bad_channels == (names[0],)
    with pytest.raises(AnnotationError):
        s.set_channel_bad("Nope")
    for _ in range(3):
        s.undo()
    assert s.bad_channels == () and len(s) == 1


def test_overlaps_join_but_gaps_never_do_and_the_setting_turns_joining_off(loaded, catalogue):
    s = _store(loaded, catalogue)
    a = s.add("EMG-artifact", 100, 100)
    s.add("EMG-artifact", 201, 100)  # a gap of one sample: two occurrences
    s.add("EMG-artifact", 301, 50)  # touching the one before: separate too
    assert len(s) == 3 and s.last_auto_merged == 0
    m = s.add("EMG-artifact", 150, 60)  # overlaps the first two
    assert len(s) == 2 and s.last_auto_merged == 2 and m.annotation_id == a.annotation_id
    s.undo()
    assert len(s) == 3
    off = _store(loaded, catalogue, auto_merge=False)
    off.add("EMG-artifact", 100, 100)
    off.add("EMG-artifact", 150, 100)
    assert len(off) == 2 and off.last_auto_merged == 0


def test_the_uncertain_type_is_hed_data_artifact(catalogue):
    assert UNCERTAIN_LABEL == "Data-artifact" and catalogue.value_for(UNCERTAIN_LABEL) == 130
    assert needs_review("Data-artifact") and not needs_review("Eye-artifact")


def test_saved_verified_and_read_back(layout, settings, catalogue, loaded):
    s = make_session(layout, settings, catalogue, loaded)
    s.start()
    s.start_timer()
    names = loaded.info.ch_names
    s.store.add_interval("EMG-artifact", 2.0, 3.0)
    s.store.add_interval(UNCERTAIN_LABEL, 4.0, 4.5)
    s.store.set_channel_bad(names[1])
    time.sleep(0.01)
    res = s.finish()
    paths = res.commit.paths
    assert set(paths) == {"events_tsv", "events_json", "annotations_json", "time_viewed", "session_json", "channels_tsv"}
    data = json.loads(paths["annotations_json"].read_text(encoding="utf-8"))
    assert data["schema_version"] == "1.2.0" and data["bad_channels"] == [names[1]]
    assert document_from_dict(data).bad_channels == (names[1],)
    tsv = paths["channels_tsv"].read_text(encoding="utf-8").splitlines()
    assert tsv[0].split("\t") == ["name", "type", "units", "status", "status_description"]
    rows = [r.split("\t") for r in tsv[1:]]
    assert [r[0] for r in rows] == list(names)
    assert [r[3] for r in rows].count("bad") == 1 and rows[1][3] == "bad"
    assert rows[1][4] == "Marked bad for the whole recording by annotator A01" and rows[0][4] == "n/a"
    meta = json.loads(paths["session_json"].read_text(encoding="utf-8"))
    assert meta["bad_channels"]["marked_by_annotator"] == [names[1]]
    entry = next(e for e in s.register.entries() if e["session_id"] == s.session_id)
    assert (entry["n_bad_channels"], entry["n_needs_review"]) == ("1", "1")


def test_no_channels_tsv_without_bad_channels(layout, settings, catalogue, loaded):
    s = make_session(layout, settings, catalogue, loaded)
    s.start()
    s.start_timer()
    s.store.add_interval("EMG-artifact", 2.0, 3.0)
    res = s.finish()
    assert "channels_tsv" not in res.commit.paths
    assert json.loads(res.commit.paths["annotations_json"].read_text(encoding="utf-8"))["bad_channels"] == []


def test_the_check_refuses_a_channels_tsv_that_does_not_match(layout, settings, catalogue, loaded):
    s = make_session(layout, settings, catalogue, loaded)
    s.store.set_channel_bad(loaded.info.ch_names[0])
    doc = s.build_document()
    good = channels_tsv_bytes(doc, {})
    validate_channels_tsv(good, doc)
    assert bad_channels_from_channels_tsv(good) == (loaded.info.ch_names[0],)
    other = dataclasses.replace(doc, bad_channels=(loaded.info.ch_names[1],))
    with pytest.raises(ValidationError, match="bad channels"):
        validate_channels_tsv(good, other)
    with pytest.raises(ValidationError):
        validate_channels_tsv(good.replace(b"\tbad\t", b"\tbroken\t"), doc)


def test_files_without_bad_channels_are_still_read(loaded, catalogue, layout, settings):
    s = make_session(layout, settings, catalogue, loaded)
    data = document_to_dict(s.build_document())
    data["schema_version"] = "1.1.0"
    del data["bad_channels"]
    assert document_from_dict(data).bad_channels == ()
    data["bad_channels"] = ["Nope"]
    with pytest.raises(AnnotationError):
        document_from_dict(data)


def test_the_analysis_reports_bad_channels_and_uncertain_marks_apart():
    from tests.test_reliability import analyse, doc, row

    a = doc("A", [("EMG-artifact", 1, 2, ()), (UNCERTAIN_LABEL, 4, 5, ())])
    b = doc("B", [("EMG-artifact", 1, 2, ())])
    c = doc("C", [])
    a = dataclasses.replace(a, bad_channels=("C1", "C3"))
    b = dataclasses.replace(b, bad_channels=("C1",))
    res = analyse([a, b, c])
    by = res.tables["bad_channels_by_channel"]
    assert list(by.channel) == ["C1", "C3"]
    assert row(by, channel="C1").n_marked_bad == 2 and row(by, channel="C1").marked_by == "A, B"
    assert row(by, channel="C3").proportion_marked_bad == pytest.approx(1 / 3)
    pw = res.tables["bad_channels_pairwise"]
    ab = row(pw, rater_1="A", rater_2="B")
    assert (ab.both, ab.only_1, ab.only_2, ab.neither) == (1, 1, 0, 2)
    # kappa over the four channels: po = 3/4, pe = 1/2 * 1/4 + 1/2 * 3/4 = 1/2
    assert ab.cohen_kappa == pytest.approx(0.5)
    un = res.tables["uncertain_by_annotator"]
    assert row(un, annotator="A").n_uncertain == 1 and row(un, annotator="A").share_uncertain == pytest.approx(0.5)
    assert row(un, annotator="B").n_uncertain == 0
    # the artifact tables are unchanged by the bad channels
    plain = analyse([dataclasses.replace(a, bad_channels=()), dataclasses.replace(b, bad_channels=()), c])
    key = ["recording", "category", "channel_mode", "representation", "unit", "rater_1", "rater_2"]
    cols = key + ["cohen_kappa"]
    left = res.tables["timeresolved_pairwise"][cols].sort_values(key).reset_index(drop=True)
    right = plain.tables["timeresolved_pairwise"][cols].sort_values(key).reset_index(drop=True)
    assert left.equals(right)
