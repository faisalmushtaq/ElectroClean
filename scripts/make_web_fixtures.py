"""Write the test recordings of the browser data layer and what MNE-Python reads from them.

The browser reads EDF, EDF+, BDF and BrainVision files itself (electroclean/web/static/js/data/).
Its unit tests (web_tests/unit/, run with ``node --test web_tests/unit``) open the recordings
written here and compare everything with the values in the ``*.expected.json`` files: what MNE
reads (in volts), the SHA-256 that hashlib computes, the markers, gaps and triggers the desktop
application derives, the display filters as the desktop applies them, and the amplitude check.

Usage, from the repository root (the files are not committed; web_tests/fixtures/ is ignored):

    python scripts/make_web_fixtures.py            # writes web_tests/fixtures/
    python scripts/make_web_fixtures.py --perf     # also a 128-channel, 30-minute, 1024 Hz BDF

The tests run this script themselves when the fixtures are missing or out of date. It needs the
development dependencies (mne, numpy, scipy, pybv).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402

#: Bump when fixtures or expected values change; the tests regenerate older fixtures.
FIXTURE_VERSION = 3

DEFAULT_OUT = ROOT / "web_tests" / "fixtures"
HIDE = [
    "TIME_STAMP_s", "TIME_STAMP_ms", "OR_TIME_STAMP_s", "OR_TIME_STAMP_ms", "COUNTER", "INTERPOLATED",
    "RAW_CQ", "BATTERY", "BATTERY_PERCENT", "MarkerIndex", "MarkerType", "MarkerValueInt",
    "MARKER_HARDWARE", "CQ_*", "EQ_*",
]  # fmt: skip


# ----------------------------------------------------------------------------- writers
def _field(text: str | bytes, width: int) -> bytes:
    raw = text if isinstance(text, bytes) else text.encode("latin-1")
    if len(raw) > width:
        raise ValueError(f"{raw!r} is longer than {width} bytes")
    return raw.ljust(width, b" ")


def _num(value: float | int, width: int = 8) -> bytes:
    text = f"{value:g}" if isinstance(value, float) else str(value)
    return _field(text, width)


def write_custom_edf(
    path: Path,
    signals: list[dict],
    *,
    n_records: int,
    record_s: float,
    bdf: bool = False,
    reserved: str = "",
    n_records_in_header: int | None = None,
    recording_field: str = "Startdate 01-FEB-2024 X X X",
    date: str = "01.02.24",
    time: str = "13.14.15",
) -> Path:
    """An EDF/BDF file from signals given as dicts of label, unit (bytes or str), physical and
    digital ranges, samples per record and the digital samples (n_records * spr integers)."""
    ns = len(signals)
    head = (b"\xffBIOSEMI" if bdf else _field("0", 8)) + _field("X X X X", 80) + _field(recording_field, 80)
    head += _field(date, 8) + _field(time, 8) + _num(256 * (ns + 1)) + _field(reserved, 44)
    head += _num(n_records if n_records_in_header is None else n_records_in_header)
    head += _num(float(record_s)) + _num(ns, 4)
    head += b"".join(_field(s["label"], 16) for s in signals)
    head += b"".join(_field("", 80) for _ in signals)
    head += b"".join(_field(s.get("unit", "uV"), 8) for s in signals)
    for key in ("pmin", "pmax", "dmin", "dmax"):
        head += b"".join(_num(s[key]) for s in signals)
    head += b"".join(_field("", 80) for _ in signals)
    head += b"".join(_num(int(s["spr"])) for s in signals)
    head += b"".join(_field("", 32) for _ in signals)
    assert len(head) == 256 * (ns + 1)
    body = bytearray()
    for r in range(n_records):
        for s in signals:
            spr = int(s["spr"])
            chunk = np.asarray(s["digital"][r * spr : (r + 1) * spr], dtype=np.int64)
            if bdf:
                body += chunk.astype("<i4").view(np.uint8).reshape(-1, 4)[:, :3].tobytes()
            else:
                body += chunk.astype("<i2").tobytes()
    path.write_bytes(head + bytes(body))
    return path


def to_digital(values: np.ndarray, pmin: float, pmax: float, dmin: int, dmax: int) -> np.ndarray:
    d = np.round((values - pmin) / (pmax - pmin) * (dmax - dmin) + dmin)
    return np.clip(d, dmin, dmax).astype(np.int64)


def write_vhdr(path: Path, text: str, encoding: str) -> None:
    path.write_bytes(text.replace("\n", "\r\n").encode(encoding))


# ----------------------------------------------------------------------------- MNE side
def browser_type(name: str, mne_type: str) -> str:
    """The channel type the browser infers from a name (js/data/channels.js)."""
    import fnmatch
    import re

    if re.fullmatch(r"(status|trigger|trig|triggers|stim|sti\s*\d*)", name.strip(), re.IGNORECASE):
        return "stim"
    if any(fnmatch.fnmatchcase(name.strip(), p) for p in HIDE):
        return "misc"
    if mne_type == "misc":
        return "misc"
    if re.search("EOG", name, re.IGNORECASE):
        return "eog"
    if re.search("ECG|EKG", name, re.IGNORECASE):
        return "ecg"
    if re.search("EMG", name, re.IGNORECASE):
        return "emg"
    return "eeg" if mne_type in ("eeg", "eog", "ecg", "emg") else mne_type


def read_raw(path: Path, fmt: str):
    import mne

    if fmt == "edf":
        return mne.io.read_raw_edf(path, preload=True, infer_types=False, verbose="error")
    if fmt == "bdf":
        return mne.io.read_raw_bdf(path, preload=True, infer_types=False, verbose="error")
    return mne.io.read_raw_brainvision(path, preload=True, verbose="error")


def describe(raw, fmt: str, data_file: Path, files: list[Path], *, filters: list[dict], windows: list[tuple[int, int]],
             sample_idx: list[int], filter_windows: list[tuple[int, int]] | None = None,
             amplitude_filters: dict | None = None) -> dict:
    import mne

    from electroclean.app.annotations.timing import RecordingTiming
    from electroclean.app.eeg.amplitude import check_amplitudes
    from electroclean.app.eeg.filtering import apply_view_filters
    from electroclean.app.eeg.loading import _acquisition_gaps, _discontinuities
    from electroclean.config.settings import FilterSettings

    timing = RecordingTiming.from_raw(raw)
    sfreq = float(raw.info["sfreq"])
    types = raw.get_channel_types()
    names = list(raw.ch_names)
    data = raw.get_data()
    out: dict = {
        "format": fmt,
        "files": [p.name for p in files],
        "data_file": data_file.name,
        "size_bytes": data_file.stat().st_size,
        "sha256": hashlib.sha256(data_file.read_bytes()).hexdigest(),
        "sfreq": sfreq,
        "n_samples": int(raw.n_times),
        "ch_names": names,
        "mne_types": types,
        "browser_types": [browser_type(n, t) for n, t in zip(names, types)],
        "meas_date": raw.info["meas_date"].isoformat() if raw.info["meas_date"] else None,
    }
    anns = []
    for a in raw.annotations:
        onset = timing.time_to_sample(timing.from_mne_onset(float(a["onset"])))
        anns.append({"onset_sample": onset, "duration_samples": timing.time_to_sample(float(a["duration"])),
                     "description": str(a["description"])})
    out["annotations"] = anns
    gaps = _acquisition_gaps(raw, timing)
    disc = _discontinuities(raw, timing)
    out["gaps"] = [list(g) for g in gaps]
    out["discontinuities"] = disc
    triggers = []
    for i, (name, t) in enumerate(zip(names, types)):
        if t != "stim":
            continue
        ev = mne.find_events(raw, stim_channel=name, shortest_event=1, consecutive=True,
                             mask=0xFFFF if fmt == "bdf" else None, mask_type="and", initial_event=False,
                             verbose="error")
        triggers += [{"sample": int(s) - raw.first_samp, "code": int(c), "channel": name} for s, _, c in ev]
    triggers.sort(key=lambda e: (e["sample"], e["channel"]))
    out["triggers"] = triggers
    values = [[float(data[c, i]) for i in sample_idx] for c in range(len(names))]
    out["samples"] = {"indices": sample_idx, "values": values}
    out["windows"] = [{"start": a, "n": b - a, "values": data[:, a:b].tolist()} for a, b in windows]

    filtered = []
    shown = [n for n, t in zip(names, out["browser_types"]) if t not in ("stim",) and not any(
        __import__("fnmatch").fnmatchcase(n, p) for p in HIDE)]
    for spec in filters:
        fs = FilterSettings(
            highpass_enabled=spec["highpassHz"] is not None,
            highpass_hz=float(spec["highpassHz"] or 1.0),
            notch_enabled=spec["notchHz"] is not None,
            notch_hz=float(spec["notchHz"] or 50.0),
            notch_harmonics=bool(spec.get("notchHarmonics")),
        )
        copy = raw.copy()
        report = apply_view_filters(copy, fs, disc, gaps)
        fdata = copy.get_data()
        zones = report.transient_zones(int(raw.n_times))
        entry = {
            "filters": spec,
            "half_width_samples": int(round(report.transient_half_width_s * sfreq)),
            "lengths": [s.filter_length_samples for s in report.steps],
            "zones_s": [list(z) for z in zones],
            "windows": [
                {"start": a, "n": b - a, "values": fdata[:, a:b].tolist()} for a, b in (filter_windows or windows)
            ],
        }
        filtered.append(entry)
    out["filtered"] = filtered

    if amplitude_filters is not None:
        view = raw.copy().pick(shown)
        btypes = {n: browser_type(n, t) for n, t in zip(names, types)}
        mapping = {n: btypes[n] for n in view.ch_names if btypes[n] in ("eeg", "eog", "ecg", "emg", "misc")}
        with __import__("warnings").catch_warnings():
            __import__("warnings").simplefilter("ignore")
            view.set_channel_types(mapping, on_unit_change="ignore", verbose="error")
        fs = FilterSettings(
            highpass_enabled=amplitude_filters["highpassHz"] is not None,
            highpass_hz=float(amplitude_filters["highpassHz"] or 1.0),
            notch_enabled=amplitude_filters["notchHz"] is not None,
            notch_hz=float(amplitude_filters["notchHz"] or 50.0),
            notch_harmonics=bool(amplitude_filters.get("notchHarmonics")),
        )
        report = apply_view_filters(view, fs, disc, gaps)
        amp = check_amplitudes(view, gaps=gaps, edge_samples=int(round(report.transient_half_width_s * sfreq)))
        out["amplitude"] = {
            "filters": amplitude_filters,
            "shown": shown,
            "amplitudes_v": amp.amplitudes_v,
            "suggested_scalings": amp.suggested_scalings,
            "warnings": amp.warnings,
        }
    return out


def filter_designs() -> list[dict]:
    """Coefficients of MNE's designs for the desktop's settings at several sampling rates."""
    from mne.filter import create_filter

    from electroclean.app.eeg.filtering import notch_frequencies
    from electroclean.config.settings import FilterSettings

    out = []
    for sfreq in (100.0, 128.0, 200.0, 250.0, 256.0, 500.0, 512.0, 1000.0, 1024.0, 2048.0):
        for hp in (0.1, 0.3, 0.5, 1.0, 2.0, 5.0, 10.0):
            if hp >= sfreq / 2:
                continue
            h = create_filter(None, sfreq, hp, None, method="fir", phase="zero", fir_window="hamming",
                              fir_design="firwin", filter_length="auto", l_trans_bandwidth="auto", verbose="error")
            out.append({"kind": "highpass", "sfreq": sfreq, "hz": hp, "length": len(h), "h": _summary(h)})
        for base in (50.0, 60.0):
            for harmonics in (False, True):
                freqs = notch_frequencies(FilterSettings(notch_hz=base, notch_harmonics=harmonics), sfreq)
                if not freqs:
                    continue
                freqs = np.asarray(freqs, float)
                widths = freqs / 200.0
                lows = [f - w / 2.0 - 0.5 for f, w in zip(freqs, widths)]
                highs = [f + w / 2.0 + 0.5 for f, w in zip(freqs, widths)]
                try:
                    h = create_filter(None, sfreq, highs, lows, l_trans_bandwidth=0.5, h_trans_bandwidth=0.5,
                                      method="fir", phase="zero", fir_window="hamming", fir_design="firwin",
                                      filter_length="auto", verbose="error")
                except ValueError as exc:
                    out.append({"kind": "notch", "sfreq": sfreq, "hz": base, "harmonics": harmonics,
                                "freqs": freqs.tolist(), "error": str(exc)})
                    continue
                out.append({"kind": "notch", "sfreq": sfreq, "hz": base, "harmonics": harmonics,
                            "freqs": freqs.tolist(), "length": len(h), "h": _summary(h)})
    return out


def _summary(h: np.ndarray) -> dict:
    n = len(h)
    idx = sorted(set([0, 1, 2, n // 4, n // 3, n // 2 - 1, n // 2, n // 2 + 1, (2 * n) // 3, n - 2, n - 1]
                     + [int(i) for i in np.linspace(0, n - 1, 41)]))
    return {"indices": idx, "values": [float(h[i]) for i in idx], "sum": float(h.sum()),
            "sum_abs": float(np.abs(h).sum()), "full": h.tolist() if n <= 2000 else None}


# ----------------------------------------------------------------------------- fixtures
def make_all(out: Path) -> dict:
    from electroclean.synthetic import (
        ALL_CHANNELS,
        default_artifact_plan,
        synthesise_signal,
        write_edf,
        write_edf_recording,
    )

    out.mkdir(parents=True, exist_ok=True)
    index: dict[str, dict] = {}
    std_filters = [
        {"highpassHz": 1.0, "notchHz": 50.0, "notchHarmonics": False},
        {"highpassHz": 0.5, "notchHz": None, "notchHarmonics": False},
        {"highpassHz": None, "notchHz": 60.0, "notchHarmonics": True},
        {"highpassHz": 2.0, "notchHz": 50.0, "notchHarmonics": True},
    ]

    def save(name: str, info: dict) -> None:
        (out / f"{name}.expected.json").write_text(json.dumps(info), encoding="utf-8")
        index[name] = {"files": info["files"], "format": info["format"], "error": info.get("error")}

    # 1. EDF+C at 256 Hz: annotations with and without duration, a gap marked BAD_ACQ_SKIP in the
    #    middle and the padding of the last data record, two housekeeping channels.
    rng = np.random.default_rng(1)
    sfreq, dur = 256.0, 60.25
    plan = default_artifact_plan(dur, rng)
    sig = synthesise_signal(plan, sfreq, dur, 50.0, rng)
    n = sig.shape[1]
    hk = np.vstack([(np.arange(n) % 128) * 1e-6, np.full(n, 4e-6)])
    names = list(ALL_CHANNELS) + ["COUNTER", "CQ_Fp1"]
    anns = [(2.0, 0.0, "stim/1"), (6.0, 0.0, "stim/2"), (10.0, 5.0, "Eyes closed"),
            (30.0, 2.5, "BAD_ACQ_SKIP"), (41.25, 0.0, "café"), (50.0, 0.0, "stim/1")]
    p = write_edf(out / "edfplus_gap_eeg.edf", np.vstack([sig, hk]), sfreq, names, annotations=anns)
    raw = read_raw(p, "edf")
    N = int(raw.n_times)
    save("edfplus_gap", describe(
        raw, "edf", p, [p], filters=std_filters,
        windows=[(0, 300), (7600, 7800)],
        sample_idx=[0, 1, 255, 256, 7679, 7680, 8320, N // 2, N - 193, N - 192, N - 1],
        filter_windows=[(0, 1600), (3000, 4800), (6500, 9500), (N - 1700, N)],
        amplitude_filters={"highpassHz": 1.0, "notchHz": 50.0, "notchHarmonics": False},
    ))

    # 2. Plain EDF written by hand: 0.5 s records at 512 Hz, a channel at half the rate, units
    #    in latin-1 micro sign, mV and V, duplicate labels, a Trigger channel and a channel whose
    #    digital range is empty.
    n_rec, spr = 20, 256
    t = np.arange(n_rec * spr) / 512.0
    t_low = np.arange(n_rec * 128) / 256.0
    sigs = []
    a = 60e-6 * np.sin(2 * np.pi * 7 * t) + 15e-6 * np.cos(2 * np.pi * 31 * t)
    sigs.append({"label": "Fp1", "unit": b"\xb5V", "pmin": -400.0, "pmax": 400.0, "dmin": -32768, "dmax": 32767,
                 "spr": spr, "digital": to_digital(a * 1e6, -400.0, 400.0, -32768, 32767)})
    b = 0.08 * np.sin(2 * np.pi * 3 * t)  # in mV
    sigs.append({"label": "Fp2", "unit": "mV", "pmin": -0.5, "pmax": 0.5, "dmin": -32768, "dmax": 32767,
                 "spr": spr, "digital": to_digital(b, -0.5, 0.5, -32768, 32767)})
    c = 30e-6 * np.sin(2 * np.pi * 11 * t)
    for _ in range(2):
        sigs.append({"label": "EEG", "unit": "uV", "pmin": -250.0, "pmax": 250.0, "dmin": -2048, "dmax": 2047,
                     "spr": spr, "digital": to_digital(c * 1e6, -250.0, 250.0, -2048, 2047)})
    slow = 0.002 * np.sin(2 * np.pi * 0.5 * t_low)  # volts, smooth so that resampling methods agree
    sigs.append({"label": "Resp", "unit": "V", "pmin": -0.01, "pmax": 0.01, "dmin": -32768, "dmax": 32767,
                 "spr": 128, "digital": to_digital(slow, -0.01, 0.01, -32768, 32767)})
    trig = np.zeros(n_rec * spr, dtype=np.int64)
    trig[100:110] = 3
    trig[2000:2001] = 1
    trig[3000:3050] = 2
    trig[3050:3060] = 7
    trig[4000:4010] = -1  # stored as 0xFFFF; MNE keeps the lower 17 bits of the integer
    sigs.append({"label": "Trigger", "unit": "", "pmin": -32768.0, "pmax": 32767.0, "dmin": -32768, "dmax": 32767,
                 "spr": spr, "digital": trig})
    sigs.append({"label": "Flat", "unit": "uV", "pmin": -100.0, "pmax": 100.0, "dmin": 0, "dmax": 0,
                 "spr": spr, "digital": np.zeros(n_rec * spr, dtype=np.int64)})
    p = write_custom_edf(out / "edf_mixed_eeg.edf", sigs, n_records=n_rec, record_s=0.5)
    raw = read_raw(p, "edf")
    save("edf_mixed", describe(raw, "edf", p, [p], filters=[{"highpassHz": 1.0, "notchHz": 50.0}],
                               windows=[(0, 600), (2900, 3200)], sample_idx=[0, 1, 2, 255, 256, 511, 1000, 5119]))

    # 3. BDF at 512 Hz with a Status channel: an initial code, single-sample pulses, codes that
    #    follow each other without returning to zero, and BioSemi system bits above bit 15.
    rng = np.random.default_rng(3)
    sfreq, dur = 512.0, 20.0
    plan = default_artifact_plan(dur, rng)
    sig = synthesise_signal(plan, sfreq, dur, 60.0, rng)[:8]
    n = sig.shape[1]
    codes = np.zeros(n, dtype=np.int64)
    codes[:10] = 7
    codes[1000] = 5
    codes[2000:2100] = 3
    codes[2100:2150] = 4
    codes[3000:3020] = (1 << 16) | 9
    codes[4000:4030] = 1 << 16
    codes[4500:4510] = 1 << 20
    codes[5000:5040] = -(1 << 23) + 12
    codes[6000:6001] = 255
    codes[n - 1] = 6
    names = list(ALL_CHANNELS[:8])
    p = write_edf(out / "bdf_status_eeg.bdf", sig, sfreq, names, bdf=True, triggers={"Status": codes})
    raw = read_raw(p, "bdf")
    N = int(raw.n_times)
    save("bdf_status", describe(
        raw, "bdf", p, [p], filters=[{"highpassHz": 1.0, "notchHz": 60.0, "notchHarmonics": True}],
        windows=[(990, 1010), (4990, 5050)], sample_idx=[0, 9, 10, 1000, 3000, 4000, 4500, 5000, N - 1],
        filter_windows=[(0, 2000), (4000, 6000), (N - 2000, N)],
        amplitude_filters={"highpassHz": 1.0, "notchHz": None, "notchHarmonics": False},
    ))

    # 4. BDF+C with annotations (and padding of the last record).
    rng = np.random.default_rng(4)
    sfreq, dur = 256.0, 12.3
    sig = synthesise_signal(default_artifact_plan(dur, rng), sfreq, dur, 50.0, rng)
    p = write_edf(out / "bdfplus_eeg.bdf", sig, sfreq, list(ALL_CHANNELS), bdf=True,
                  annotations=[(1.0, 0.0, "start"), (5.5, 1.25, "Blink run"), (12.0, 0.0, "end")])
    raw = read_raw(p, "bdf")
    save("bdfplus", describe(raw, "bdf", p, [p], filters=[], windows=[(0, 50)], sample_idx=[0, 100, 3000, 3148, 3149]))

    # 5. BrainVision float32 (pybv), with a second 'New Segment' marker (a discontinuity).
    from electroclean.synthetic import write_recording

    vhdr, _, _ = write_recording(out / "bv_float32", "sub-01_task-rest", sfreq=500.0, duration_s=40.0, seed=5,
                                 discontinuity_s=20.0, write_bids_sidecars=False)
    files = [vhdr, vhdr.with_suffix(".vmrk"), vhdr.with_suffix(".eeg")]
    raw = read_raw(vhdr, "brainvision")
    save("bv_float32", describe(
        raw, "brainvision", vhdr.with_suffix(".eeg"), files, filters=std_filters[:2],
        windows=[(0, 100)], sample_idx=[0, 1, 9999, 10000, 19999],
        filter_windows=[(0, 2500), (6000, 7000), (8500, 11500), (17000, 20000)],
        amplitude_filters={"highpassHz": 1.0, "notchHz": 50.0, "notchHarmonics": False},
    ))

    # 6. BrainVision int16 (pybv), resolution 0.1 µV.
    import pybv

    rng = np.random.default_rng(6)
    sig = synthesise_signal(default_artifact_plan(10.0, rng), 250.0, 10.0, 50.0, rng)
    folder = out / "bv_int16"
    folder.mkdir(exist_ok=True)
    pybv.write_brainvision(data=sig, sfreq=250.0, ch_names=list(ALL_CHANNELS), fname_base="int16_eeg",
                           folder_out=str(folder), events=[{"onset": 100, "duration": 25, "description": 3,
                                                            "type": "Stimulus"}],
                           resolution=0.1, unit="µV", fmt="binary_int16", overwrite=True,
                           meas_date=datetime(2023, 6, 7, 8, 9, 10, 123456, tzinfo=timezone.utc))
    vhdr = folder / "int16_eeg.vhdr"
    files = [vhdr, folder / "int16_eeg.vmrk", folder / "int16_eeg.eeg"]
    raw = read_raw(vhdr, "brainvision")
    save("bv_int16", describe(raw, "brainvision", folder / "int16_eeg.eeg", files, filters=[],
                              windows=[(0, 200)], sample_idx=[0, 1, 2499]))

    # 7. BrainVision written by hand: VECTORIZED, INT_32, Codepage=ANSI (cp1252), units µV, mV,
    #    nV and °C, a comma in a name, markers with durations, a second New Segment and a comment.
    folder = out / "bv_vec_int32"
    folder.mkdir(exist_ok=True)
    n = 3000
    rng = np.random.default_rng(7)
    chans = [("Fp1", "0.05", "µV"), ("Fp2", "0.0001", "mV"), (r"C\1z", "0.5", "µV"), ("Temp", "0.01", "°C"),
             ("HEOGL", "0.1", "µV"), ("Ch6", "10", "nV")]
    ints = rng.integers(-20000, 20000, size=(len(chans), n)).astype(np.int32)
    ints[3] = 3650 + (np.arange(n) % 7)
    (folder / "vec_eeg.eeg").write_bytes(ints.astype("<i4").tobytes())  # vectorized: channel after channel
    vhdr_text = (
        "Brain Vision Data Exchange Header File Version 1.0\n"
        "; Data created by hand for the browser tests\n\n"
        "[Common Infos]\nCodepage=ANSI\nDataFile=vec_eeg.eeg\nMarkerFile=vec_eeg.vmrk\n"
        "DataFormat=BINARY\nDataOrientation=VECTORIZED\nNumberOfChannels=6\nDataPoints=3000\n"
        "SamplingInterval=4000\n\n"
        "[Binary Infos]\nBinaryFormat=INT_32\n\n"
        "[Channel Infos]\n; Each entry: Ch<n>=<Name>,<Reference>,<Resolution>,<Unit>\n"
        + "".join(f"Ch{i + 1}={nm},,{res},{unit}\n" for i, (nm, res, unit) in enumerate(chans))
        + "\n[Comment]\nA comment = with an equals sign and café.\n"
    )
    write_vhdr(folder / "vec_eeg.vhdr", vhdr_text, "cp1252")
    vmrk_text = (
        "Brain Vision Data Exchange Marker File Version 1.0\n\n[Common Infos]\nCodepage=ANSI\nDataFile=vec_eeg.eeg\n\n"
        "[Marker Infos]\n"
        "Mk1=New Segment,,1,1,0,20240305101112123456\n"
        "Mk2=Stimulus,S  1,100,1,0\n"
        "Mk3=Comment,two \\1 parts,200,0,0\n"  # ASCII: MNE pre-reads the .vmrk in the locale encoding
        "Mk4=New Segment,,1501,1,0\n"
        "Mk5=Bad Interval,Bad Min-Max,1800,57,0\n"
        "Mk6=Response,R 12,2999,1,0\n"
    )
    write_vhdr(folder / "vec_eeg.vmrk", vmrk_text, "cp1252")
    vhdr = folder / "vec_eeg.vhdr"
    files = [vhdr, folder / "vec_eeg.vmrk", folder / "vec_eeg.eeg"]
    raw = read_raw(vhdr, "brainvision")
    save("bv_vec_int32", describe(raw, "brainvision", folder / "vec_eeg.eeg", files,
                                  filters=[{"highpassHz": 1.0, "notchHz": 50.0, "notchHarmonics": False}],
                                  windows=[(0, 50), (1490, 1510)], sample_idx=[0, 1, 1499, 1500, 2999],
                                  filter_windows=[(0, 3000)]))

    # 8. BrainVision by hand: VECTORIZED, IEEE_FLOAT_32, UTF-8, "Common infos" (NeurOne), no
    #    DataPoints, an entry without a unit and one with a unit but no resolution.
    folder = out / "bv_vec_float32"
    folder.mkdir(exist_ok=True)
    n = 2000
    rng = np.random.default_rng(8)
    fl = rng.normal(0, 20, size=(4, n)).astype(np.float32)
    fl[3] = (fl[3] * 1e-6).astype(np.float32)
    (folder / "f32.eeg").write_bytes(fl.astype("<f4").tobytes())
    vhdr_text = (
        "Brain Vision Data Exchange Header File Version 2.0\n\n"
        "[Common infos]\nCodepage=UTF-8\nDataFile=f32.eeg\nMarkerFile=f32.vmrk\nDataFormat=BINARY\n"
        "DataOrientation=VECTORIZED\nNumberOfChannels=4\nSamplingInterval=1000\n\n"
        "[Binary Infos]\nBinaryFormat=IEEE_FLOAT_32\n\n"
        "[Channel Infos]\nCh1=Cz,,1\nCh2=Pz,,0.5,µV\nCh3=EMG1,,,µV\nCh4=Abs,,1,V\n"
    )
    write_vhdr(folder / "f32.vhdr", vhdr_text, "utf-8")
    write_vhdr(folder / "f32.vmrk", "Brain Vision Data Exchange Marker File Version 2.0\n\n[Marker Infos]\n"
               "Mk1=Stimulus,S 99,10,1,0\nMk2=Comment,Ünïcödé,1999,2,0\n", "utf-8")
    vhdr = folder / "f32.vhdr"
    files = [vhdr, folder / "f32.vmrk", folder / "f32.eeg"]
    raw = read_raw(vhdr, "brainvision")
    save("bv_vec_float32", describe(raw, "brainvision", folder / "f32.eeg", files, filters=[],
                                    windows=[(0, 40)], sample_idx=[0, 1, 1999]))

    # 9. Emotiv-like EDF+ with housekeeping channels (from the desktop's synthetic writer).
    path, _, _ = write_edf_recording(out / "emotiv", "sub-01_task-rest", write_bids_sidecars=False)
    raw = read_raw(path, "edf")
    save("emotiv", describe(raw, "edf", path, [path], filters=[], windows=[(0, 10)], sample_idx=[0, 5000],
                            amplitude_filters={"highpassHz": 1.0, "notchHz": None, "notchHarmonics": False}))

    # 10. Microvolts stored as volts: the amplitude check proposes a display scale.
    rng = np.random.default_rng(10)
    sig = synthesise_signal(default_artifact_plan(20.0, rng), 128.0, 20.0, 50.0, rng)
    p = write_edf(out / "wrong_units_eeg.edf", sig, 128.0, list(ALL_CHANNELS))
    blob = bytearray(p.read_bytes())
    ns = len(ALL_CHANNELS)
    base = 256 + ns * (16 + 80)
    for i in range(ns):
        blob[base + 8 * i : base + 8 * i + 8] = b"V       "
    p.write_bytes(bytes(blob))
    raw = read_raw(p, "edf")
    save("wrong_units", describe(raw, "edf", p, [p], filters=[], windows=[(0, 10)], sample_idx=[0],
                                 amplitude_filters={"highpassHz": 1.0, "notchHz": None, "notchHarmonics": False}))

    # 11. Files the desktop refuses or warns about.
    rng = np.random.default_rng(11)
    sig = rng.normal(0, 10e-6, size=(3, 1280))
    p = write_edf(out / "edfplusd_eeg.edf", sig, 128.0, ["Cz", "Pz", "Oz"], annotations=[(1.0, 0.0, "x")])
    blob = bytearray(p.read_bytes())
    blob[192:197] = b"EDF+D"
    p.write_bytes(bytes(blob))
    index["edfplusd"] = {"files": [p.name], "format": "edf", "error": "discontinuous"}

    p = write_edf(out / "truncated_eeg.edf", sig, 128.0, ["Cz", "Pz", "Oz"])
    p.write_bytes(p.read_bytes()[:-100])
    index["truncated"] = {"files": [p.name], "format": "edf", "error": "probably truncated"}

    p = write_edf(out / "unknown_records_eeg.edf", sig, 128.0, ["Cz", "Pz", "Oz"], n_records_in_header=-1)
    raw = read_raw(p, "edf")
    info = describe(raw, "edf", p, [p], filters=[], windows=[(0, 10)], sample_idx=[0, 1279])
    info["warning"] = "the header does not give the number of data records"
    save("unknown_records", info)

    p = write_edf(out / "longer_eeg.edf", sig, 128.0, ["Cz", "Pz", "Oz"])
    p.write_bytes(p.read_bytes() + b"\x00" * 12)
    index["longer"] = {"files": [p.name], "format": "edf", "error": "longer than"}

    folder = out / "bv_truncated"
    folder.mkdir(exist_ok=True)
    vhdr, _, _ = write_recording(folder, "sub-02", sfreq=250.0, duration_s=8.0, seed=12, write_bids_sidecars=False)
    eeg = vhdr.with_suffix(".eeg")
    eeg.write_bytes(eeg.read_bytes()[:-6])
    index["bv_truncated"] = {"files": [vhdr.name, vhdr.with_suffix(".vmrk").name, eeg.name], "format": "brainvision",
                             "folder": "bv_truncated", "error": "not a whole number of samples"}

    folder = out / "bv_short"
    folder.mkdir(exist_ok=True)
    vhdr, _, _ = write_recording(folder, "sub-03", sfreq=250.0, duration_s=8.0, seed=13, write_bids_sidecars=False)
    eeg = vhdr.with_suffix(".eeg")
    frame = 4 * len(ALL_CHANNELS)
    eeg.write_bytes(eeg.read_bytes()[: frame * 1000])
    text = vhdr.read_text(encoding="utf-8")
    kept = [ln for ln in text.splitlines() if not ln.startswith("DataPoints")]
    vhdr.write_text("\n".join(kept) + "\n", encoding="utf-8")
    index["bv_short"] = {"files": [vhdr.name, vhdr.with_suffix(".vmrk").name, eeg.name], "format": "brainvision",
                         "folder": "bv_short", "error": "beyond the end of the EEG data"}

    (out / "filters.expected.json").write_text(json.dumps(filter_designs()), encoding="utf-8")
    for name in ("bv_float32", "bv_int16", "bv_vec_int32", "bv_vec_float32", "emotiv"):
        index[name]["folder"] = name
    return index


def make_perf(out: Path) -> dict:
    """A 128-channel, 30-minute, 1024 Hz BDF with Status triggers, written record by record."""
    n_ch, sfreq, minutes = 128, 1024, 30
    n_rec = minutes * 60
    path = out / "perf_128ch_30min_eeg.bdf"
    signals = [{"label": f"A{i + 1}", "unit": "uV", "pmin": -262144.0, "pmax": 262143.0, "dmin": -8388608,
                "dmax": 8388607, "spr": sfreq} for i in range(n_ch)]
    signals.append({"label": "Status", "unit": "Boolean", "pmin": -8388608, "pmax": 8388607, "dmin": -8388608,
                    "dmax": 8388607, "spr": sfreq})
    ns = len(signals)
    head = b"\xffBIOSEMI" + _field("X X X X", 80) + _field("Startdate 01-JAN-2024 X X X", 80)
    head += _field("01.01.24", 8) + _field("12.00.00", 8) + _num(256 * (ns + 1)) + _field("24BIT", 44)
    head += _num(n_rec) + _num(1.0) + _num(ns, 4)
    head += b"".join(_field(s["label"], 16) for s in signals) + b"".join(_field("", 80) for _ in signals)
    head += b"".join(_field(s["unit"], 8) for s in signals)
    for key in ("pmin", "pmax", "dmin", "dmax"):
        head += b"".join(_num(s[key]) for s in signals)
    head += b"".join(_field("", 80) for _ in signals) + b"".join(_num(s["spr"]) for s in signals)
    head += b"".join(_field("", 32) for _ in signals)
    rng = np.random.default_rng(128)
    sha = hashlib.sha256()
    n_events = 0
    with open(path, "wb") as fh:
        fh.write(head)
        sha.update(head)
        t = np.arange(sfreq) / sfreq
        offsets = rng.integers(-200000, 200000, size=(n_ch, 1))
        for r in range(n_rec):
            alpha = (np.sin(2 * np.pi * 10 * (t + r)) * 800).astype(np.int64)
            noise = rng.integers(-1500, 1500, size=(n_ch, sfreq))
            block = offsets + noise + alpha[None, :]
            status = np.zeros(sfreq, dtype=np.int64)
            if r % 2 == 0:
                status[100:120] = 1 + (r // 2) % 250
                n_events += 1
            status |= 1 << 20  # a BioSemi system bit, always set
            allc = np.vstack([block, status[None, :]]).astype("<i4")
            raw = allc.view(np.uint8).reshape(ns, sfreq, 4)[:, :, :3].tobytes()
            fh.write(raw)
            sha.update(raw)
    return {"file": path.name, "sha256": sha.hexdigest(), "size_bytes": path.stat().st_size, "n_channels": n_ch + 1,
            "sfreq": float(sfreq), "n_samples": n_rec * sfreq, "n_events": n_events}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--perf", action="store_true", help="also write the 128-channel, 30-minute BDF used for timing")
    args = ap.parse_args()
    out: Path = args.out
    index = make_all(out)
    manifest = {"version": FIXTURE_VERSION, "fixtures": index}
    if args.perf:
        manifest["perf"] = make_perf(out)
    elif (out / "manifest.json").exists():
        old = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
        if "perf" in old and (out / old["perf"]["file"]).exists():
            manifest["perf"] = old["perf"]
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    print(f"Wrote {len(index)} fixtures to {out}" + (" and the timing recording" if args.perf else ""))


if __name__ == "__main__":
    main()
