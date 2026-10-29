"""The example training set for a study in the browser, with or without MNE-Python.

``set_example_create`` (the admin area) adds ElectroTag's example training set
(:func:`electrotag.training.examples.create_example_training_set`: three simulated recordings
with the simulation's ground truth as the "expert" reference) to the study, and gives the
administrator its recordings as a zip to pass on to trainees.

Making the recordings and the reference needs only numpy and pybv, which the Cloud Functions
have. Registering the recordings (their manifests) normally opens them with MNE-Python, which the
functions do not include. The simulation is deterministic, so the manifests of its recordings are
kept with the package (``electrotag/config/example_set_manifests.json``, written with MNE-Python
by ``python -m electrotag.web.example``) and used when MNE-Python is not at hand, but only after
checking that every recording file made here has exactly the size and SHA-256 recorded in them.
When they differ (for example with another version of numpy), the example set is refused with an
explanation rather than registered with manifests that do not describe its files. Where MNE-Python
is installed (the ElectroTag server), the recordings are registered with it directly, as by
``electrotag-web register``, using the study's settings.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import io
import json
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from electrotag import __version__
from electrotag.app.common import now_local_iso
from electrotag.web.manifest import set_scope

#: Kept with the configuration files, which are installed with the package.
TEMPLATE_PATH = Path(__file__).resolve().parents[1] / "config" / "example_set_manifests.json"
TEMPLATE_SCHEMA = "electrotag.web_example_manifests"
ZIP_NAME = "electrotag-example-set.zip"
ZIP_FOLDER = "electrotag-example-set"
#: A fixed time for the entries of the zip, so the same recordings always give the same zip.
ZIP_TIME = (2026, 1, 1, 0, 0, 0)


class ExampleUnavailable(RuntimeError):
    """The example set cannot be made here (the message says why, for the administrator)."""


@dataclass
class ExampleSet:
    set_id: str
    definition: dict[str, Any]
    files: dict[str, bytes]
    manifests: list[dict[str, Any]]
    recordings_zip: bytes
    registered_with: str  # "mne" or "template"


def _zip(folder: Path) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(folder.rglob("*")):
            if p.is_file():
                info = zipfile.ZipInfo(f"{ZIP_FOLDER}/{p.relative_to(folder).as_posix()}", date_time=ZIP_TIME)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o644 << 16
                zf.writestr(info, p.read_bytes())
    return buf.getvalue()


def _live_manifests(rec_root: Path, set_id: str, settings: Any, catalogue: Any) -> list[dict[str, Any]]:
    import mne

    from electrotag.app.io.discovery import discover_recordings
    from electrotag.web.manifest import register_recording

    mne.set_log_level("error")
    return [register_recording(files, settings, catalogue, scope=set_scope(set_id))
            for files in discover_recordings(rec_root, suffixes=settings.discovery_suffixes)]


def template_manifests() -> list[dict[str, Any]]:
    try:
        data = json.loads(TEMPLATE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ExampleUnavailable("The example set's registrations are missing from this copy of ElectroTag") from exc
    if data.get("schema") != TEMPLATE_SCHEMA:
        raise ExampleUnavailable("The example set's registrations are not in the expected form")
    return list(data["manifests"])


def _checked_template(rec_root: Path) -> list[dict[str, Any]]:
    """The kept manifests, after checking every file they describe against the files made here."""
    out = []
    for m in template_manifests():
        for role, fp in (m.get("fingerprint") or {}).items():
            path = rec_root / str(fp.get("path", ""))
            data = path.read_bytes() if path.is_file() else b""
            if len(data) != int(fp.get("size", -1)) or hashlib.sha256(data).hexdigest() != fp.get("sha256"):
                raise ExampleUnavailable(
                    "The example recordings made here are not byte for byte those whose registrations ElectroTag "
                    f"keeps ({m['recording_id']}, {role}), so they cannot be registered without MNE-Python. Create "
                    "the example set with 'electrotag-web create-example-set' on a computer with ElectroTag "
                    "installed instead.")
        m = copy.deepcopy(m)
        m["created_at"] = now_local_iso()
        out.append(m)
    return out


def build_example(settings: Any, catalogue: Any, *, use_mne: bool | None = None) -> ExampleSet:
    """Make the example set: its definition and reference files, its manifests and its recordings (zip).

    ``use_mne``: True registers the recordings with MNE-Python, False uses the kept manifests, None
    (the default) uses MNE-Python when it can be imported."""
    from electrotag.training.examples import EXAMPLE_SET_ID, create_example_training_set
    from electrotag.web.registration import reference_set_payload

    with tempfile.TemporaryDirectory(prefix="electrotag-example-") as tmp:
        rs = create_example_training_set(Path(tmp))
        definition, files = reference_set_payload(rs.directory)
        rec_root = rs.recordings_root()
        assert rec_root is not None
        manifests: list[dict[str, Any]] | None = None
        how = "template"
        if use_mne is not False:
            try:
                manifests = _live_manifests(rec_root, rs.set_id, settings, catalogue)
                how = "mne"
            except ImportError:
                if use_mne:
                    raise
        if manifests is None:
            manifests = _checked_template(rec_root)
        return ExampleSet(EXAMPLE_SET_ID, definition, files, manifests, _zip(rec_root), how)


def _stable(m: dict[str, Any]) -> dict[str, Any]:
    """A manifest without what changes from one making to the next (times and file dates)."""
    m = copy.deepcopy(m)
    m["created_at"] = ""
    m["electrotag_version"] = ""
    for fp in (m.get("fingerprint") or {}).values():
        fp.pop("mtime_ns", None)
    return m


def write_template(path: Path = TEMPLATE_PATH) -> Path:
    """Register the example recordings with MNE-Python and keep their manifests (run when the example set,
    the simulation or the loader changes; the tests say when)."""
    from electrotag.app.annotations.labels import default_catalogue
    from electrotag.config.settings import load_settings

    settings, _ = load_settings(None)
    ex = build_example(settings, default_catalogue(), use_mne=True)
    data = {"schema": TEMPLATE_SCHEMA, "electrotag_version": __version__, "set_id": ex.set_id,
            "note": "Manifests of the example training set's simulated recordings, made with MNE-Python by "
                    "'python -m electrotag.web.example'; used where MNE-Python is not installed.",
            "manifests": [_stable(m) for m in sorted(ex.manifests, key=lambda m: m["recording_id"])]}
    path.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    return path


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m electrotag.web.example",
                                description="Write the example set's manifests kept for the Cloud Functions.")
    p.add_argument("--out", type=Path, default=TEMPLATE_PATH)
    a = p.parse_args(argv)
    print(f"Wrote {write_template(a.out)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
