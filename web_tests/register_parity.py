"""Register datasets with the desktop application's loader, for the browser's unit tests.

    python -I web_tests/register_parity.py < jobs.json

Each job is {"root": "<dataset folder>", "settings": {block: {key: value}}, "scope": "study"}: the
dataset is registered as ``electroclean-web register`` registers it (discovery as
``electroclean.web.registration.collect``, every recording opened with
``electroclean.app.eeg.loading.load_recording`` and described by
``electroclean.web.manifest.build_manifest``), with the study settings made from the defaults
and the job's blocks, and the default label catalogue. The answer gives, per job, the manifests
and the recordings that could not be registered with the reason, so that
web_tests/unit/data_register.test.mjs can compare js/data/register.js with them field by field.

Run it with ``-I`` (the folders are test data, never imported from) and the repository's Python.

    python -I web_tests/register_parity.py --python-text < cases.json

answers how Python writes and reads the values that js/data/pyfmt.js and pyjson.js imitate
(repr of floats, format specifications, repr of strings, json and UTF-8 errors, the desktop's
parse_float and parse_int_code, timedelta's rounding), for web_tests/unit/data_register_py.test.mjs.
"""

from __future__ import annotations

import json
import sys
import warnings
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from electroclean.app.annotations.labels import default_catalogue  # noqa: E402
from electroclean.web.manifest import SCOPE_STUDY  # noqa: E402
from electroclean.web.registration import collect  # noqa: E402
from electroclean.web.store import settings_from_overrides  # noqa: E402


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
    """How Python writes and reads the values of js/data/pyfmt.js and pyjson.js (--python-text)."""
    import datetime
    import math

    from electroclean.app.eeg.events import parse_float, parse_int_code

    def errors_of(text: str) -> str:
        try:
            json.loads(text)
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


def main() -> int:
    if sys.argv[1:] == ["--python-text"]:
        json.dump(python_text(json.load(sys.stdin)), sys.stdout)
        return 0
    jobs = json.load(sys.stdin)
    json.dump([register(job) for job in jobs], sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
