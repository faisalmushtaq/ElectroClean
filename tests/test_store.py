"""Creating and editing annotations (tests 5, 6, 7, 13, 20)."""

from __future__ import annotations

import pytest

from electroclean.app.annotations.labels import default_catalogue
from electroclean.app.annotations.model import AnnotationError, RecordingInfo
from electroclean.app.annotations.store import AnnotationStore
from electroclean.app.annotations.timing import RecordingTiming

CH = ("Fp1", "Fp2", "C3", "C4", "O1", "O2")


@pytest.fixture
def store():
    rec = RecordingInfo("rec.vhdr", RecordingTiming(sfreq=250.0, n_samples=25000), CH)
    return AnnotationStore(rec, default_catalogue())


def test_create_edit_resize_delete(store):
    a = store.add_interval("Eye-blink-artifact", 1.0, 1.4)
    assert (a.onset_sample, a.duration_samples) == (250, 100)
    b = store.set_interval(a.annotation_id, 0.9, 1.6)
    assert b.annotation_id == a.annotation_id
    assert (b.onset_sample, b.duration_samples) == (225, 175)
    c = store.set_label(a.annotation_id, "Vertical-eye-movement-artifact")
    assert c.label == "Vertical-eye-movement-artifact"
    store.delete(a.annotation_id)
    assert len(store) == 0


def test_undo_redo(store):
    a = store.add_interval("EMG-artifact", 2.0, 3.0)
    store.set_interval(a.annotation_id, 2.0, 4.0)
    store.delete(a.annotation_id)
    assert len(store) == 0
    assert store.undo() == "delete annotation"
    assert store.get(a.annotation_id).duration_samples == 500
    store.undo()
    assert store.get(a.annotation_id).duration_samples == 250
    store.redo()
    assert store.get(a.annotation_id).duration_samples == 500
    # A new edit clears the redo history.
    store.undo()
    store.set_label(a.annotation_id, "Chewing-artifact")
    assert not store.can_redo


def test_channel_scopes(store):
    whole = store.add_interval("Movement-artifact", 1, 2)
    one = store.add_interval("Electrode-pops-artifact", 3, 3.2, ["C3"])
    many = store.add_interval("EMG-artifact", 4, 5, ["O2", "Fp1"])
    allx = store.add_interval("EMG-artifact", 6, 7, list(CH))
    assert whole.channels == () and whole.is_global
    assert one.channels == ("C3",)
    assert many.channels == ("Fp1", "O2")  # stored in recording order
    assert allx.channels == CH and not allx.is_global  # explicit full selection is kept
    with pytest.raises(AnnotationError):
        store.add_interval("EMG-artifact", 1, 2, ["Cz"])
    t = store.toggle_channel(one.annotation_id, "C4")
    assert t.channels == ("C3", "C4")
    t = store.set_channels(one.annotation_id, [])
    assert t.is_global


def test_overlapping_different_categories_are_independent(store):
    blink = store.add_interval("Eye-blink-artifact", 10.0, 10.5, ["Fp1", "Fp2"])
    emg = store.add_interval("EMG-artifact", 10.2, 11.0)
    assert {a.annotation_id for a in store.overlapping(blink.annotation_id)} == {emg.annotation_id}
    store.set_interval(emg.annotation_id, 10.0, 12.0)
    assert store.get(blink.annotation_id).duration_samples == 125
    assert len(store) == 2


def test_repeated_same_label_not_merged_unless_requested(store):
    a = store.add_interval("EMG-artifact", 1.0, 2.0)
    b = store.add_interval("EMG-artifact", 1.5, 3.0)  # overlaps a
    c = store.add_interval("EMG-artifact", 1.0, 2.0)  # identical interval
    assert len(store) == 3
    assert store.get(a.annotation_id).end_sample == 500
    merged = store.merge([a.annotation_id, b.annotation_id])
    assert (merged.onset_sample, merged.end_sample) == (250, 750)
    assert len(store) == 2 and c.annotation_id in store
    with pytest.raises(AnnotationError):
        d = store.add_interval("Chewing-artifact", 5, 6)
        store.merge([merged.annotation_id, d.annotation_id])
    store.undo()  # undo the add of d (merge raised before committing)
    store.undo()  # undo the merge
    assert {a.annotation_id, b.annotation_id, c.annotation_id} <= {x.annotation_id for x in store}


def test_invalid_labels_and_ranges_rejected(store):
    with pytest.raises(AnnotationError):
        store.add("BAD_custom", 0, 10)
    with pytest.raises(AnnotationError):
        store.add("EMG-artifact", 24990, 20)
    with pytest.raises(AnnotationError):
        store.add("EMG-artifact", -5, 20)
    with pytest.raises(AnnotationError):
        store.add("EMG-artifact", 0, 0)
    assert len(store) == 0 and not store.can_undo


def test_listeners_notified(store):
    seen = []
    store.add_listener(lambda ch: seen.append(ch.action))
    a = store.add_interval("ECG-artifact", 1, 2)
    store.delete(a.annotation_id)
    store.undo()
    assert seen == ["add", "delete", "undo"]
