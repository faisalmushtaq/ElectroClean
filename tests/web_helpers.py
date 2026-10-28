"""Shared helpers for the tests of the browser version's Python side (electroclean/web/)."""

from __future__ import annotations

import hashlib
import shutil
from pathlib import Path
from typing import Any

from electroclean.web.demo import DEMO_PASSWORD, build_demo

H = {"X-ElectroClean": "1"}
SUB1 = "sub-001/eeg/sub-001_task-rest_eeg.vhdr"
SUB2 = "sub-002/eeg/sub-002_task-rest_eeg.vhdr"
SUB3 = "sub-003/eeg/sub-003_task-rest_eeg.edf"
GUIDED1 = "sub-example01/eeg/sub-example01_task-example_eeg.vhdr"
GUIDED2 = "sub-example02/eeg/sub-example02_task-example_eeg.vhdr"
PRACTICE1 = "sub-example03/eeg/sub-example03_task-example_eeg.vhdr"


def make_template(base: Path) -> Path:
    """The demonstration, built once per test session (tests copy its study folder)."""
    build_demo(base, say=lambda _m: None, quiz=False)  # the quiz tests add their own items
    return base


def copy_demo(template: Path, dest: Path) -> Path:
    """A private copy of the demonstration's study folder (the recordings are shared, read only)."""
    shutil.copytree(template / "study", dest / "study")
    try:
        (dest / "recordings").symlink_to(template / "recordings", target_is_directory=True)
    except OSError:  # Windows without the right to make symbolic links
        shutil.copytree(template / "recordings", dest / "recordings")
    return dest / "study"


def data_file(recordings: Path, rid: str) -> Path:
    """The file the browser fingerprints: the EDF/BDF file, or the BrainVision .eeg file."""
    base = recordings / ("training" if rid.startswith("sub-example") else "study") / rid
    if base.suffix == ".vhdr":
        from electroclean.app.io.discovery import read_vhdr_header

        return base.parent / read_vhdr_header(base).data_file
    return base


def match_body(recordings: Path, rid: str) -> dict[str, Any]:
    f = data_file(recordings, rid)
    return {"file_name": Path(rid).name, "size_bytes": f.stat().st_size,
            "sha256": hashlib.sha256(f.read_bytes()).hexdigest()}


def sha_of(recordings: Path, rid: str) -> str:
    return match_body(recordings, rid)["sha256"]


def ann(aid: str, label: str, onset: int, dur: int, channels: list[str] | None = None) -> dict[str, Any]:
    return {"annotation_id": aid, "label": label, "onset_sample": onset, "duration_samples": dur,
            "channels": list(channels or []), "created_at": "2026-10-28T10:00:00.000+00:00",
            "modified_at": "2026-10-28T10:00:00.000+00:00"}


class Api:
    """A signed-in test client for the ElectroClean server."""

    def __init__(self, client: Any, annotator: str, password: str = DEMO_PASSWORD) -> None:
        self.client = client
        r = client.post("/api/v1/login", json={"annotator_id": annotator, "password": password}, headers=H)
        assert r.status_code == 200, r.text
        self.token = r.json()["token"]
        self.headers = {**H, "Authorization": f"Bearer {self.token}"}

    def get(self, path: str, **kw: Any) -> Any:
        return self.client.get(f"/api/v1{path}", headers=self.headers, **kw)

    def post(self, path: str, body: Any = None, **kw: Any) -> Any:
        return self.client.post(f"/api/v1{path}", json=body if body is not None else {}, headers=self.headers, **kw)

    def put(self, path: str, body: Any, **kw: Any) -> Any:
        return self.client.put(f"/api/v1{path}", json=body, headers=self.headers, **kw)

    def delete(self, path: str, **kw: Any) -> Any:
        return self.client.delete(f"/api/v1{path}", headers=self.headers, **kw)

    def ok(self, method: str, path: str, *args: Any, **kw: Any) -> Any:
        r = getattr(self, method)(path, *args, **kw)
        assert r.status_code == 200, f"{method.upper()} {path}: {r.status_code} {r.text}"
        return r.json()

    def admin(self, op: str, body: dict[str, Any] | None = None) -> Any:
        """``POST /admin/{op}``: the response (check ``status_code`` yourself)."""
        return self.post(f"/admin/{op}", body or {})

    def admin_ok(self, op: str, body: dict[str, Any] | None = None) -> Any:
        r = self.admin(op, body)
        assert r.status_code == 200, f"admin {op}: {r.status_code} {r.text}"
        return r.json()

    def admin_error(self, op: str, body: dict[str, Any] | None, status: int, code: str) -> dict[str, Any]:
        r = self.admin(op, body)
        assert (r.status_code, r.json().get("error")) == (status, code), f"admin {op}: {r.status_code} {r.text}"
        return r.json()

    def quiz(self, set_id: str, body: dict[str, Any]) -> Any:
        return self.post(f"/quiz/{set_id}", body)


def submission(recordings: Path, rid: str, annotations: list[dict[str, Any]], mode: str = "standard",
               context: str = "", elapsed: float = 61.5) -> dict[str, Any]:
    return {"recording_id": rid, "mode": mode, "context_id": context, "annotations": annotations,
            "session": {"started_at": "2026-10-28T10:00:00.000+00:00", "elapsed_s": elapsed,
                        "filters": {"highpass_hz": 1.0, "notch_hz": 50.0, "notch_harmonics": False, "method": "fir"},
                        "view": {"start_s": 0.0, "duration_s": 10.0, "first_channel": 0, "n_channels": 22,
                                 "scale_factor": 1.0},
                        "client": {"user_agent": "pytest", "screen": {"width": 1920, "height": 1080,
                                                                      "pixel_ratio": 1}}},
            "sha256": sha_of(recordings, rid)}


def reference_annotations(study_or_store: Any, set_id: str, rid: str) -> list[Any]:
    """The experts' annotations (the tests may know them; the browser never receives them)."""
    from electroclean.training.guided import build_steps

    rs = study_or_store.reference_set(set_id)
    return [s.target for s in build_steps(rs.reference_document(rid))]


def as_wire(a: Any, aid: str | None = None) -> dict[str, Any]:
    return ann(aid or a.annotation_id, a.label, a.onset_sample, a.duration_samples, list(a.channels))


def build_manifests(folder: Path, scope: str = "study") -> list[dict[str, Any]]:
    """The manifests of every recording in a folder, as the desktop's registration makes them (MNE-Python),
    which is what the browser's registration (js/data/register.js) builds too."""
    from electroclean.app.annotations.labels import default_catalogue
    from electroclean.config.settings import load_settings
    from electroclean.web.registration import collect

    settings, _ = load_settings(None)
    reg = collect(folder, settings, default_catalogue(), include_sets=False, say=lambda _m: None)
    assert not reg.failed, reg.failed
    for m in reg.manifests:
        m["scope"] = scope
    return reg.manifests


def admin_audit(api: Api, n: int = 50) -> list[dict[str, Any]]:
    return api.admin_ok("audit", {"limit": n})["entries"]
