"""Loading, filtering and error handling (tests 3, 4, 14)."""

from __future__ import annotations

import hashlib
import json

import mne
import numpy as np
import pytest

from electrotag.app.eeg.loading import RecordingLoadError, load_recording
from electrotag.app.io.discovery import discover_recordings
from electrotag.config.settings import FilterSettings, load_settings
from tests.conftest import SUB1


def _hash_tree(root):
    out = {}
    for p in sorted(root.rglob("*")):
        if p.is_file() and "Annotated_Events" not in p.parts:
            out[p.relative_to(root).as_posix()] = hashlib.sha256(p.read_bytes()).hexdigest()
    return out


def test_load_recording_basic(loaded):
    assert loaded.info.recording_id == SUB1
    assert loaded.timing.sfreq == 250.0
    assert loaded.timing.n_samples == 15000
    assert len(loaded.info.ch_names) == 22
    assert loaded.original_events.source == "events_tsv"
    assert len(loaded.original_events) == 30
    assert loaded.channel_report.consistent
    assert loaded.view_raw.get_channel_types(["HEOG", "ECG"]) == ["eog", "ecg"]
    assert set(loaded.fingerprint) >= {"vhdr", "eeg", "vmrk", "events_tsv", "channels_tsv"}
    assert all("sha256" in v for v in loaded.fingerprint.values())


def test_filtering_does_not_alter_source(dataset, recordings, settings, catalogue):
    root, _ = dataset
    before = _hash_tree(root)
    rec = recordings[SUB1]
    lr = load_recording(rec, settings, settings.filters, catalogue)
    try:
        filtered = lr.view_raw.get_data()
        source = mne.io.read_raw_brainvision(rec.vhdr, preload=True, verbose="error").get_data()
        # The display copy differs (filters applied) ...
        assert not np.allclose(filtered, source)
        # ... and matches applying the same MNE filters to a fresh copy.
        ref = mne.io.read_raw_brainvision(rec.vhdr, preload=True, verbose="error")
        ref.filter(1.0, None, verbose="error", picks="all")
        ref.notch_filter([50.0], verbose="error", picks="all")
        np.testing.assert_allclose(filtered, ref.get_data(), atol=1e-12)
        # Line noise is reduced in the display copy.
        f = np.fft.rfftfreq(source.shape[1], 1 / 250.0)
        k = np.argmin(abs(f - 50))
        assert abs(np.fft.rfft(filtered[0]))[k] < 0.1 * abs(np.fft.rfft(source[0]))[k]
    finally:
        lr.close()
    assert _hash_tree(root) == before
    report = lr.filter_report.to_dict()
    assert [s["name"] for s in report["steps"]] == ["high-pass", "notch"]
    assert report["steps"][0]["filter_length_samples"] == 825
    assert "firwin" in report["steps"][0]["mne_log"]
    assert report["edge_transient_half_width_s"] > 1.0


def test_no_filters_keeps_lazy_loading(recordings, settings, catalogue):
    filters = FilterSettings(highpass_enabled=False, notch_enabled=False)
    lr = load_recording(recordings[SUB1], settings, filters, catalogue)
    assert not lr.view_raw.preload
    assert lr.filter_report.steps == []
    lr.close()


def test_memory_mapped_display_copy_for_large_recordings(dataset, recordings, catalogue):
    root, _ = dataset
    settings, _ = load_settings(root, {"loading": {"preload_memory_limit_mb": 0.001}})
    lr = load_recording(recordings[SUB1], settings, settings.filters, catalogue)
    assert lr.cache_path is not None and lr.cache_path.exists()
    assert "memory-mapped" in lr.filter_report.data_storage
    cache = lr.cache_path
    lr.close()
    assert not cache.exists()


def test_iir_filters_recorded(recordings, settings, catalogue):
    filters = FilterSettings(method="iir", notch_hz=60.0)
    lr = load_recording(recordings[SUB1], settings, filters, catalogue)
    steps = lr.filter_report.to_dict()["steps"]
    assert steps[0]["parameters"]["iir_params"]["order"] == 4
    assert steps[1]["parameters"]["freqs"] == [60.0]
    assert lr.filter_report.transient_half_width_s > 0
    # eeg.json says 50 Hz mains (UK), so a 60 Hz notch is flagged.
    assert any("power-line frequency" in w for w in lr.warnings)
    lr.close()


