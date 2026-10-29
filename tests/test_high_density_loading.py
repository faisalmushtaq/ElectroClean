"""Lessons from 128-channel recordings: trigger channels, channel types set by the study,
implausible amplitudes, and display filtering in blocks of channels (memory and progress).

Every recording here is synthetic (``electrotag.synthetic.write_edf``); the trigger channel
imitates BioSemi's Status channel, whose upper bits carry system flags.
"""

from __future__ import annotations

import json
import time
import tracemalloc
from pathlib import Path

import mne
import numpy as np
import pytest

from electrotag.app.annotations.labels import default_catalogue
from electrotag.app.eeg import filtering
from electrotag.app.eeg.amplitude import check_amplitudes, format_volts, nice_scale
from electrotag.app.eeg.events import SOURCE_STIM
from electrotag.app.eeg.filtering import apply_view_filters, channel_blocks
from electrotag.app.eeg.loading import load_recording
from electrotag.app.io.discovery import discover_recordings
from electrotag.app.io.naming import OutputLayout
from electrotag.config.settings import FilterSettings, SettingsError, load_default_settings_dict, load_settings
from electrotag.config.settings import Settings as SettingsCls
from electrotag.synthetic import write_edf
from tests.conftest import make_session

SF = 256.0
N = int(30 * SF)
EEG = ["Fp1", "Fp2", "Cz", "Pz", "O1", "O2"]
NAMES = EEG + ["EXG1", "EXG2"]
CMS_BIT = 1 << 20  # a BioSemi system flag (bit 20), set from sample 4000 onwards below


def status_codes() -> tuple[np.ndarray, list[tuple[int, int]]]:
    codes = np.zeros(N, dtype=np.int64)
    codes[1000:1010] = 5
    codes[2000:2005] = 12
    codes[2005:2010] = 13  # follows 12 without returning to zero
    codes[3000] = 7  # a single-sample pulse
    codes[4000:] |= CMS_BIT  # a system flag changes: not an event
    codes[5000:5010] |= 9
    return codes, [(1000, 5), (2000, 12), (2005, 13), (3000, 7), (5000, 9)]


def write_recording(root: Path, *, bdf: bool = True, scale: float = 1.0, names: list[str] | None = None,
                    triggers: dict[str, np.ndarray] | None = None, annotations=None, seed: int = 1) -> str:
    names = names or NAMES
    rng = np.random.default_rng(seed)
    data = rng.normal(0, 1e-5, (len(names), N)) * scale
    ext = "bdf" if bdf else "edf"
    write_edf(root / "sub-01" / "eeg" / f"sub-01_task-x_eeg.{ext}", data, SF, names, bdf=bdf,
              triggers=triggers, annotations=annotations)
    return f"sub-01/eeg/sub-01_task-x_eeg.{ext}"


def load(root: Path, rid: str, overrides=None, **kw):
    settings, _ = load_settings(root, overrides)
    recs = {r.recording_id: r for r in discover_recordings(root, suffixes=settings.discovery_suffixes)}
    return load_recording(recs[rid], settings, settings.filters, default_catalogue(), **kw), settings


# ------------------------------------------------------------------ trigger channels
def test_status_triggers_become_the_original_events(tmp_path):
    codes, expected = status_codes()
    rid = write_recording(tmp_path, triggers={"Status": codes})
    lr, _ = load(tmp_path, rid)
    try:
        ev = lr.original_events
        assert ev.source == SOURCE_STIM and ev.stim_channels == ["Status"]
        # Only the lower 16 bits count, every change to a non-zero code is an event, single samples included.
        assert [(s, int(v)) for s, v in zip(ev.sample, ev.values)] == expected
        assert ev.column("stim_channel") == ["Status"] * len(expected)
        assert ev.onset_s[0] == pytest.approx(1000 / SF)
        assert ev.describe_source() == "the Status channel"
        events, event_id = ev.display_events(lr.timing)
        assert len(events) == len(expected) and set(event_id) == {"value 5", "value 12", "value 13", "value 7", "value 9"}
    finally:
        lr.close()


