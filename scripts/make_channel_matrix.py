"""Write a covering set of synthetic recordings across channel counts, formats and edge cases.

ElectroTag must read every recording a study may hold, from a two-channel sleep headband to a
256-channel high-density net, in the browser (electrotag/web/static/js/eeg/) exactly as MNE-Python
reads it in the Python core. This script writes recordings with 1 to 257 channels in EDF, EDF+,
BDF and BrainVision (INT_16 and IEEE_FLOAT_32, multiplexed and vectorized), at sampling rates from
128 to 2048 Hz, with the naming schemes of the common systems (10-20, 10-10, 10-05, BioSemi A1 to
H32, EGI E1 to E256 with Cz or VREF, plain numbers, bipolar pairs, names with spaces, mixed case,
non-ASCII and long names), with EOG, ECG, EMG, miscellaneous and trigger channels, and with the
edge cases that have broken readers before: signals at different rates in one EDF, an EDF+
annotation signal, very short recordings, odd data record durations, a physical range that is
empty, duplicate channel names, and headers that are empty or corrupt.

The cases below are chosen so that each value of each dimension appears at least once, which keeps
the set small enough (about 12 MB) to be written at test time.

    python scripts/make_channel_matrix.py --out DIR            # the recordings and what MNE reads
    python scripts/make_channel_matrix.py --list               # the cases, one per line
    python scripts/make_channel_matrix.py --big FILE.bdf --channels 256 --sfreq 2048 --minutes 20

``scripts/make_web_fixtures.py`` calls :func:`make_matrix` to put the set into
``web_tests/fixtures/matrix/``, where the browser's unit tests compare their reading with MNE's
(``data_readers.test.mjs``, ``data_filtering.test.mjs``, ``data_amplitude.test.mjs``) and their
manifests with Python's (``data_register.test.mjs``), and ``tests/test_channel_matrix.py`` sends
the same recordings through the Python pipeline. ``--big`` writes one large BDF record by record,
for timing the fingerprint of a file of several gigabytes; delete it afterwards.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402

TEN_TWENTY = ["Fp1", "Fp2", "F7", "F3", "Fz", "F4", "F8", "T7", "C3", "Cz", "C4", "T8", "P7", "P3", "Pz", "P4",
              "P8", "O1", "O2"]  # fmt: skip
TEN_TEN = [
    "Fp1", "Fpz", "Fp2", "AF7", "AF3", "AFz", "AF4", "AF8", "F7", "F5", "F3", "F1", "Fz", "F2", "F4", "F6", "F8",
    "FT7", "FC5", "FC3", "FC1", "FCz", "FC2", "FC4", "FC6", "FT8", "T7", "C5", "C3", "C1", "Cz", "C2", "C4", "C6",
    "T8", "TP7", "CP5", "CP3", "CP1", "CPz", "CP2", "CP4", "CP6", "TP8", "P7", "P5", "P3", "P1", "Pz", "P2", "P4",
    "P6", "P8", "PO7", "PO3", "POz", "PO4", "PO8", "O1", "Oz", "O2", "Iz", "T9", "T10",
]  # fmt: skip
BIPOLAR = ["FP1-F7", "F7-T7", "T7-P7", "P7-O1", "FP1-F3", "F3-C3", "C3-P3", "P3-O1", "FP2-F4", "F4-C4", "C4-P4",
           "P4-O2", "FP2-F8", "F8-T8", "T8-P8", "P8-O2", "FZ-CZ", "CZ-PZ", "P7-T7", "T7-FT9", "FT9-FT10",
           "FT10-T8", "T8-P8"]  # fmt: skip  (CHB-MIT's 23 signals, T8-P8 twice)


def ten_five(n: int) -> list[str]:
    """n names in the style of the 10-05 system (AFp3h, FFT7h, ...), all different."""
    rows = ["Fp", "AFp", "AF", "AFF", "F", "FFC", "FC", "FCC", "C", "CCP", "CP", "CPP", "P", "PPO", "PO", "POO", "O"]
    cols = ["9", "7", "7h", "5", "5h", "3", "3h", "1", "1h", "z", "2h", "2", "4h", "4", "6h", "6", "8h", "8", "10"]
    names = [r + c for r in rows for c in cols]
    return names[:n]


def biosemi(n: int) -> list[str]:
    """BioSemi's names A1 to H32 (32 per letter)."""
    return [f"{chr(ord('A') + i // 32)}{i % 32 + 1}" for i in range(n)]


