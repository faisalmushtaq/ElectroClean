"""Register datasets with the desktop application's loader, for the browser's unit tests.

    python -I web_tests/register_parity.py < jobs.json

Each job is {"root": "<dataset folder>", "settings": {block: {key: value}}, "scope": "study"}: the
dataset is registered as ``electrotag-web register`` registers it (discovery as
``electrotag.web.registration.collect``, every recording opened with
``electrotag.app.eeg.loading.load_recording`` and described by
``electrotag.web.manifest.build_manifest``), with the study settings made from the defaults
and the job's blocks, and the default label catalogue. The answer gives, per job, the manifests
and the recordings that could not be registered with the reason, so that
web_tests/unit/data_register.test.mjs can compare js/eeg/register.js with them field by field.

Run it with ``-I`` (the folders are test data, never imported from) and the repository's Python.

    python -I web_tests/register_parity.py --python-text < cases.json

answers how Python writes and reads the values that js/eeg/pyfmt.js and pyjson.js imitate
(repr of floats, format specifications, repr of strings, the JSON errors that
``electrotag.app.io.bids.loads_json`` reports for a sidecar, UTF-8 errors, the desktop's
parse_float and parse_int_code, timedelta's rounding), for web_tests/unit/data_register_py.test.mjs.

    python -I web_tests/register_parity.py --describe < paths.json

answers what MNE-Python reads from recordings anywhere on disk, for the opt-in check of real
recordings (ELECTROTAG_REAL_EEG) in web_tests/unit/data_readers.test.mjs.

    python -I web_tests/register_parity.py --check < manifests.json

passes manifests built in the browser through the study server's own checks
(``electrotag.web.manifest_check``, what ``recordings_register`` runs before storing one).
"""

from __future__ import annotations

import json
import sys
import warnings
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from electrotag.app.annotations.labels import default_catalogue  # noqa: E402
from electrotag.web.manifest import SCOPE_STUDY  # noqa: E402
from electrotag.web.registration import collect  # noqa: E402
from electrotag.web.store import settings_from_overrides  # noqa: E402


def register(job: dict) -> dict:
    root = Path(job["root"]).resolve()
    settings = settings_from_overrides(job.get("settings") or {})
    scope = job.get("scope") or SCOPE_STUDY
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")  # the filters' own warnings (short segments) are not part of a manifest
        reg = collect(root, settings, default_catalogue(), include_sets=False, say=lambda _msg: None)
    manifests = []
    for m in reg.manifests:
        if scope != SCOPE_STUDY:
            m = {**m, "scope": scope}
        manifests.append(m)
    return {
        "root": str(root),
        "manifests": manifests,
        "failures": [{"recording_id": r, "reason": why} for r, why in reg.failed],
    }


def python_text(cases: dict) -> dict:
    """How Python writes and reads the values of js/eeg/pyfmt.js and pyjson.js (--python-text)."""
    import datetime
    import math

    from electrotag.app.eeg.events import parse_float, parse_int_code
    from electrotag.app.io.bids import loads_json

    def errors_of(text: str) -> str:
        try:
            loads_json(text)
            return ""
        except ValueError as exc:
            return str(exc)

    def utf8(data: list[int]) -> str:
        try:
            bytes(data).decode("utf-8")
            return ""
        except UnicodeDecodeError as exc:
            return str(exc)

    num = float  # "nan", "inf" and "-inf" come as text, which float() reads

    def micros(d: datetime.timedelta) -> int:
        return (d.days * 86400 + d.seconds) * 10**6 + d.microseconds

    return {
        "repr": [repr(num(x)) for x in cases["floats"]],
        "fixed": [format(num(x), f".{n}f") for x, n in cases["fixed"]],
        "g": [format(num(x), "g") if p is None else format(num(x), f".{p}g") for x, p in cases["g"]],
        "str_repr": [repr(s) for s in cases["strings"]],
        "json_errors": [errors_of(t) for t in cases["json"]],
        "utf8_errors": [utf8(b) for b in cases["utf8"]],
        "parse_float": [None if (v := parse_float(t)) is None else repr(v) for t in cases["parse"]],
        "parse_int": [None if (v := parse_int_code(t)) is None else str(v) for t in cases["parse"]],
        "timedelta_us": [micros(datetime.timedelta(seconds=x)) for x in cases["seconds"]],
        "isfinite": [math.isfinite(num(x)) for x in cases["floats"]],
    }


