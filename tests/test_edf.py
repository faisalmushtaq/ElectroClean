"""EDF, EDF+ and BDF recordings, and channels hidden by the study settings.

The files are written by ``electroclean.synthetic.write_edf``, which follows
the EDF and EDF+ specifications, and imitate an export from a consumer EEG
headset: housekeeping channels (sample counter, contact quality, battery)
next to the EEG, a channels.tsv that types every channel as EEG, an events.tsv
whose ``sample`` column holds stimulus-software timestamps, and padding of the
last data record marked BAD_ACQ_SKIP.
"""

from __future__ import annotations

import json
import time
import warnings
from pathlib import Path

import mne
import numpy as np
import pytest

from electroclean.app.eeg.loading import RecordingLoadError, load_recording
from electroclean.app.io.discovery import discover_recordings
from electroclean.app.io.edf import read_edf_header
from electroclean.app.io.naming import OutputLayout
from electroclean.config.settings import SettingsError, load_settings
from electroclean.reliability.analysis import run_analysis
from electroclean.reliability.config import AnalysisConfig
from electroclean.synthetic import ALL_CHANNELS, write_edf, write_edf_recording
from tests.conftest import make_session

REC = "sub-01/eeg/sub-01_task-rest_eeg.edf"
HOUSEKEEPING = ("COUNTER", "INTERPOLATED", "CQ_Fp1", "CQ_Fp2", "BATTERY")


@pytest.fixture
def edf_root(tmp_path: Path) -> Path:
    root = tmp_path / "edfdata"
    write_edf_recording(root / "sub-01" / "eeg", "sub-01_task-rest", seed=3)
    return root


def _load(root: Path, rid: str = REC, overrides=None, **kw):
    settings, _ = load_settings(root, overrides)
    recs = {r.recording_id: r for r in discover_recordings(root, suffixes=settings.discovery_suffixes)}
    from electroclean.app.annotations.labels import default_catalogue

    return load_recording(recs[rid], settings, settings.filters, default_catalogue(), **kw), settings


def test_discovery_finds_every_supported_format(tmp_path, edf_root):
    write_edf_recording(edf_root / "sub-02" / "eeg", "sub-02_task-rest", bdf=True)
    upper = edf_root / "sub-03" / "eeg"
    write_edf_recording(upper, "sub-03_task-rest")
    (upper / "sub-03_task-rest_eeg.edf").rename(upper / "sub-03_task-rest_eeg.EDF")
    (edf_root / "sub-04").mkdir()
    (edf_root / "sub-04" / "notes_eeg.txt").write_text("not a recording")
    recs = {r.recording_id: r for r in discover_recordings(edf_root)}
    assert sorted(recs) == [REC, "sub-02/eeg/sub-02_task-rest_eeg.bdf", "sub-03/eeg/sub-03_task-rest_eeg.EDF"]
    edf = recs[REC]
    assert (edf.format, edf.format_name, edf.vhdr, edf.vmrk, edf.eeg) == ("edf", "EDF", None, None, edf.path)
    assert edf.stem == "sub-01_task-rest_eeg"
    assert list(edf.source_files()) == ["eeg", "channels_tsv", "events_tsv", "events_json", "eeg_json"]
    assert recs["sub-02/eeg/sub-02_task-rest_eeg.bdf"].format == "bdf"
    # A study can restrict discovery to one format.
    only_bdf = discover_recordings(edf_root, suffixes=["_eeg.bdf"])
    assert [r.format for r in only_bdf] == ["bdf"]


def test_header_is_read_and_sizes_checked(edf_root):
    path = edf_root / REC
    h = read_edf_header(path)
    assert h.file_type == "EDF+C" and h.n_records == 41 and h.record_duration_s == 1.0
    assert h.signal_labels == tuple(ALL_CHANNELS) + HOUSEKEEPING
    assert h.size_problems(path.stat().st_size) == ([], [])
    fatal, _ = h.size_problems(path.stat().st_size - 10)
    assert "truncated" in fatal[0]
    fatal, _ = h.size_problems(path.stat().st_size + h.record_bytes)
    assert "longer than" in fatal[0]