def test_discontinuity_segments_filtered_separately(rich_dataset, catalogue):
    root, _ = rich_dataset
    settings, _ = load_settings(root)
    rec = {r.recording_id: r for r in discover_recordings(root)}["sub-090/eeg/sub-090_task-rest_eeg.vhdr"]
    lr = load_recording(rec, settings, settings.filters, catalogue)
    assert lr.discontinuity_samples == [5000]
    assert lr.filter_report.discontinuity_samples == [5000]
    zones = lr.filter_report.transient_zones(lr.timing.n_samples)
    assert any(a < 20.0 < b for a, b in zones)
    lr.close()


def test_missing_companion_files_fail(dataset, catalogue, settings):
    root, _ = dataset
    (root / "sub-001" / "eeg" / "sub-001_task-rest_eeg.vmrk").unlink()
    rec = {r.recording_id: r for r in discover_recordings(root)}[SUB1]
    with pytest.raises(RecordingLoadError) as err:
        load_recording(rec, settings, settings.filters, catalogue)
    assert err.value.kind == "missing_companion"


def test_truncated_data_file_fails(dataset, catalogue, settings):
    root, _ = dataset
    eeg = root / "sub-001" / "eeg" / "sub-001_task-rest_eeg.eeg"
    eeg.write_bytes(eeg.read_bytes()[:10001])
    rec = {r.recording_id: r for r in discover_recordings(root)}[SUB1]
    with pytest.raises(RecordingLoadError) as err:
        load_recording(rec, settings, settings.filters, catalogue)
    assert err.value.kind in ("corrupt_recording", "inconsistent_recording")


def test_truncated_on_sample_boundary_detected_by_markers(dataset, catalogue, settings):
    root, _ = dataset
    eeg = root / "sub-001" / "eeg" / "sub-001_task-rest_eeg.eeg"
    frame = 22 * 4
    eeg.write_bytes(eeg.read_bytes()[: frame * 2000])  # 8 s of 60 s, whole samples
    rec = {r.recording_id: r for r in discover_recordings(root)}[SUB1]
    with pytest.raises(RecordingLoadError) as err:
        load_recording(rec, settings, settings.filters, catalogue)
    assert err.value.kind == "inconsistent_recording"


def test_corrupted_header_fails(dataset, catalogue, settings):
    root, _ = dataset
    vhdr = root / "sub-001" / "eeg" / "sub-001_task-rest_eeg.vhdr"
    vhdr.write_text(vhdr.read_text(encoding="utf-8").replace("SamplingInterval=4000", "SamplingInterval=abc"),
                    encoding="utf-8")
    rec = {r.recording_id: r for r in discover_recordings(root)}[SUB1]
    with pytest.raises(RecordingLoadError):
        load_recording(rec, settings, settings.filters, catalogue)


def test_malformed_events_tsv_fails(dataset, catalogue, settings):
    root, _ = dataset
    ev = root / "sub-001" / "eeg" / "sub-001_task-rest_events.tsv"
    ev.write_text(ev.read_text(encoding="utf-8") + "1.0\t0.1\n", encoding="utf-8")
    rec = {r.recording_id: r for r in discover_recordings(root)}[SUB1]
    with pytest.raises(RecordingLoadError) as err:
        load_recording(rec, settings, settings.filters, catalogue)
    assert err.value.kind == "malformed_bids_metadata"


