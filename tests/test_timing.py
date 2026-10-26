"""Time/sample conversion and MNE time-origin conventions (spec 7.1, test 8)."""

from __future__ import annotations

import datetime as dt

import mne
import numpy as np
import pytest

from electroclean.app.annotations.labels import default_catalogue
from electroclean.app.annotations.mne_bridge import from_mne_annotations, to_mne_annotations
from electroclean.app.annotations.model import ArtifactAnnotation, RecordingInfo
from electroclean.app.annotations.timing import RecordingTiming, TimingError
from electroclean.app.eeg.events import format_seconds


@pytest.mark.parametrize("sfreq", [100.0, 250.0, 256.0, 500.0, 512.0, 1000.0, 1024.0, 2048.0, 5000.0, 999.9, 333.3333])
def test_sample_time_round_trip(sfreq):
    timing = RecordingTiming(sfreq=sfreq, n_samples=10**9)
    rng = np.random.default_rng(0)
    samples = np.concatenate([np.arange(0, 2000), rng.integers(0, 10**9, 5000)])
    for s in samples.tolist():
        t = timing.sample_to_time(s)
        assert timing.time_to_sample(t) == s
        # The text written to the TSV must also round-trip exactly.
        assert timing.time_to_sample(float(format_seconds(t))) == s


def test_snap_interval_orders_clips_and_widens():
    timing = RecordingTiming(sfreq=250.0, n_samples=2500)
    assert timing.snap_interval(2.0, 1.0) == (250, 250)
    assert timing.snap_interval(-1.0, 0.5) == (0, 125)
    assert timing.snap_interval(9.9, 11.0) == (2475, 25)
    start, dur = timing.snap_interval(3.0, 3.0, min_samples=1)
    assert dur == 1 and start == 750
    start, dur = timing.snap_interval(10.0, 10.0)
    assert (start, dur) == (2499, 1)


def test_validate_range():
    timing = RecordingTiming(sfreq=100.0, n_samples=1000)
    timing.validate_range(0, 1000)
    with pytest.raises(TimingError):
        timing.validate_range(-1, 10)
    with pytest.raises(TimingError):
        timing.validate_range(990, 11)
    with pytest.raises(TimingError):
        timing.validate_range(10, 0)


@pytest.mark.parametrize("meas_date", [None, dt.datetime(2020, 1, 1, tzinfo=dt.timezone.utc)])
@pytest.mark.parametrize("first_samp", [0, 37])
def test_mne_round_trip_respects_first_samp(meas_date, first_samp):
    sfreq = 200.0
    info = mne.create_info(["a", "b", "c"], sfreq, "eeg")
    raw = mne.io.RawArray(np.zeros((3, 4000)), info, first_samp=first_samp, verbose="error")
    raw.set_meas_date(meas_date)
    timing = RecordingTiming.from_raw(raw)
    rec = RecordingInfo("r", timing, tuple(raw.ch_names))
    cat = default_catalogue()
    anns = [
        ArtifactAnnotation("id1", "EMG-artifact", 400, 50, ("a",)),
        ArtifactAnnotation("id2", "Eye-blink-artifact", 1000, 1, ()),
    ]
    raw.set_annotations(to_mne_annotations(anns, rec, cat, for_raw=raw))
    # MNE's own event extraction gives absolute samples (including first_samp).
    events, ids = mne.events_from_annotations(raw, verbose="error")
    assert sorted(events[:, 0] - raw.first_samp) == [400, 1000]
    # And raw.times-relative onsets match ours.
    np.testing.assert_allclose(raw.annotations.onset - raw.first_time, [2.0, 5.0])
    back = from_mne_annotations(raw.annotations, rec, cat)
    assert sorted((a.annotation_id, a.onset_sample, a.duration_samples, a.channels) for a in back) == sorted(
        (a.annotation_id, a.onset_sample, a.duration_samples, a.channels) for a in anns
    )