def test_edf_loads_with_hidden_channels_and_timestamp_sample_column(edf_root):
    lr, _ = _load(edf_root)
    try:
        assert lr.info.ch_names == tuple(ALL_CHANNELS)
        assert lr.info.hidden_channels == HOUSEKEEPING
        assert lr.view_raw.ch_names == list(ALL_CHANNELS)
        assert any("channels.hide" in n for n in lr.notes)
        ev = lr.original_events
        assert ev.source == "events_tsv" and len(ev) == 10
        assert ev.sample_column_ignored and not any(p.startswith("Row") for p in ev.problems)
        assert ev.sample[:2] == [256, 768]  # from the onsets (2 s and 6 s at 128 Hz)
        assert ev.comparison["compared"] and ev.comparison["consistent"]  # the EDF+ annotations agree
        assert lr.acquisition_gaps == [(5184, 5248)]  # padding of the last 1-s record
        assert any("BAD_ACQ_SKIP" in w for w in lr.warnings)
        assert lr.filter_report.acquisition_gaps == [(5184, 5248)]
        assert 5184 in lr.filter_report.discontinuity_samples
        # The padding is left unfiltered (it stays constant), the data before it are filtered.
        data = lr.view_raw.get_data()
        assert np.all(np.ptp(data[:, 5184:], axis=1) == 0)
        assert abs(data[:, :5184].mean(axis=1)).max() < 5e-6
    finally:
        lr.close()


def test_edf_filtering_emits_no_warnings(edf_root):
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        lr, _ = _load(edf_root)
        lr.close()


def test_unfiltered_display_matches_the_file(edf_root):
    lr, _ = _load(edf_root, overrides={"filters": {"highpass_enabled": False, "notch_enabled": False}})
    try:
        ref = mne.io.read_raw_edf(edf_root / REC, preload=True, verbose="error").pick(list(ALL_CHANNELS))
        np.testing.assert_array_equal(lr.view_raw.get_data(), ref.get_data())
    finally:
        lr.close()


def test_events_come_from_edf_annotations_without_events_tsv(tmp_path):
    root = tmp_path / "d"
    folder = root / "sub-01" / "eeg"
    write_edf_recording(folder, "sub-01_task-rest", seed=4)
    (folder / "sub-01_task-rest_events.tsv").unlink()
    lr, _ = _load(root)
    try:
        ev = lr.original_events
        assert ev.source == "edf_annotations" and ev.path == root / REC
        assert ev.trial_types[:2] == ["stim/1", "stim/2"] and ev.trial_types[-1] == "BAD_ACQ_SKIP"
        assert ev.sample[:2] == [256, 768]
        # Kept as an original event (it is in the file) but drawn as a hatched gap, not as an event line.
        events, codes = ev.display_events(lr.timing)
        assert len(events) == 10 and "BAD_ACQ_SKIP" not in codes
    finally:
        lr.close()


def test_plain_edf_without_annotations_relies_on_events_tsv(tmp_path):
    root = tmp_path / "d"
    write_edf_recording(root / "sub-01" / "eeg", "sub-01_task-rest", events_in_file=False)
    assert read_edf_header(root / REC).file_type == "EDF"
    lr, _ = _load(root)
    try:
        assert lr.original_events.comparison["compared"] is False
        assert not any("disagree" in w for w in lr.warnings)
        assert lr.acquisition_gaps == []  # a plain EDF cannot mark its padding
    finally:
        lr.close()


def test_bdf_loads(tmp_path):
    root = tmp_path / "d"
    write_edf_recording(root / "sub-01" / "eeg", "sub-01_task-rest", bdf=True)
    lr, _ = _load(root, "sub-01/eeg/sub-01_task-rest_eeg.bdf")
    try:
        assert lr.files.format == "bdf" and lr.info.ch_names == tuple(ALL_CHANNELS)
        assert read_edf_header(lr.files.path).file_type == "BDF+C"
    finally:
        lr.close()


@pytest.mark.parametrize(
    "damage, kind, words",
    [
        ("truncate", "corrupt_recording", "truncated"),
        ("extra", "corrupt_recording", "longer than"),
        ("header_only", "corrupt_recording", "no data"),
        ("garbage", "corrupt_recording", "not a readable EDF file"),
        ("discontinuous", "unsupported_format", "EDF+D"),
    ],
)
def test_broken_edf_files_are_refused(edf_root, damage, kind, words):
    path = edf_root / REC
    raw = path.read_bytes()
    h = read_edf_header(path)
    if damage == "truncate":
        path.write_bytes(raw[: len(raw) - h.record_bytes - 7])
    elif damage == "extra":
        path.write_bytes(raw + raw[-h.record_bytes:])
    elif damage == "header_only":
        path.write_bytes(raw[: h.header_bytes])
    elif damage == "garbage":
        path.write_bytes(b"this is not an EDF file" * 40)
    else:
        path.write_bytes(raw[:192] + b"EDF+D".ljust(44) + raw[236:])
    with pytest.raises(RecordingLoadError) as info:
        _load(edf_root)
    assert info.value.kind == kind and words in str(info.value)