def egi(n: int, ref: str | None = None) -> list[str]:
    """EGI's names E1 to En, with the reference (Cz or VREF) as the last channel when given."""
    return [f"E{i + 1}" for i in range(n)] + ([ref] if ref else [])


@dataclass
class Case:
    """One recording of the matrix."""

    id: str
    fmt: str  # "edf", "bdf", "bv"
    names: list[str]
    sfreq: float
    duration_s: float
    what: str
    binary: str = "IEEE_FLOAT_32"  # BrainVision: INT_16 or IEEE_FLOAT_32
    orientation: str = "MULTIPLEXED"  # BrainVision: MULTIPLEXED or VECTORIZED
    record_s: float = 1.0  # EDF/BDF data record duration
    annotations: list[tuple[float, float, str]] | None = None  # EDF+ / BrainVision markers
    triggers: str | None = None  # name of a trigger channel (Status, Trigger, STI 014)
    slow: dict[str, int] = field(default_factory=dict)  # EDF: channel -> samples per record (lower rate)
    flat_physical: list[str] = field(default_factory=list)  # EDF: channels whose physical range is empty
    zero: list[str] = field(default_factory=list)  # channels that hold only zeros (EGI's VREF, unused EXG)
    filters: list[dict] = field(default_factory=list)  # display filters to compare
    amplitude: bool = False  # compare the amplitude check
    broken: str | None = None  # how the file is broken, for the refusals
    error: str | None = None  # what both readers say when they refuse the file

    @property
    def n_channels(self) -> int:
        return len(self.names) + (1 if self.triggers else 0)

    @property
    def n_eeg(self) -> int:
        """The EEG channels: those that are not EOG, ECG, EMG, respiration, temperature, BioSemi's EXG,
        EGI's reference or a trigger channel."""
        other = ("eog", "ecg", "emg", "resp", "temp", "exg", "vref", "sti ")
        return sum(1 for n in self.names if not any(n.lower().startswith(o) or o in n.lower() for o in other))

    @property
    def stem(self) -> str:
        return f"sub-{self.id}_task-matrix_eeg"

    @property
    def extension(self) -> str:
        return {"edf": ".edf", "bdf": ".bdf", "bv": ".vhdr"}[self.fmt]


HP = {"highpassHz": 1.0, "notchHz": 50.0, "notchHarmonics": False}
HP60 = {"highpassHz": 0.5, "notchHz": 60.0, "notchHarmonics": True}
AMP = {"highpassHz": 1.0, "notchHz": None, "notchHarmonics": False}