def test_trigger_channel_is_not_part_of_the_montage(tmp_path):
    codes, _ = status_codes()
    rid = write_recording(tmp_path, triggers={"Status": codes})
    lr, _ = load(tmp_path, rid)
    try:
        assert lr.info.ch_names == tuple(NAMES)  # Status is neither shown nor annotated nor in the whole montage
        assert lr.info.hidden_channels == ("Status",) and lr.trigger_channels == ["Status"]
        assert "stim" not in lr.view_raw.get_channel_types()
        assert any(n.startswith("Trigger channel(s) not shown") and "Status" in n for n in lr.notes)
    finally:
        lr.close()


def test_file_annotations_and_events_tsv_come_before_triggers(tmp_path):
    codes, _ = status_codes()
    rid = write_recording(tmp_path, triggers={"Status": codes}, annotations=[(2.0, 0.0, "stim/1")])
    lr, _ = load(tmp_path, rid)
    try:
        assert lr.original_events.source == "bdf_annotations" and len(lr.original_events) == 1
        assert lr.trigger_channels == ["Status"] and "Status" not in lr.info.ch_names  # still hidden
    finally:
        lr.close()
    folder = tmp_path / "sub-01" / "eeg"
    (folder / "sub-01_task-x_events.tsv").write_text("onset\tduration\ttrial_type\n3.0\t0\tgo\n", encoding="utf-8")
    lr, _ = load(tmp_path, rid)
    try:
        assert lr.original_events.source == "events_tsv" and lr.original_events.trial_types == ["go"]
    finally:
        lr.close()


def test_edf_trigger_channel(tmp_path):
    codes = np.zeros(N, dtype=np.int64)
    codes[700:720] = 3
    codes[1500:1520] = 200
    rid = write_recording(tmp_path, bdf=False, triggers={"TRIGGER": codes})
    lr, _ = load(tmp_path, rid)
    try:
        assert [(s, v) for s, v in zip(lr.original_events.sample, lr.original_events.values)] == [(700, "3"), (1500, "200")]
        assert lr.original_events.describe_source() == "the TRIGGER channel"
        assert "TRIGGER" not in lr.info.ch_names
    finally:
        lr.close()


# ------------------------------------------------------------ channel types setting
def test_channel_types_setting_types_and_hides(tmp_path):
    codes = np.zeros(N, dtype=np.int64)
    codes[900:905] = 4
    rid = write_recording(tmp_path, bdf=False, names=EEG + ["EXG1", "EXG2"], triggers={"Mk1": codes})
    overrides = {"channels": {"types": {"EXG*": "misc", "Mk*": "stim"}}}
    lr, settings = load(tmp_path, rid, overrides)
    try:
        assert settings.channel_type_patterns == (("EXG*", "misc"), ("Mk*", "stim"))
        types = dict(zip(lr.view_raw.ch_names, lr.view_raw.get_channel_types()))
        assert types["EXG1"] == types["EXG2"] == "misc" and types["Cz"] == "eeg"
        assert "Mk1" not in lr.info.ch_names and lr.trigger_channels == ["Mk1"]  # made a trigger by the setting
        assert [(s, v) for s, v in zip(lr.original_events.sample, lr.original_events.values)] == [(900, "4")]
        assert any("channels.types setting for 2 channel(s)" in n for n in lr.notes)
        assert "EXG1" in lr.filter_report.filtered_channels  # misc channels are still filtered for display
    finally:
        lr.close()


def test_channels_tsv_trigger_type_hides_the_channel(tmp_path):
    codes = np.zeros(N, dtype=np.int64)
    codes[600:610] = 8
    rid = write_recording(tmp_path, bdf=False, triggers={"Marker": codes})
    folder = tmp_path / "sub-01" / "eeg"
    rows = ["name\ttype\tunits"] + [f"{c}\tEEG\tuV" for c in NAMES] + ["Marker\tTRIG\tn/a"]
    (folder / "sub-01_task-x_channels.tsv").write_text("\n".join(rows) + "\n", encoding="utf-8")
    lr, _ = load(tmp_path, rid)
    try:
        assert lr.trigger_channels == ["Marker"] and "Marker" not in lr.info.ch_names
        assert lr.original_events.values == ["8"]
    finally:
        lr.close()


@pytest.mark.parametrize("types, words", [
    ({"EXG*": "nonsense"}, "use one of"),
    ({" ": "misc"}, "empty patterns"),
    (["EXG*"], "must map channel-name patterns"),
])
def test_channel_types_setting_is_validated(types, words):
    data = load_default_settings_dict()
    data["channels"]["types"] = types
    with pytest.raises(SettingsError, match=words):
        SettingsCls.from_dict(data)


