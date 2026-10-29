"""Synthetic BIDS/BrainVision EEG with known artifacts, for tests and demos.

:func:`make_synthetic_dataset` writes a small BIDS-style dataset of
BrainVision recordings containing realistic-looking artifacts at known
positions, together with the ground-truth annotations in ElectroTag's
canonical format (under ``derivatives/ground_truth``, which recording
discovery ignores). :func:`simulate_rater` derives plausible annotations from a
ground truth by adding boundary jitter, misses, false alarms and label
confusions, which is useful for demonstrating the reliability analysis.

Writing BrainVision files requires the ``pybv`` package (a development
dependency). :func:`write_edf` and :func:`write_edf_recording` write EDF,
EDF+ and BDF files without any extra package; they exist so that the tests
can cover these formats, including broken files.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from electrotag import __version__
from electrotag.app.annotations.labels import LabelCatalogue, default_catalogue
from electrotag.app.annotations.model import AnnotationDocument, ArtifactAnnotation, RecordingInfo
from electrotag.app.annotations.timing import RecordingTiming
from electrotag.app.common import new_annotation_id, now_local_iso
from electrotag.app.io.canonical import write_annotations_json

EEG_CHANNELS = [
    "Fp1", "Fp2", "F7", "F3", "Fz", "F4", "F8", "T7", "C3", "Cz",
    "C4", "T8", "P7", "P3", "Pz", "P4", "P8", "O1", "O2",
]  # fmt: skip
EOG_CHANNELS = ["HEOG", "VEOG"]
ECG_CHANNELS = ["ECG"]
ALL_CHANNELS = EEG_CHANNELS + EOG_CHANNELS + ECG_CHANNELS


@dataclass(frozen=True)
class SyntheticArtifact:
    label: str
    start_s: float
    duration_s: float
    channels: tuple[str, ...]  # () = whole montage


def default_artifact_plan(duration_s: float, rng: np.random.Generator) -> list[SyntheticArtifact]:
    """A varied set of artifacts, including overlaps and repeated categories."""
    plan = [
        SyntheticArtifact("Eye-blink-artifact", 3.0, 0.40, ("Fp1", "Fp2", "VEOG")),
        SyntheticArtifact("Eye-blink-artifact", 9.5, 0.36, ("Fp1", "Fp2", "VEOG")),
        SyntheticArtifact("EMG-artifact", 9.2, 1.60, ("T7", "T8", "F7", "F8")),  # overlaps a blink
        SyntheticArtifact("Electrode-pops-artifact", 14.0, 0.50, ("C3",)),
        SyntheticArtifact("Horizontal-eye-movement-artifact", 18.0, 1.20, ("F7", "F8", "HEOG")),
        SyntheticArtifact("Movement-artifact", 24.0, 2.00, ()),
        SyntheticArtifact("Chewing-artifact", 30.0, 3.00, ("T7", "T8")),
        SyntheticArtifact("Eye-blink-artifact", 35.2, 0.38, ("Fp1", "Fp2", "VEOG")),
        SyntheticArtifact("Slow-eye-movement-artifact", 40.0, 4.00, ("F7", "F8", "HEOG")),
        SyntheticArtifact("ECG-artifact", 47.0, 5.00, ("T7", "P7", "O1")),
        SyntheticArtifact("Electrode-pops-artifact", 53.5, 0.40, ("O2",)),
    ]
    plan = [a for a in plan if a.start_s + a.duration_s < duration_s - 0.5]
    # Extra blinks scattered through longer recordings.
    t = 60.0
    while t < duration_s - 2:
        plan.append(SyntheticArtifact("Eye-blink-artifact", t + float(rng.uniform(0, 3)), 0.38, ("Fp1", "Fp2", "VEOG")))
        t += 7.0
    return sorted(plan, key=lambda a: a.start_s)


def _pink_noise(rng: np.random.Generator, n_ch: int, n: int) -> np.ndarray:
    white = rng.standard_normal((n_ch, n))
    spec = np.fft.rfft(white, axis=1)
    f = np.arange(spec.shape[1], dtype=float)
    f[0] = 1.0
    spec /= np.sqrt(f)
    pink = np.fft.irfft(spec, n=n, axis=1)
    pink /= pink.std(axis=1, keepdims=True)
    return pink


def _bandlimited_noise(rng: np.random.Generator, n: int, sfreq: float, lo: float, hi: float) -> np.ndarray:
    spec = np.fft.rfft(rng.standard_normal(n))
    freqs = np.fft.rfftfreq(n, 1 / sfreq)
    spec[(freqs < lo) | (freqs > hi)] = 0
    x = np.fft.irfft(spec, n=n)
    return x / (x.std() + 1e-12)


def synthesise_signal(
    plan: list[SyntheticArtifact],
    sfreq: float,
    duration_s: float,
    line_freq: float,
    rng: np.random.Generator,
) -> np.ndarray:
    """Return data in volts, shape (n_channels, n_times)."""
    n = int(round(duration_s * sfreq))
    t = np.arange(n) / sfreq
    idx = {c: i for i, c in enumerate(ALL_CHANNELS)}
    uv = 1e-6
    data = 8 * uv * _pink_noise(rng, len(ALL_CHANNELS), n)
    alpha = np.sin(2 * np.pi * 10.0 * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 0.1 * t))
    for ch, gain in (("O1", 10), ("O2", 10), ("P3", 6), ("P4", 6), ("Pz", 6), ("P7", 4), ("P8", 4)):
        data[idx[ch]] += gain * uv * alpha
    data += 4 * uv * np.sin(2 * np.pi * line_freq * t + rng.uniform(0, np.pi, (len(ALL_CHANNELS), 1)))
    data[idx["VEOG"]] += 15 * uv * _pink_noise(rng, 1, n)[0]
    data[idx["HEOG"]] += 15 * uv * _pink_noise(rng, 1, n)[0]
    # The ECG channel shows the heartbeat throughout (about 69 beats per minute).
    period = sfreq / 1.15
    width = max(2, int(0.04 * sfreq))
    qrs = np.hanning(width)
    k = float(rng.uniform(0, period))
    while k < n - width:
        b = int(k)
        data[idx["ECG"], b : b + width] += 800 * uv * qrs
        k += period

    for art in plan:
        s0 = int(round(art.start_s * sfreq))
        m = int(round(art.duration_s * sfreq))
        seg = slice(s0, s0 + m)
        tt = np.arange(m) / sfreq
        chans = list(art.channels) if art.channels else ALL_CHANNELS
        if art.label == "Eye-blink-artifact":
            bump = np.exp(-0.5 * ((tt - art.duration_s / 2) / (art.duration_s / 6)) ** 2)
            for ch, gain in (("Fp1", 150), ("Fp2", 150), ("VEOG", 250), ("F3", 40), ("F4", 40), ("Fz", 45)):
                data[idx[ch], seg] += gain * uv * bump
        elif art.label == "EMG-artifact" or art.label == "Chewing-artifact":
            burst = _bandlimited_noise(rng, m, sfreq, 20.0, min(100.0, sfreq / 2 - 5))
            env = np.ones(m)
            if art.label == "Chewing-artifact":
                env = (np.sin(2 * np.pi * 1.5 * tt) > 0).astype(float)
            ramp = np.minimum(1.0, np.minimum(tt, art.duration_s - tt) / 0.05)
            for ch in chans:
                data[idx[ch], seg] += 35 * uv * burst * env * ramp
        elif art.label == "Electrode-pops-artifact":
            pop = np.exp(-tt / 0.08)
            pop[: max(1, int(0.005 * sfreq))] = 1.0
            for ch in chans:
                data[idx[ch], seg] += 300 * uv * pop
        elif art.label in ("Horizontal-eye-movement-artifact", "Slow-eye-movement-artifact"):
            if art.label == "Horizontal-eye-movement-artifact":
                shape = np.clip(np.minimum(tt, art.duration_s - tt) / 0.08, 0, 1)
            else:
                shape = np.sin(np.pi * tt / art.duration_s) * np.sin(2 * np.pi * 0.35 * tt)
            data[idx["F7"], seg] += 80 * uv * shape
            data[idx["F8"], seg] -= 80 * uv * shape
            data[idx["HEOG"], seg] += 200 * uv * shape
        elif art.label == "Movement-artifact":
            drift = np.sin(np.pi * tt / art.duration_s)
            for ch in ALL_CHANNELS:
                data[idx[ch], seg] += uv * (120 * drift * rng.uniform(0.5, 1.5) + 40 * rng.standard_normal(m))
        elif art.label == "ECG-artifact":
            beat = np.zeros(m)
            period = sfreq / 1.15
            k = 0.0
            while k < m:
                b = int(k)
                width = max(2, int(0.02 * sfreq))
                beat[b : b + width] += np.hanning(width)[: max(0, min(width, m - b))]
                k += period
            for ch in chans:
                data[idx[ch], seg] += 25 * uv * beat
        else:
            for ch in chans:
                data[idx[ch], seg] += 50 * uv * rng.standard_normal(m)
    return data


def _write_tsv(path: Path, columns: list[str], rows: list[list[str]]) -> None:
    lines = ["\t".join(columns)] + ["\t".join(r) for r in rows]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")


def _lf_line_endings(path: Path) -> None:
    """Give a text file written by another library the line endings of every file written here.

    Every text file of a synthetic recording ends its lines with LF on every system, so that the
    same recording is the same bytes on Windows, macOS and Linux (the example training set's kept
    registrations are checked against them byte for byte)."""
    data = path.read_bytes()
    if b"\r\n" in data:
        path.write_bytes(data.replace(b"\r\n", b"\n"))


def _append_new_segment(vmrk: Path, sample0: int) -> None:
    """Add a BrainVision 'New Segment' marker (1-based position) to a marker file."""
    lines = vmrk.read_text(encoding="utf-8").splitlines()
    numbers = [int(ln.split("=")[0][2:]) for ln in lines if ln.startswith("Mk") and "=" in ln]
    nxt = (max(numbers) + 1) if numbers else 1
    lines.append(f"Mk{nxt}=New Segment,,{sample0 + 1},1,0,20240101120000000000")
    vmrk.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")


def write_recording(
    folder: Path,
    stem: str,
    *,
    sfreq: float,
    duration_s: float,
    seed: int,
    line_freq: float = 50.0,
    event_values: tuple[int, ...] = (1, 2),
    collision: bool = False,
    discontinuity_s: float | None = None,
    write_bids_sidecars: bool = True,
    plan: list[SyntheticArtifact] | None = None,
) -> tuple[Path, list[SyntheticArtifact], RecordingTiming]:
    """Write one ``<stem>_eeg`` BrainVision recording and its BIDS sidecars."""
    import pybv

    rng = np.random.default_rng(seed)
    folder.mkdir(parents=True, exist_ok=True)
    plan = plan if plan is not None else default_artifact_plan(duration_s, rng)
    data = synthesise_signal(plan, sfreq, duration_s, line_freq, rng)
    n = data.shape[1]
    # Experimental markers: alternating stimuli every 4 s, responses 600 ms later.
    events = []
    rows = []
    for k, onset in enumerate(np.arange(2.0, duration_s - 1.0, 4.0)):
        value = event_values[k % len(event_values)]
        s = int(round(onset * sfreq))
        events.append({"onset": s, "duration": 1, "description": int(value), "type": "Stimulus"})
        rows.append([repr(s / sfreq), repr(1 / sfreq), f"stimulus/{value}", str(value), str(s)])
        r = s + int(round(0.6 * sfreq))
        if r < n:
            events.append({"onset": r, "duration": 1, "description": 1, "type": "Response"})
            rows.append([repr(r / sfreq), repr(1 / sfreq), "response", "1001", str(r)])
    if collision:
        s = int(round(5.5 * sfreq))
        events.append({"onset": s, "duration": 1, "description": 101, "type": "Stimulus"})
        rows.append([repr(s / sfreq), repr(1 / sfreq), "stimulus/101", "101", str(s)])
    rows.sort(key=lambda r: int(r[4]))
    fname_base = f"{stem}_eeg"
    pybv.write_brainvision(
        data=data,
        sfreq=sfreq,
        ch_names=ALL_CHANNELS,
        fname_base=fname_base,
        folder_out=str(folder),
        events=events,
        unit="µV",
        meas_date=datetime(2024, 1, 1, 12, 0, 0, tzinfo=timezone.utc),
        overwrite=True,
    )
    for ext in (".vhdr", ".vmrk"):
        _lf_line_endings(folder / f"{fname_base}{ext}")
    if discontinuity_s is not None:
        _append_new_segment(folder / f"{fname_base}.vmrk", int(round(discontinuity_s * sfreq)))
    if write_bids_sidecars:
        _write_tsv(
            folder / f"{stem}_events.tsv",
            ["onset", "duration", "trial_type", "value", "sample"],
            rows,
        )
        (folder / f"{stem}_events.json").write_text(
            json.dumps(
                {
                    "trial_type": {
                        "Description": "Experimental event type",
                        "Levels": {"stimulus/1": "Standard stimulus", "stimulus/2": "Target stimulus", "response": "Button press"},
                    },
                    "value": {"Description": "Marker code written by the recording system"},
                },
                indent=2,
            ),
            encoding="utf-8", newline="\n",
        )
        _write_tsv(
            folder / f"{stem}_channels.tsv",
            ["name", "type", "units", "status"],
            [[c, "EEG", "µV", "good"] for c in EEG_CHANNELS]
            + [["HEOG", "HEOG", "µV", "good"], ["VEOG", "VEOG", "µV", "good"], ["ECG", "ECG", "µV", "good"]],
        )
        (folder / f"{stem}_eeg.json").write_text(
            json.dumps(
                {
                    "TaskName": stem.split("task-")[-1].split("_")[0] if "task-" in stem else "rest",
                    "SamplingFrequency": sfreq,
                    "PowerLineFrequency": line_freq,
                    "EEGChannelCount": len(EEG_CHANNELS),
                    "EOGChannelCount": len(EOG_CHANNELS),
                    "ECGChannelCount": len(ECG_CHANNELS),
                    "EEGReference": "average (synthetic)",
                    "SoftwareFilters": "n/a",
                    "RecordingDuration": duration_s,
                },
                indent=2,
            ),
            encoding="utf-8", newline="\n",
        )
    timing = RecordingTiming(sfreq=float(sfreq), n_samples=n, first_samp=0)
    return folder / f"{fname_base}.vhdr", plan, timing


def _ascii(value: str, width: int) -> bytes:
    raw = value.encode("ascii")
    if len(raw) > width:
        raise ValueError(f"EDF header field {value!r} is longer than {width} characters")
    return raw.ljust(width, b" ")


def _num(value: float, width: int) -> bytes:
    text = f"{value:g}" if isinstance(value, float) else str(value)
    if len(text) > width:
        text = f"{value:.{max(width - 6, 1)}g}"
    return _ascii(text, width)


def write_edf(
    path: Path,
    data_v: np.ndarray,
    sfreq: float,
    ch_names: list[str],
    *,
    annotations: list[tuple[float, float, str]] | None = None,
    bdf: bool = False,
    record_duration_s: float = 1.0,
    n_records_in_header: int | None = None,
    meas_date: datetime = datetime(2024, 1, 1, 12, 0, 0),
    triggers: dict[str, np.ndarray] | None = None,
) -> Path:
    """Write ``data_v`` (channels x samples, in volts) as an EDF or BDF file.

    With ``annotations`` (onset s, duration s, text) the file is EDF+C (BDF+C)
    and holds an annotation signal. The data are padded with zeros to whole
    data records; like MNE's own EDF export, the padding is then marked with a
    ``BAD_ACQ_SKIP`` annotation. ``n_records_in_header`` overrides the number
    of records written in the header (``-1`` means unknown), to imitate
    broken files. ``triggers`` maps names of trigger channels (for example
    ``Status``) to integer codes per sample; as in BioSemi files, their
    physical range equals their digital range, so the codes are stored exactly.
    """
    spr = int(round(sfreq * record_duration_s))
    if abs(spr - sfreq * record_duration_s) > 1e-9:
        raise ValueError("sfreq * record_duration_s must be a whole number of samples")
    n_ch, n = data_v.shape
    n_records = -(-n // spr)
    pad = n_records * spr - n
    plus = annotations is not None
    tals = list(annotations or [])
    if plus and pad:
        tals.append((n / sfreq, pad / sfreq, "BAD_ACQ_SKIP"))
    bytes_per = 3 if bdf else 2
    dmax = 8388607 if bdf else 32767
    dmin = -dmax - 1
    data_uv = np.zeros((n_ch, n_records * spr))
    data_uv[:, :n] = data_v * 1e6
    phys_max = np.maximum(np.abs(data_uv).max(axis=1), 1.0) * 1.01
    phys_min = -phys_max
    digital = np.round((data_uv - phys_min[:, None]) / (phys_max - phys_min)[:, None] * (dmax - dmin) + dmin)
    digital = np.clip(digital, dmin, dmax).astype(np.int64)
    units = ["uV"] * n_ch
    if triggers:
        codes = np.zeros((len(triggers), n_records * spr), dtype=np.int64)
        for i, values in enumerate(triggers.values()):
            codes[i, :n] = np.asarray(values, dtype=np.int64)[:n]
        digital = np.vstack([digital, np.clip(codes, dmin, dmax)])
        phys_min = np.concatenate([phys_min, np.full(len(triggers), float(dmin))])
        phys_max = np.concatenate([phys_max, np.full(len(triggers), float(dmax))])
        ch_names = list(ch_names) + list(triggers)
        units += ["Boolean"] * len(triggers)
        n_ch += len(triggers)

    # One TAL block per record: the time-keeping TAL, then the annotations starting in that record.
    per_record: list[bytes] = []
    if plus:
        for r in range(n_records):
            t0 = r * record_duration_s
            block = f"+{t0:g}\x14\x14\x00".encode("utf-8")
            for onset, duration, text in tals:
                if t0 <= onset < t0 + record_duration_s or (r == n_records - 1 and onset >= t0 + record_duration_s):
                    block += f"+{onset:.6f}\x15{duration:.6f}\x14{text}\x14\x00".encode("utf-8")
            per_record.append(block)
        ann_samples = -(-max(len(b) for b in per_record) // bytes_per) + 1
    labels = list(ch_names) + (["BDF Annotations" if bdf else "EDF Annotations"] if plus else [])
    ns = len(labels)
    samples = [spr] * n_ch + ([ann_samples] if plus else [])
    family = "BDF" if bdf else "EDF"
    reserved = f"{family}+C" if plus else ("24BIT" if bdf else "")
    header = b"\xffBIOSEMI" if bdf else _ascii("0", 8)
    header += _ascii("X X X X", 80)
    header += _ascii(f"Startdate {meas_date.strftime('%d-%b-%Y').upper()} X X X", 80)
    header += _ascii(meas_date.strftime("%d.%m.%y"), 8) + _ascii(meas_date.strftime("%H.%M.%S"), 8)
    header += _num(256 * (ns + 1), 8) + _ascii(reserved, 44)
    header += _num(n_records if n_records_in_header is None else n_records_in_header, 8)
    header += _num(float(record_duration_s), 8) + _num(ns, 4)
    header += b"".join(_ascii(lab, 16) for lab in labels)
    header += b"".join(_ascii("", 80) for _ in labels)
    header += b"".join(_ascii(u, 8) for u in units) + (_ascii("", 8) if plus else b"")
    header += b"".join(_num(round(float(v), 3), 8) for v in phys_min) + (_num(-1, 8) if plus else b"")
    header += b"".join(_num(round(float(v), 3), 8) for v in phys_max) + (_num(1, 8) if plus else b"")
    header += b"".join(_num(dmin, 8) for _ in labels)
    header += b"".join(_num(dmax, 8) for _ in labels)
    header += b"".join(_ascii("", 80) for _ in labels)
    header += b"".join(_num(k, 8) for k in samples)
    header += b"".join(_ascii("", 32) for _ in labels)
    assert len(header) == 256 * (ns + 1)

    def encode(values: np.ndarray) -> bytes:
        if bdf:
            v = values.astype("<i4").view(np.uint8).reshape(-1, 4)[:, :3]
            return v.tobytes()
        return values.astype("<i2").tobytes()

    body = bytearray()
    for r in range(n_records):
        for c in range(n_ch):
            body += encode(digital[c, r * spr : (r + 1) * spr])
        if plus:
            body += per_record[r].ljust(ann_samples * bytes_per, b"\x00")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(header + bytes(body))
    return path


def write_edf_recording(
    folder: Path,
    stem: str,
    *,
    sfreq: float = 128.0,
    duration_s: float = 40.5,
    seed: int = 0,
    line_freq: float = 50.0,
    housekeeping_channels: tuple[str, ...] = ("COUNTER", "INTERPOLATED", "CQ_Fp1", "CQ_Fp2", "BATTERY"),
    events_in_file: bool = True,
    write_bids_sidecars: bool = True,
    bdf: bool = False,
    all_channels_typed_eeg: bool = True,
    plan: list[SyntheticArtifact] | None = None,
) -> tuple[Path, list[SyntheticArtifact], RecordingTiming]:
    """Write one ``<stem>_eeg.edf`` (or ``.bdf``) recording like a consumer headset export.

    Besides the EEG, EOG and ECG channels the file holds ``housekeeping_channels``
    (a sample counter, contact-quality values and so on), and its channels.tsv
    types every channel as EEG, as some converters do. With ``events_in_file``
    the stimulus markers are EDF+ annotations; otherwise they are only in the
    events.tsv, whose ``sample`` column holds stimulus-software timestamps.
    """
    rng = np.random.default_rng(seed)
    plan = plan if plan is not None else default_artifact_plan(duration_s, rng)
    signal = synthesise_signal(plan, sfreq, duration_s, line_freq, rng)
    n = signal.shape[1]
    extra = []
    for name in housekeeping_channels:
        if name == "COUNTER":
            extra.append((np.arange(n) % 128) * 1e-6)
        elif name.startswith("CQ_"):
            extra.append(np.full(n, 4e-6))
        else:
            extra.append(np.full(n, 1e-6))
    data = np.vstack([signal] + ([np.vstack(extra)] if extra else []))
    names = list(ALL_CHANNELS) + list(housekeeping_channels)
    onsets = [float(t) for t in np.arange(2.0, duration_s - 1.0, 4.0)]
    anns = [(t, 0.0, f"stim/{1 + k % 2}") for k, t in enumerate(onsets)] if events_in_file else None
    ext = ".bdf" if bdf else ".edf"
    path = write_edf(folder / f"{stem}_eeg{ext}", data, sfreq, names, annotations=anns, bdf=bdf)
    if write_bids_sidecars:
        rows = [[repr(t), "0.0", f"stim/{1 + k % 2}", str(10 * (1 + k % 2)), f"2026-01-01_12:00:{t:09.6f}"]
                for k, t in enumerate(onsets)]
        _write_tsv(folder / f"{stem}_events.tsv", ["onset", "duration", "trial_type", "trigger_code", "sample"], rows)
        (folder / f"{stem}_events.json").write_text(
            json.dumps(
                {"trigger_code": {"Description": "Trigger code"},
                 "sample": {"Description": "Stimulus software timestamp."}},
                indent=2,
            ),
            encoding="utf-8", newline="\n",
        )
        types = {c: "EEG" for c in names} if all_channels_typed_eeg else {
            **{c: "EEG" for c in EEG_CHANNELS}, "HEOG": "HEOG", "VEOG": "VEOG", "ECG": "ECG",
            **{c: "MISC" for c in housekeeping_channels}}
        _write_tsv(folder / f"{stem}_channels.tsv", ["name", "type", "units", "status"],
                   [[c, types[c], "µV", "good"] for c in names])
        (folder / f"{stem}_eeg.json").write_text(
            json.dumps({"TaskName": "rest", "SamplingFrequency": sfreq, "PowerLineFrequency": line_freq,
                        "RecordingDuration": duration_s}, indent=2),
            encoding="utf-8", newline="\n",
        )
    spr = int(round(sfreq))  # one-second data records; the last one is padded
    return path, plan, RecordingTiming(sfreq=float(sfreq), n_samples=-(-n // spr) * spr, first_samp=0)


def truth_document(
    recording_id: str,
    plan: list[SyntheticArtifact],
    timing: RecordingTiming,
    catalogue: LabelCatalogue | None = None,
    annotator_id: str = "TRUTH",
) -> AnnotationDocument:
    cat = catalogue or default_catalogue()
    anns = []
    stamp = now_local_iso()
    for art in plan:
        s0 = timing.time_to_sample(art.start_s)
        m = timing.duration_to_samples(art.duration_s)
        anns.append(
            ArtifactAnnotation(
                annotation_id=new_annotation_id(),
                label=art.label,
                onset_sample=s0,
                duration_samples=m,
                channels=tuple(c for c in ALL_CHANNELS if c in art.channels),
                created_at=stamp,
                modified_at=stamp,
            )
        )
    rec = RecordingInfo(recording_id=recording_id, timing=timing, ch_names=tuple(ALL_CHANNELS), relative_path=recording_id)
    return AnnotationDocument(
        recording=rec,
        annotator_id=annotator_id,
        annotator_display_name="Synthetic ground truth",
        annotations=anns,
        catalogue=cat,
        session_id="synthetic",
        mode="standard",
        created_at=stamp,
        app_version=__version__,
        context={"source": "electrotag.synthetic ground truth"},
    )


def make_synthetic_dataset(
    root: Path | str,
    *,
    n_subjects: int = 2,
    sfreq: float = 250.0,
    duration_s: float = 60.0,
    seed: int = 0,
    line_freq: float = 50.0,
    with_collision_recording: bool = False,
    with_duplicate_names: bool = False,
    with_discontinuity: bool = False,
) -> dict[str, AnnotationDocument]:
    """Create a dataset and return ground truth keyed by recording ID."""
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    (root / "dataset_description.json").write_text(
        json.dumps(
            {
                "Name": "ElectroTag synthetic EEG",
                "BIDSVersion": "1.10.0",
                "DatasetType": "raw",
                "HEDVersion": ["8.5.0", "sc:score_2.2.0"],
                "GeneratedBy": [{"Name": "ElectroTag synthetic data generator", "Version": __version__}],
            },
            indent=2,
        ),
        encoding="utf-8", newline="\n",
    )
    truths: dict[str, AnnotationDocument] = {}
    specs = []
    for k in range(1, n_subjects + 1):
        sub = f"sub-{k:03d}"
        specs.append((root / sub / "eeg", f"{sub}_task-rest", {}))
    if with_discontinuity:
        specs.append((root / "sub-090" / "eeg", "sub-090_task-rest", {"discontinuity_s": duration_s / 2}))
    if with_collision_recording:
        specs.append((root / "sub-099" / "eeg", "sub-099_task-oddball", {"collision": True}))
    for i, (folder, stem, extra) in enumerate(specs):
        vhdr, plan, timing = write_recording(
            folder, stem, sfreq=sfreq, duration_s=duration_s, seed=seed + i, line_freq=line_freq, **extra
        )
        rid = vhdr.relative_to(root).as_posix()
        truths[rid] = truth_document(rid, plan, timing)
    if with_duplicate_names:
        for site, s in (("siteA", 100), ("siteB", 200)):
            folder = root / "sourcedata_copies" / site
            vhdr, plan, timing = write_recording(
                folder, "recording", sfreq=sfreq, duration_s=duration_s, seed=seed + s, line_freq=line_freq,
                write_bids_sidecars=False,
            )
            rid = vhdr.relative_to(root).as_posix()
            truths[rid] = truth_document(rid, plan, timing)
    gt_dir = root / "derivatives" / "ground_truth"
    for rid, doc in truths.items():
        out = gt_dir / (Path(rid).name.replace(".vhdr", "") + "_annotator-TRUTH_annotations.json")
        if out.exists():
            out = gt_dir / (rid.replace("/", "__").replace(".vhdr", "") + "_annotator-TRUTH_annotations.json")
        write_annotations_json(out, doc, overwrite=True)
    return truths


def simulate_rater(
    truth: AnnotationDocument,
    annotator_id: str,
    *,
    seed: int = 0,
    boundary_jitter_s: float = 0.08,
    miss_probability: float = 0.1,
    false_alarms: int = 1,
    confusion: dict[str, str] | None = None,
    confusion_probability: float = 0.0,
    channel_drop_probability: float = 0.1,
) -> AnnotationDocument:
    """Imitate an annotator by perturbing a ground-truth document."""
    rng = np.random.default_rng(seed)
    timing = truth.recording.timing
    ch_names = truth.recording.ch_names
    out = []
    stamp = now_local_iso()
    for ann in truth.annotations:
        if rng.random() < miss_probability:
            continue
        j0 = timing.duration_to_samples(float(rng.normal(0, boundary_jitter_s)))
        j1 = timing.duration_to_samples(float(rng.normal(0, boundary_jitter_s)))
        start = int(np.clip(ann.onset_sample + j0, 0, timing.n_samples - 2))
        stop = int(np.clip(ann.end_sample + j1, start + 1, timing.n_samples))
        label = ann.label
        if confusion and label in confusion and rng.random() < confusion_probability:
            label = confusion[label]
        chans = tuple(c for c in ann.channels if rng.random() >= channel_drop_probability) if ann.channels else ()
        if ann.channels and not chans:
            chans = ann.channels[:1]
        out.append(
            ArtifactAnnotation(new_annotation_id(), label, start, stop - start, chans, stamp, stamp)
        )
    labels = truth.catalogue.label_names
    for _ in range(false_alarms):
        dur = timing.duration_to_samples(float(rng.uniform(0.2, 1.0)))
        start = int(rng.integers(0, max(1, timing.n_samples - dur)))
        chans = tuple(sorted(rng.choice(ch_names, size=2, replace=False), key=ch_names.index))
        out.append(
            ArtifactAnnotation(
                new_annotation_id(), str(labels[int(rng.integers(0, len(labels)))]), start, dur, chans, stamp, stamp
            )
        )
    return AnnotationDocument(
        recording=truth.recording,
        annotator_id=annotator_id,
        annotator_display_name=f"Simulated rater {annotator_id}",
        annotations=out,
        catalogue=truth.catalogue,
        session_id=f"simulated-{annotator_id}",
        mode="standard",
        created_at=stamp,
        app_version=__version__,
        context={"source": "electrotag.synthetic.simulate_rater", "seed": seed},
    )