CASES: list[Case] = [
    Case("c001", "edf", ["Cz"], 128.0, 30.0, "one channel, EDF at 128 Hz", filters=[HP]),
    Case("c002", "bdf", ["EEG Fpz-Cz", "EEG Pz-Oz"], 250.0, 20.0, "two channels with spaces in their names, BDF",
         triggers="Status", amplitude=True),
    Case("c004", "bv", ["fp1", "FP2", "cZ", "Oz"], 256.0, 16.0,
         "four channels in mixed case, BrainVision INT_16 vectorized", binary="INT_16",
         orientation="VECTORIZED", annotations=[(2.0, 0.0, "S  1"), (7.5, 0.0, "R  2")]),
    Case("c008", "edf", [str(i + 1) for i in range(8)], 250.0, 24.0,
         "eight channels named by number, EDF+ with annotations",
         annotations=[(1.0, 0.0, "start"), (4.25, 1.5, "eyes closed"), (20.0, 0.0, "end")], record_s=0.2),
    Case("c016", "bv", TEN_TWENTY[:16] + ["HEOG", "VEOG", "ECG"], 512.0, 12.0,
         "16 channels with EOG and ECG, BrainVision IEEE_FLOAT_32 multiplexed", annotations=[(3.0, 0.0, "S 11")],
         filters=[HP60], amplitude=True),
    Case("c019", "edf", TEN_TWENTY + ["EMG chin", "Resp", "Temp"], 256.0, 20.0,
         "the 19 channels of the 10-20 system with EMG and slower Resp and Temp signals (different samples per record)",
         slow={"Resp": 32, "Temp": 1}, amplitude=True),
    Case("c021", "edf", BIPOLAR[:21], 256.0, 25.0, "21 bipolar channels with a 2.5 s data record", record_s=2.5),
    Case("c023", "edf", BIPOLAR, 256.0, 10.0, "23 bipolar channels, one name twice (as in CHB-MIT)"),
    Case("c032", "bdf", biosemi(32), 2048.0, 4.0, "BioSemi A1 to A32 with Status at 2048 Hz", triggers="Status",
         filters=[HP]),
    Case("c064", "bv", TEN_TEN[:64] + ["HEOG", "VEOG"], 1000.0, 8.0,
         "64 channels of the 10-10 system, BrainVision INT_16, Iz switched off (zeros)", binary="INT_16",
         annotations=[(1.0, 0.0, "S  1"), (5.0, 0.0, "S  2")], amplitude=True, zero=["Iz"]),
    Case("c064e", "edf", [n + "." * (4 - len(n)) for n in TEN_TEN[:64]], 160.0, 20.0,
         "64 channels in the EEG Motor Movement/Imagery naming (Fc5. ...), EDF+ at 160 Hz",
         annotations=[(0.0, 4.2, "T0"), (4.2, 4.1, "T2"), (8.3, 4.2, "T0")]),
    Case("c128", "bdf", biosemi(128) + [f"EXG{i + 1}" for i in range(8)], 512.0, 6.0,
         "BioSemi 128 + 8 EXG channels with Status", triggers="Status", amplitude=True),
    Case("c129", "edf", egi(128, "Cz"), 250.0, 8.0, "EGI E1 to E128 with Cz, whose physical range is empty",
         flat_physical=["Cz"]),
    Case("c160", "bv", ten_five(160), 500.0, 4.0, "160 channels with 10-05 names, BrainVision IEEE_FLOAT_32 vectorized",
         orientation="VECTORIZED", annotations=[(2.0, 0.0, "S  3")], filters=[HP], amplitude=True),
    Case("c256b", "bdf", biosemi(256), 2048.0, 1.0, "BioSemi A1 to H32 with Status at 2048 Hz", triggers="Status"),
    Case("c256e", "bv", egi(256, "VREF"), 1000.0, 3.0,
         "EGI E1 to E256 with VREF (the reference, all zeros), BrainVision INT_16",
         binary="INT_16", annotations=[(1.0, 0.0, "DIN1")], filters=[HP], amplitude=True, zero=["VREF"]),
    Case("c256n", "edf", egi(256), 128.0, 10.0, "EGI E1 to E256 without a reference channel, EDF at 128 Hz",
         triggers="Trigger"),
    Case("c256u", "bv", [f"Électrode {i + 1} – région α{i % 7}" + ("·" * (i % 40)) for i in range(256)], 250.0, 4.0,
         "256 long names with spaces and non-ASCII letters, BrainVision in UTF-8"),
    # edge cases
    Case("e_short_edf", "edf", ["Fz", "Cz", "Pz"], 256.0, 0.25, "a recording of 64 samples in one 0.25 s record",
         record_s=0.25, filters=[HP]),
    Case("e_short_bv", "bv", ["Fz", "Cz"], 1000.0, 0.003, "a recording of three samples", binary="INT_16"),
    Case("e_odd_record", "bdf", TEN_TWENTY[:8], 250.0, 9.6,
         "0.04 s data records (10 samples each) with EDF+ annotations",
         record_s=0.04, annotations=[(0.5, 0.0, "a"), (9.0, 0.0, "b")]),
    Case("e_latin1", "edf", ["Fp1", "Fp2µ", "Cz°", "Ä1"], 500.0, 4.0, "labels in latin-1 (µ, °, Ä)"),
    Case("e_dup_bv", "bv", ["Cz", "Cz", "Pz", "Pz", "Pz"], 500.0, 4.0, "duplicate names in a BrainVision header",
         broken="duplicate_names"),
    Case("e_many_markers", "bv", TEN_TWENTY[:4], 1000.0, 14.0,
         "10,500 markers, one on every sample a trigger is held (as EGI's DIN markers in ds003420)", binary="INT_16",
         annotations=[(2.0 + k / 1000.0, 0.0, "D249" if (k // 700) % 2 else "D250") for k in range(10_500)]),
    Case("e_stim", "edf", TEN_TWENTY[:4] + ["STI 014"], 500.0, 6.0, "a stimulus channel named STI 014",
         triggers=None, slow={}),
    Case("r_empty", "edf", ["Cz"], 128.0, 1.0, "an empty file", broken="empty"),
    Case("r_header_only", "bdf", ["Cz", "Pz"], 128.0, 1.0, "a header and no data", broken="header_only"),
    Case("r_no_signals", "edf", ["Cz"], 128.0, 1.0, "a header that announces no signals", broken="no_signals"),
    Case("r_bad_field", "edf", ["Cz", "Pz"], 128.0, 2.0, "a header whose number of records is not a number",
         broken="bad_field"),
    Case("r_bad_size", "edf", ["Cz", "Pz"], 128.0, 2.0, "a header whose size disagrees with its signals",
         broken="bad_size"),
    Case("r_bv_empty", "bv", ["Cz"], 250.0, 1.0, "an empty BrainVision header", broken="empty"),
    Case("r_bv_no_channels", "bv", ["Cz", "Pz"], 250.0, 1.0, "a BrainVision header without channel entries",
         broken="no_channels"),
]
CASES_BY_ID = {c.id: c for c in CASES}


# ----------------------------------------------------------------------------- the signals
def signals_for(case: Case, rng: np.random.Generator) -> np.ndarray:
    """Plausible EEG in volts, channels x samples: the synthetic montage of electrotag.synthetic,
    mixed so that every channel differs, with EOG, ECG and EMG where the names say so."""
    from electrotag.synthetic import default_artifact_plan, synthesise_signal

    dur = max(case.duration_s, 1.0)
    base = synthesise_signal(default_artifact_plan(dur, rng), case.sfreq, dur, 50.0, rng)
    n = int(round(case.duration_s * case.sfreq))
    base = base[:, :n]
    k = base.shape[0]
    mix = rng.normal(0, 0.25, size=(len(case.names), k))
    mix[np.arange(len(case.names)), np.arange(len(case.names)) % k] += 1.0
    data = mix @ base
    t = np.arange(n) / case.sfreq
    for i, name in enumerate(case.names):
        low = name.lower()
        if "eog" in low:
            data[i] += 60e-6 * np.sin(2 * np.pi * 0.3 * t)
        if "emg" in low:
            data[i] += 20e-6 * rng.standard_normal(n)
        if low == "temp":
            data[i] = 0.0365 + 0.0001 * np.sin(2 * np.pi * 0.01 * t)  # 36.5 °C stored as "mV"-sized values
        if low == "resp":
            data[i] = 300e-6 * np.sin(2 * np.pi * 0.25 * t)
        if name in case.zero:
            data[i] = 0.0
    return data


def trigger_codes(case: Case, n: int) -> np.ndarray:
    codes = np.zeros(n, dtype=np.int64)
    step = max(1, n // 6)
    for k, s in enumerate(range(step // 2, n - 2, step)):
        width = max(1, min(20, n - s - 1))
        codes[s : s + width] = 1 + k % 7
    if case.fmt == "bdf":
        codes |= 1 << 20  # a BioSemi system bit, set throughout
    return codes


# ----------------------------------------------------------------------------- writers
def _write_edf_case(case: Case, path: Path, data: np.ndarray, rng: np.random.Generator) -> None:
    from make_web_fixtures import to_digital, write_custom_edf

    from electrotag.synthetic import write_edf

    bdf = case.fmt == "bdf"
    simple = not case.slow and not case.flat_physical and all(nm.isascii() for nm in case.names)
    triggers = {case.triggers: trigger_codes(case, data.shape[1])} if case.triggers else None
    if "STI 014" in case.names:
        i = case.names.index("STI 014")
        data = data.copy()
        data[i] = trigger_codes(case, data.shape[1]) * 1e-6  # stored as "uV", read as integer codes
        triggers = None
    if simple:
        write_edf(path, data, case.sfreq, list(case.names), annotations=case.annotations, bdf=bdf,
                  record_duration_s=case.record_s, triggers=triggers)
        return
    # by hand: signals at their own rates, empty physical ranges and latin-1 labels
    spr = int(round(case.sfreq * case.record_s))
    n = data.shape[1]
    n_records = -(-n // spr)
    dmax = 8388607 if bdf else 32767
    dmin = -dmax - 1
    signals = []
    for i, name in enumerate(case.names):
        rate = case.slow.get(name, spr)
        if rate == spr:
            x = np.zeros(n_records * spr)
            x[:n] = data[i] * 1e6
        else:
            # the slower signal sampled at its own rate
            t_low = np.arange(n_records * rate) * (case.record_s / rate)
            x = np.interp(t_low, np.arange(n) / case.sfreq, data[i] * 1e6)
        if name in case.flat_physical:
            pmin = pmax = 0.0
            digital = np.round(x / 0.5).astype(np.int64).clip(dmin, dmax)
        else:
            pmax = float(np.ceil(max(np.abs(x).max(), 1.0) * 1.01))
            pmin = -pmax
            digital = to_digital(x, pmin, pmax, dmin, dmax)
        signals.append({"label": name, "unit": "uV", "pmin": pmin, "pmax": pmax, "dmin": dmin, "dmax": dmax,
                        "spr": rate, "digital": digital})
    write_custom_edf(path, signals, n_records=n_records, record_s=case.record_s, bdf=bdf)


def _bv_escape(name: str) -> str:
    return name.replace(",", r"\1")


def _write_bv_case(case: Case, vhdr: Path, data: np.ndarray) -> None:
    """A BrainVision recording written directly, so that names, codepage, format and orientation
    can be anything the format allows (pybv writes multiplexed files with unique names)."""
    stem = vhdr.stem
    n_ch, n = data.shape
    interval = 1e6 / case.sfreq
    if case.binary == "INT_16":
        res = [0.1] * n_ch
        values = np.clip(np.round(data * 1e6 / 0.1), -32768, 32767).astype("<i2")
    else:
        res = [1.0] * n_ch
        values = (data * 1e6).astype("<f4")
    order = values if case.orientation == "VECTORIZED" else values.T
    (vhdr.parent / f"{stem}.eeg").write_bytes(np.ascontiguousarray(order).tobytes())
    head = (
        "Brain Vision Data Exchange Header File Version 1.0\n"
        "; Data written by scripts/make_channel_matrix.py\n\n"
        f"[Common Infos]\nCodepage=UTF-8\nDataFile={stem}.eeg\nMarkerFile={stem}.vmrk\nDataFormat=BINARY\n"
        f"DataOrientation={case.orientation}\nNumberOfChannels={n_ch}\nSamplingInterval={interval!r}\n\n"
        f"[Binary Infos]\nBinaryFormat={case.binary}\n\n"
        "[Channel Infos]\n; Each entry: Ch<n>=<Name>,<Reference>,<Resolution>,<Unit>\n"
        + "".join(f"Ch{i + 1}={_bv_escape(nm)},,{res[i]!r},µV\n" for i, nm in enumerate(case.names))
    )
    if case.broken == "no_channels":
        head = head.split("[Channel Infos]")[0]
    vhdr.write_bytes(b"" if case.broken == "empty" else head.replace("\n", "\r\n").encode("utf-8"))
    marks = ["Mk1=New Segment,,1,1,0,20240101120000000000"]
    for k, (onset, dur, text) in enumerate(case.annotations or []):
        kind = "Response" if text.startswith("R") else "Stimulus"
        pos, length = int(round(onset * case.sfreq)) + 1, max(1, int(round(dur * case.sfreq)))
        marks.append(f"Mk{k + 2}={kind},{text},{pos},{length},0")
    vmrk = (
        "Brain Vision Data Exchange Marker File, Version 1.0\n\n"
        f"[Common Infos]\nCodepage=UTF-8\nDataFile={stem}.eeg\n\n[Marker Infos]\n" + "\n".join(marks) + "\n"
    )
    (vhdr.parent / f"{stem}.vmrk").write_bytes(vmrk.replace("\n", "\r\n").encode("utf-8"))


def _break_edf(case: Case, path: Path) -> None:
    blob = bytearray(path.read_bytes())
    if case.broken == "empty":
        blob = bytearray()
    elif case.broken == "header_only":
        blob = blob[: 256 * (len(case.names) + 1)]
    elif case.broken == "no_signals":
        blob[252:256] = b"0   "
        blob[184:192] = b"256     "
        blob = blob[:256] + blob[256 * (len(case.names) + 1) :]
    elif case.broken == "bad_field":
        blob[236:244] = b"abc     "
    elif case.broken == "bad_size":
        blob[184:192] = b"1024    "
    path.write_bytes(bytes(blob))


def write_case(case: Case, folder: Path) -> tuple[Path, list[Path], Path]:
    """Write one case into folder; returns (the file to open, all its files, the data file)."""
    folder.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(int(hashlib.sha256(case.id.encode()).hexdigest()[:8], 16))
    data = signals_for(case, rng)
    path = folder / f"{case.stem}{case.extension}"
    if case.fmt == "bv":
        _write_bv_case(case, path, data)
        files = [path, path.with_suffix(".vmrk"), path.with_suffix(".eeg")]
        return path, files, path.with_suffix(".eeg")
    _write_edf_case(case, path, data, rng)
    if case.broken:
        _break_edf(case, path)
    return path, [path], path


# ----------------------------------------------------------------------------- the set
def make_matrix(out: Path, *, expected: bool = True) -> dict[str, dict]:
    """Write every case into out/<id>/ and, with ``expected``, what MNE reads from each into
    out/../<id>.expected.json (the layout of make_web_fixtures). Returns the fixture index."""
    import shutil

    from make_web_fixtures import describe, read_raw

    if out.exists():
        shutil.rmtree(out)
    index: dict[str, dict] = {}
    for case in CASES:
        folder = out / case.id
        path, files, data_file = write_case(case, folder)
        name = f"matrix_{case.id}"
        entry = {"files": [p.name for p in files], "format": {"bv": "brainvision"}.get(case.fmt, case.fmt),
                 "folder": f"{out.name}/{case.id}", "error": None, "what": case.what,
                 "n_channels": case.n_channels, "sfreq": case.sfreq}
        if case.slow:
            entry["lower_rate"] = sorted(case.slow)
        if case.broken:
            entry["error"] = case.error or case.broken
            index[name] = entry
            continue
        if expected:
            try:
                raw = read_raw(path, entry["format"])
            except Exception as exc:  # noqa: BLE001 - MNE itself cannot read it: say so in the index
                entry["mne_error"] = f"{type(exc).__name__}: {exc}"
                index[name] = entry
                continue
            n = int(raw.n_times)
            # slower signals: windows long enough to show their range; many channels: shorter windows
            w = min(n, 512 if case.slow else 32 if case.n_channels >= 128 else 64)
            mid = max(0, n // 2 - w // 2)
            rng = np.random.default_rng(len(case.id))
            idx = sorted({0, n - 1, min(1, n - 1), max(0, n - 2), *map(int, rng.integers(0, n, 8))})
            fw = min(n, 96)
            fwin = sorted({(0, fw), (n - fw, n)})  # the filters' edges, where they differ most
            info = describe(raw, entry["format"], data_file, files, filters=case.filters,
                            windows=[(0, w), (mid, mid + w), (n - w, n)], sample_idx=idx,
                            filter_windows=fwin, amplitude_filters=AMP if case.amplitude else None)
            (out.parent / f"{name}.expected.json").write_text(json.dumps(info), encoding="utf-8")
        index[name] = entry
    return index


#: What the browser and Python say when they refuse the broken cases (checked by the tests).
REFUSALS = {
    "r_empty": "is too short to hold an EDF header",
    "r_header_only": "the file contains a header but no data",
    "r_no_signals": "does not match 0 signal(s)",
    "r_bad_field": "has an unreadable header field: invalid literal for int() with base 10: 'abc'",
    "r_bad_size": "does not match 2 signal(s)",
    "r_bv_empty": "does not give SamplingInterval",
    "r_bv_no_channels": "could not be read as a BrainVision recording: No section: 'Channel Infos'",
    "e_dup_bv": "MNE-Python, which ElectroTag uses to read recordings, cannot read a BrainVision recording whose "
                "channels share a name",
}
for _c in CASES:
    if _c.broken:
        _c.error = REFUSALS.get(_c.id) or None


# ----------------------------------------------------------------------------- one large file
def write_big_bdf(path: Path, *, n_channels: int, sfreq: int, minutes: float) -> dict:
    """A BioSemi-like BDF of n_channels (A1 ...) plus Status, written one data record at a time so
    that it never needs more memory than one second of data; returns its size and SHA-256."""
    from make_web_fixtures import _field, _num

    n_rec = int(round(minutes * 60))
    labels = biosemi(n_channels) + ["Status"]
    ns = len(labels)
    head = b"\xffBIOSEMI" + _field("X X X X", 80) + _field("Startdate 01-JAN-2024 X X X", 80)
    head += _field("01.01.24", 8) + _field("12.00.00", 8) + _num(256 * (ns + 1)) + _field("24BIT", 44)
    head += _num(n_rec) + _num(1) + _num(ns, 4)
    head += b"".join(_field(lab, 16) for lab in labels) + b"".join(_field("", 80) for _ in labels)
    head += b"".join(_field("uV" if lab != "Status" else "Boolean", 8) for lab in labels)
    for vals in ((-262144, -8388608), (262143, 8388607), (-8388608, -8388608), (8388607, 8388607)):
        head += b"".join(_num(vals[0] if lab != "Status" else vals[1]) for lab in labels)
    head += b"".join(_field("", 80) for _ in labels) + b"".join(_num(sfreq) for _ in labels)
    head += b"".join(_field("", 32) for _ in labels)
    rng = np.random.default_rng(256)
    sha = hashlib.sha256()
    offsets = rng.integers(-200000, 200000, size=(n_channels, 1))
    t = np.arange(sfreq) / sfreq
    with open(path, "wb") as fh:
        fh.write(head)
        sha.update(head)
        for r in range(n_rec):
            alpha = (np.sin(2 * np.pi * 10 * (t + r)) * 800).astype(np.int64)
            block = offsets + rng.integers(-1500, 1500, size=(n_channels, sfreq)) + alpha[None, :]
            status = np.zeros(sfreq, dtype=np.int64)
            status[100:120] = 1 + r % 250
            status |= 1 << 20
            allc = np.vstack([block, status[None, :]]).astype("<i4")
            raw = allc.view(np.uint8).reshape(ns, sfreq, 4)[:, :, :3].tobytes()
            fh.write(raw)
            sha.update(raw)
    return {"file": str(path), "sha256": sha.hexdigest(), "size_bytes": path.stat().st_size, "n_channels": ns,
            "sfreq": float(sfreq), "n_samples": n_rec * sfreq, "n_events": n_rec}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", type=Path, help="folder for the recordings (and their .expected.json beside it)")
    ap.add_argument("--no-expected", action="store_true", help="write the recordings only")
    ap.add_argument("--list", action="store_true", help="list the cases")
    ap.add_argument("--big", type=Path, help="write one large BDF to this path")
    ap.add_argument("--channels", type=int, default=256)
    ap.add_argument("--sfreq", type=int, default=2048)
    ap.add_argument("--minutes", type=float, default=20.0)
    args = ap.parse_args(argv)
    if args.list:
        for c in CASES:
            print(f"{c.id:17} {c.fmt:4} {c.n_channels:4} signals ({c.n_eeg:3} EEG) {c.sfreq:5g} Hz "
                  f"{c.duration_s:6g} s  {c.what}")
        return 0
    if args.big:
        print(json.dumps(write_big_bdf(args.big, n_channels=args.channels, sfreq=args.sfreq, minutes=args.minutes)))
        return 0
    if not args.out:
        ap.error("give --out, --list or --big")
    index = make_matrix(args.out, expected=not args.no_expected)
    (args.out / "index.json").write_text(json.dumps(index, indent=1), encoding="utf-8")
    total = sum(p.stat().st_size for p in args.out.rglob("*") if p.is_file())
    print(f"Wrote {len(index)} recordings ({total / 1e6:.1f} MB) to {args.out} at {datetime.now():%H:%M:%S}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