@pytest.mark.parametrize("mode", ["off", "region", "side", "type"])
def test_channel_colours_setting_takes_the_four_modes(mode):
    data = load_default_settings_dict()
    assert data["display"]["channel_colours"] == "off"
    data["display"]["channel_colours"] = mode
    assert SettingsCls.from_dict(data).display.channel_colours == mode


@pytest.mark.parametrize("mode", ["hemisphere", "", "Region", None])
def test_channel_colours_setting_is_validated(mode):
    data = load_default_settings_dict()
    data["display"]["channel_colours"] = mode
    with pytest.raises(SettingsError, match="display.channel_colours must be one of off, region, side, type"):
        SettingsCls.from_dict(data)


def test_older_study_files_without_channel_colours_leave_them_off():
    data = load_default_settings_dict()
    del data["display"]["channel_colours"]
    assert SettingsCls.from_dict(data).display.channel_colours == "off"


# ---------------------------------------------------------------- amplitude check
def _raw(scale: float, n_ch: int = 8, ch_type: str = "eeg", flat: int = 0, n: int = N) -> mne.io.RawArray:
    rng = np.random.default_rng(3)
    data = rng.normal(0, 1e-5, (n_ch, n)) * scale
    data[:flat] = 0.0
    info = mne.create_info([f"E{i}" for i in range(n_ch)], SF, ch_type)
    return mne.io.RawArray(data, info, verbose="error")


def test_plausible_eeg_needs_no_change():
    rep = check_amplitudes(_raw(1.0))
    assert not rep.warnings and not rep.suggested_scalings
    assert 1e-5 < rep.amplitudes_v["eeg"] < 5e-5  # 99.5th percentile of |N(0, 10 µV)| is about 28 µV


@pytest.mark.parametrize("scale, words", [(1e6, "far larger"), (1e-6, "far smaller")])
def test_implausible_amplitude_is_explained_and_given_a_scale(scale, words):
    raw = _raw(scale, flat=2)  # flat channels are left out of the measure
    rep = check_amplitudes(raw)
    amp = rep.amplitudes_v["eeg"]
    assert amp == pytest.approx(2.8e-5 * scale, rel=0.15)
    assert rep.suggested_scalings["eeg"] == nice_scale(amp) >= amp
    assert len(rep.warnings) == 1 and words in rep.warnings[0] and "EEG" in rep.warnings[0]
    # With the suggested scale MNE's viewer (which hides samples beyond 1.5 times the scale) shows most samples.
    shown = np.abs(raw.get_data()[2:]) <= 1.5 * rep.suggested_scalings["eeg"]
    assert shown.mean() > 0.99


def test_amplitude_types_and_flat_recordings():
    rep = check_amplitudes(_raw(1.0, flat=8))
    assert rep.amplitudes_v == {} and not rep.warnings  # nothing but flat channels: nothing to say
    rep = check_amplitudes(_raw(1e6, ch_type="misc"))
    assert rep.amplitudes_v == {}  # only EEG, EOG, EMG and ECG are judged
    ecg = check_amplitudes(_raw(50.0, ch_type="ecg"))  # about 1.4 mV: a normal ECG
    assert not ecg.warnings


def test_nice_scale_and_volts():
    assert [nice_scale(v) for v in (44.2, 1.0, 0.0013, 7e-11)] == [50.0, 1.0, 0.002, 1e-10]
    assert format_volts(44.2) == "44.2 V" and format_volts(2.8e-5) == "28 µV" and format_volts(3e-11) == "0.03 nV"
    with pytest.raises(ValueError):
        nice_scale(0.0)


def test_mis_scaled_recording_gets_a_display_scale_when_loaded(tmp_path):
    rid = write_recording(tmp_path, bdf=False, scale=1000.0)  # millivolts stored as microvolts
    lr, _ = load(tmp_path, rid)
    try:
        assert lr.display_scalings.get("eeg", 0) >= lr.amplitude_report.amplitudes_v["eeg"] > 2.5e-3
        assert any("amplitude is about" in w for w in lr.warnings)
    finally:
        lr.close()
    ok = tmp_path / "ok"
    rid = write_recording(ok, bdf=False)
    lr, _ = load(ok, rid)
    try:
        assert lr.display_scalings == {} and not any("amplitude" in w for w in lr.warnings)
    finally:
        lr.close()