def test_inconsistent_channels_and_bad_json_are_warnings(dataset, catalogue, settings):
    root, _ = dataset
    d = root / "sub-001" / "eeg"
    ch = d / "sub-001_task-rest_channels.tsv"
    # Explicit encodings: channels.tsv is UTF-8 ("µV"), and Windows' default encoding is not.
    text = ch.read_text(encoding="utf-8")
    ch.write_text(text.replace("Fp1\tEEG", "FP1\tEEG").replace("O2\tEEG\tµV\tgood", "O2\tEEG\tµV\tbad"),
                  encoding="utf-8")
    (d / "sub-001_task-rest_eeg.json").write_text("{ not json", encoding="utf-8")
    rec = {r.recording_id: r for r in discover_recordings(root)}[SUB1]
    lr = load_recording(rec, settings, settings.filters, catalogue)
    assert lr.channel_report.missing_from_tsv == ["Fp1"]
    assert lr.channel_report.missing_from_recording == ["FP1"]
    assert lr.view_raw.info["bads"] == ["O2"]
    assert any("Could not read JSON sidecar" in w for w in lr.warnings)
    lr.close()


# Python 3.13's words for these, which the browser reproduces (js/eeg/pyjson.js); Python 3.12 has
# others for a trailing comma, so the same sidecar must give the same manifest on both.
SIDECAR_JSON_ERRORS = [
    ('{"a": 1,}', "Illegal trailing comma before end of object: line 1 column 8 (char 7)"),
    ("[1,]", "Illegal trailing comma before end of array: line 1 column 3 (char 2)"),
    ('{"a": 1 , \n }', "Illegal trailing comma before end of object: line 1 column 9 (char 8)"),
    ("[1 ,\n ]", "Illegal trailing comma before end of array: line 1 column 4 (char 3)"),
    ('{"a":[1,],}', "Illegal trailing comma before end of array: line 1 column 8 (char 7)"),
    ("[1,x]", "Expecting value: line 1 column 4 (char 3)"),
    ('{"a":]', "Expecting value: line 1 column 6 (char 5)"),
    ('{"a": 1, x}', "Expecting property name enclosed in double quotes: line 1 column 10 (char 9)"),
    ("[,]", "Expecting value: line 1 column 2 (char 1)"),
    ("{,}", "Expecting property name enclosed in double quotes: line 1 column 2 (char 1)"),
    ("[1,,]", "Expecting value: line 1 column 4 (char 3)"),
    ("{ not json", "Expecting property name enclosed in double quotes: line 1 column 3 (char 2)"),
]


@pytest.mark.parametrize(("text", "message"), SIDECAR_JSON_ERRORS)
def test_sidecar_json_errors_have_the_same_words_on_every_python(text, message):
    from electrotag.app.io.bids import loads_json

    with pytest.raises(json.JSONDecodeError) as caught:
        loads_json(text)
    assert str(caught.value) == message
    assert loads_json('{"a": [1, 2], "b": NaN}', parse_constant=lambda _c: None) == {"a": [1, 2], "b": None}


def test_a_trailing_comma_in_a_sidecar_is_reported_in_python_3_13s_words(tmp_path):
    from electrotag.app.io.bids import load_json_chain

    p = tmp_path / "sub-01_eeg.json"
    p.write_text('{"SamplingFrequency": 250,}', encoding="utf-8")
    assert load_json_chain([p]) == ({}, [
        "Could not read JSON sidecar sub-01_eeg.json: "
        "Illegal trailing comma before end of object: line 1 column 26 (char 25)"])


def test_original_codes_like_artifact_codes_load_without_a_policy(rich_dataset, catalogue):
    """sub-099's own events use code 101; artifact codes have their own column, so it simply loads."""
    root, _ = rich_dataset
    rec = {r.recording_id: r for r in discover_recordings(root)}["sub-099/eeg/sub-099_task-oddball_eeg.vhdr"]
    settings, _ = load_settings(root)
    lr = load_recording(rec, settings, settings.filters, catalogue)
    assert lr.event_report.codes_also_used_for_artifacts == [101]
    lr.close()
    # An old study file that still sets the retired policy is accepted.
    (root / "electrotag_study.json").write_text(
        json.dumps({"settings": {"events": {"collision_policy": "preserve_and_flag"}}}), encoding="utf-8"
    )
    settings, _ = load_settings(root)
    load_recording(rec, settings, settings.filters, catalogue).close()


def test_eog_and_ecg_channels_are_filtered_like_eeg(loaded):
    """EOG and ECG are part of the montage: the viewing filters apply to them as well."""
    assert {"HEOG", "VEOG", "ECG"} <= set(loaded.filter_report.filtered_channels)