def check(jobs: list[dict]) -> dict:
    """The study server's checks of browser-built manifests (--check).

    Each job is {"manifests": [Manifest], "scope": "study" | "set:<id>", "suffixes": [..]}; each
    manifest is passed to ``electrotag.web.manifest_check.check_manifest`` as
    ``recordings_register`` passes it, and the answer gives, per manifest, the checked copy the
    server would store, or the reason it would refuse the manifest. A server without the checker
    answers {"unavailable": reason}.
    """
    try:
        from electrotag.web.manifest_check import ManifestProblem, check_manifest
    except ImportError as exc:
        return {"unavailable": f"electrotag.web.manifest_check cannot be imported ({exc})"}
    out = []
    for job in jobs:
        results = []
        for m in job["manifests"]:
            try:
                checked = check_manifest(m, scope=job["scope"], suffixes=tuple(job["suffixes"]))
                results.append({"ok": True, "checked": checked})
            except ManifestProblem as exc:
                results.append({"ok": False, "reason": str(exc)})
        out.append(results)
    return {"results": out}


def describe_files(jobs: list[dict]) -> list[dict]:
    """What MNE-Python reads from recordings anywhere on disk (--describe), in the shape of the
    ``*.expected.json`` files of scripts/make_web_fixtures.py, for the opt-in check of real recordings
    (ELECTROTAG_REAL_EEG) in web_tests/unit/data_readers.test.mjs. Each job is {"path": <the .edf, .bdf
    or .vhdr file>}; the answer gives, per job, the description, or {"error": what MNE-Python said}."""
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
    import numpy as np
    from make_web_fixtures import describe, read_raw

    from electrotag.app.io.discovery import read_vhdr_header
    from electrotag.app.io.edf import read_edf_header

    out = []
    for job in jobs:
        path = Path(job["path"])
        fmt = {".edf": "edf", ".bdf": "bdf", ".vhdr": "brainvision"}.get(path.suffix.lower())
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                raw = read_raw(path, fmt)
            lower: list[str] = []
            factors: dict[str, float] = {}
            if fmt == "brainvision":
                head = read_vhdr_header(path)
                files = [path, path.parent / (head.marker_file or ""), path.parent / (head.data_file or "")]
                data_file = files[2]
            else:
                files, data_file = [path], path
                h = read_edf_header(path)
                top = max(h.samples_per_record)
                lower = [lab for lab, n in zip(h.labels, h.samples_per_record, strict=False) if 0 < n < top]
                factors = {lab: top / n for lab, n in zip(h.labels, h.samples_per_record, strict=False) if 0 < n < top}
            n = int(raw.n_times)
            # a signal at a lower rate needs windows long enough to show its range (30 s), which the
            # tests' tolerance for it is relative to (MNE resamples it with an FFT, the browser linearly)
            w = min(n, int(30 * raw.info["sfreq"]) if lower else 64)
            rng = np.random.default_rng(1)
            idx = sorted({0, n - 1, *map(int, rng.integers(0, n, 16))})
            if lower:  # and samples at the slower signals' own times, where both give the stored value
                step = int(round(max(factors.values())))
                idx = sorted(set(idx) | {int(k) * step for k in rng.integers(0, max(1, n // step), 32)})
            info = describe(raw, fmt, data_file, files, filters=[], windows=[(0, w), (n // 2, n // 2 + w), (n - w, n)],
                            sample_idx=idx)
            info["paths"] = [str(f) for f in files]
            info["lower_rate"] = [c for c in raw.ch_names if c in lower]
            info["lower_rate_factor"] = {c: factors[c] for c in info["lower_rate"]}
            out.append(info)
        except Exception as exc:  # noqa: BLE001 - the browser must refuse what MNE cannot read
            out.append({"error": f"{type(exc).__name__}: {exc}", "paths": [str(path)]})
    return out


def main() -> int:
    if sys.argv[1:] == ["--describe"]:
        json.dump(describe_files(json.load(sys.stdin)), sys.stdout)
        return 0
    if sys.argv[1:] == ["--python-text"]:
        json.dump(python_text(json.load(sys.stdin)), sys.stdout)
        return 0
    if sys.argv[1:] == ["--check"]:
        json.dump(check(json.load(sys.stdin)), sys.stdout)
        return 0
    jobs = json.load(sys.stdin)
    json.dump([register(job) for job in jobs], sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