# ------------------------------------------------------- filtering in blocks of channels
def test_channel_blocks():
    assert channel_blocks(list(range(10)), 1000, block_bytes=3 * 8000) == [[0, 1, 2], [3, 4, 5], [6, 7, 8], [9]]
    assert channel_blocks([4, 7], 10**9, block_bytes=1) == [[4], [7]]  # at least one channel per block


def test_filtering_in_blocks_matches_whole_recording_filtering(monkeypatch):
    raw = _raw(1.0, n_ch=10)
    reference = raw.copy()
    reference.filter(1.0, None, picks="all", skip_by_annotation=("edge", "bad_acq_skip"), verbose="error",
                     **{k: v for k, v in filtering.HIGHPASS_FIR_PARAMS.items()})
    reference.notch_filter([50.0], picks="all", skip_by_annotation=("edge", "bad_acq_skip"), verbose="error",
                           **filtering.NOTCH_FIR_PARAMS)
    monkeypatch.setattr(filtering, "FILTER_BLOCK_BYTES", 3 * N * 8)  # three channels per block
    messages: list[str] = []
    report = apply_view_filters(raw, FilterSettings(), [], [], progress=messages.append)
    assert np.array_equal(raw.get_data(), reference.get_data())
    assert report.channel_blocks == 4 and report.to_dict()["filtered_in_channel_blocks"] == 4
    assert messages == [f"Applying display filters: {k} of 10 channels" for k in (3, 6, 9, 10)]
    assert [s.filter_length_samples for s in report.steps] == [845, 1691]  # the design is still recorded


def test_filtering_in_blocks_keeps_memory_low(monkeypatch):
    n = 200_000  # long enough that the data, not the filter kernels, decide the memory
    raw = _raw(1.0, n_ch=24, n=n)
    size = raw._data.nbytes
    monkeypatch.setattr(filtering, "FILTER_BLOCK_BYTES", 2 * n * 8)
    tracemalloc.start()
    try:
        apply_view_filters(raw, FilterSettings(), [], [])
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    # Filtering all channels at once needed more than the size of the data again.
    assert peak < 0.5 * size


def test_loading_reports_filter_progress(tmp_path):
    rid = write_recording(tmp_path, bdf=False)
    messages: list[str] = []
    lr, _ = load(tmp_path, rid, progress=messages.append)
    lr.close()
    assert messages[-2:] == [f"Applying display filters: {len(NAMES)} of {len(NAMES)} channels",
                             "Checking the signal amplitude"]


# ------------------------------------------------------------------ saved outputs
def test_outputs_record_triggers_and_display_scale(tmp_path):
    codes, expected = status_codes()
    rid = write_recording(tmp_path, triggers={"Status": codes})
    lr, settings = load(tmp_path, rid)
    layout = OutputLayout(tmp_path / "Annotated_Events")
    session = make_session(layout, settings, default_catalogue(), lr)
    session.start()
    session.start_timer()
    session.store.add_interval("Movement-artifact", 10.0, 12.0)
    time.sleep(0.01)
    res = session.finish()
    lr.close()
    paths = res.commit.paths
    lines = paths["events_tsv"].read_text(encoding="utf-8").splitlines()
    header = lines[0].split("\t")
    originals = [ln.split("\t") for ln in lines[1:] if "original:stim_channel" in ln]
    assert [(int(r[header.index("sample")]), int(r[header.index("value")])) for r in originals] == expected
    assert {r[header.index("stim_channel")] for r in originals} == {"Status"}
    sidecar = json.loads(paths["events_json"].read_text(encoding="utf-8"))
    assert "original:stim_channel" in sidecar["event_source"]["Levels"] and "stim_channel" in sidecar
    meta = json.loads(paths["session_json"].read_text(encoding="utf-8"))
    assert meta["recording"]["trigger_channels"] == ["Status"] and "Status" not in meta["recording"]["ch_names"]
    assert meta["original_events"]["source"] == SOURCE_STIM
    assert meta["original_events"]["trigger_channels_read"] == ["Status"]
    assert meta["display"]["amplitude_check"]["display_scalings_set_automatically"] == {}
    canonical = json.loads(paths["annotations_json"].read_text(encoding="utf-8"))
    assert canonical["recording"]["hidden_channels"] == ["Status"]