def test_unknown_record_count_is_accepted_with_a_warning(tmp_path):
    root = tmp_path / "d"
    folder = root / "sub-01" / "eeg"
    rng = np.random.default_rng(0)
    write_edf(folder / "sub-01_task-rest_eeg.edf", rng.normal(0, 1e-5, (3, 1280)), 128.0, ["Cz", "Pz", "Oz"],
              n_records_in_header=-1)
    lr, _ = _load(root)
    try:
        assert lr.timing.n_samples == 1280
        assert any("does not give the number of data records" in w for w in lr.warnings)
        assert not any("MNE: Number of records" in w for w in lr.warnings)
    finally:
        lr.close()


def test_hidden_channel_settings(edf_root):
    lr, _ = _load(edf_root, overrides={"channels": {"hide": []}})
    try:
        assert lr.info.ch_names == tuple(ALL_CHANNELS) + HOUSEKEEPING and lr.info.hidden_channels == ()
    finally:
        lr.close()
    with pytest.raises(RecordingLoadError) as info:
        _load(edf_root, overrides={"channels": {"hide": ["*"]}})
    assert info.value.kind == "no_channels"
    with pytest.raises(SettingsError):
        load_settings(edf_root, {"channels": {"hide": [""]}})


def test_discovery_settings(edf_root):
    s, _ = load_settings(edf_root)
    assert s.discovery_suffixes == ("_eeg.vhdr", "_eeg.edf", "_eeg.bdf")
    old, _ = load_settings(edf_root, {"discovery": {"suffix": "_eeg.edf"}})  # study files from version 1
    assert old.discovery_suffixes == ("_eeg.edf",)
    with pytest.raises(SettingsError):
        load_settings(edf_root, {"discovery": {"suffixes": ["_eeg.set"]}})


def test_session_saves_and_validates_edf_outputs(edf_root):
    lr, settings = _load(edf_root)
    from electroclean.app.annotations.labels import default_catalogue

    layout = OutputLayout(edf_root / "Annotated_Events")
    session = make_session(layout, settings, default_catalogue(), lr)
    session.start()
    session.start_timer()
    session.store.add_interval("Eye-blink-artifact", 3.0, 3.4, channels=["Fp1", "Fp2"])
    session.store.add_interval("Movement-artifact", 10.0, 12.0)
    time.sleep(0.01)
    res = session.finish()
    lr.close()
    paths = res.commit.paths
    assert paths["events_tsv"].name == "sub-01_task-rest_eeg_annotator-A01_events.tsv"
    lines = paths["events_tsv"].read_text(encoding="utf-8").splitlines()
    header = lines[0].split("\t")
    assert header[:5] == ["onset", "duration", "trial_type", "trigger_code", "sample"]
    original = (edf_root / "sub-01" / "eeg" / "sub-01_task-rest_events.tsv").read_text().splitlines()[1:]
    assert [ln.split("\t")[:5] for ln in lines[1:] if "original:events_tsv" in ln] == [o.split("\t") for o in original]
    blink = next(ln.split("\t") for ln in lines if "Eye-blink-artifact" in ln)
    assert blink[header.index("sample")] == "384" and blink[header.index("artifact_code")] == "103"
    sidecar = json.loads(paths["events_json"].read_text())
    assert sidecar["sample"]["Description"].startswith("Stimulus software timestamp. On rows with event_source")
    canonical = json.loads(paths["annotations_json"].read_text())
    assert canonical["recording"]["ch_names"] == list(ALL_CHANNELS)
    assert canonical["recording"]["hidden_channels"] == list(HOUSEKEEPING)
    meta = json.loads(paths["session_json"].read_text())
    assert meta["recording"]["format"] == "EDF" and meta["recording"]["file"] == "sub-01_task-rest_eeg.edf"
    assert meta["recording"]["vhdr"] is None and meta["recording"]["acquisition_gaps_samples"] == [[5184, 5248]]
    # Whole-montage annotations cover the shown channels only in channel-level agreement.
    res2 = run_analysis([paths["annotations_json"]], AnalysisConfig())
    assert res2.dataset.groups[REC].ch_names == tuple(ALL_CHANNELS)
