"""Administrator functions: study configuration, passphrase, allocation, progress.

The administrator passphrase keeps annotators out of the administrator tools
by accident; it is not a security boundary. Anyone with file-system access to
the dataset can read reference annotations, so blinded assessments rely on
annotators not browsing those folders (or on storing reference sets in a
location annotators cannot access, set with ``training.reference_sets_dir``).
"""

from __future__ import annotations

import copy
import hashlib
import hmac
import json
import os
from pathlib import Path
from typing import Any

from electroclean.app.common import normalise_annotator_id
from electroclean.app.io.atomic import atomic_write_json
from electroclean.app.io.naming import OutputLayout
from electroclean.app.session.failures import FailureLog
from electroclean.app.session.register import CompletionRegister
from electroclean.app.session.selection import balanced_allocation
from electroclean.config.settings import (
    STUDY_CONFIG_FILENAME,
    FilterSettings,
    Settings,
    StudyConfig,
    deep_merge,
    load_default_settings_dict,
)
from electroclean.training.reference import ReferenceSet

PBKDF2_ITERATIONS = 200_000


def hash_passphrase(passphrase: str, iterations: int = PBKDF2_ITERATIONS) -> dict[str, Any]:
    if len(passphrase) < 6:
        raise ValueError("Use a passphrase of at least 6 characters")
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", passphrase.encode("utf-8"), salt, iterations)
    return {"algorithm": "pbkdf2_sha256", "iterations": iterations, "salt": salt.hex(), "hash": digest.hex()}


def verify_passphrase(passphrase: str, record: dict[str, Any] | None) -> bool:
    if not record:
        return True  # no passphrase configured
    if record.get("algorithm") != "pbkdf2_sha256":
        return False
    digest = hashlib.pbkdf2_hmac(
        "sha256", passphrase.encode("utf-8"), bytes.fromhex(record["salt"]), int(record["iterations"])
    )
    return hmac.compare_digest(digest.hex(), record["hash"])


def study_config_path(dataset_root: Path) -> Path:
    return Path(dataset_root) / STUDY_CONFIG_FILENAME


def read_study_dict(dataset_root: Path) -> dict[str, Any]:
    p = study_config_path(dataset_root)
    if not p.exists():
        return {"study_id": "", "annotators": [], "allow_unlisted_annotators": True, "settings": {}}
    return json.loads(p.read_text(encoding="utf-8-sig"))


def write_study_dict(dataset_root: Path, data: dict[str, Any]) -> Path:
    """Validate and save the study configuration atomically."""
    p = study_config_path(dataset_root)
    # Validate by building the effective settings exactly as the application will.
    merged = deep_merge(load_default_settings_dict(), data.get("settings", {}) or {})
    alloc = data.get("allocation") or {}
    if "strategy" in alloc or "seed" in alloc:
        sel = merged.setdefault("selection", {})
        sel.update({k: alloc[k] for k in ("strategy", "seed") if k in alloc})
    Settings.from_dict(merged)
    for a in data.get("annotators", []):
        aid = a["annotator_id"] if isinstance(a, dict) else a
        normalise_annotator_id(aid)
    atomic_write_json(p, data)
    StudyConfig.load(p)
    return p


def update_study(dataset_root: Path, changes: dict[str, Any]) -> Path:
    data = read_study_dict(dataset_root)
    return write_study_dict(dataset_root, deep_merge(data, changes))


def set_admin_passphrase(dataset_root: Path, passphrase: str) -> Path:
    data = read_study_dict(dataset_root)
    data["admin_passphrase"] = hash_passphrase(passphrase)
    return write_study_dict(dataset_root, data)


def set_annotators(dataset_root: Path, annotators: list[tuple[str, str]], allow_unlisted: bool) -> Path:
    data = read_study_dict(dataset_root)
    data["annotators"] = [{"annotator_id": normalise_annotator_id(a), "display_name": n} for a, n in annotators]
    data["allow_unlisted_annotators"] = bool(allow_unlisted)
    return write_study_dict(dataset_root, data)


def fix_filters(dataset_root: Path, filters: FilterSettings) -> Path:
    fs = FilterSettings(**{**filters.to_dict(), "locked": True})
    fs.validate()
    data = read_study_dict(dataset_root)
    data.setdefault("settings", {})["filters"] = fs.to_dict()
    return write_study_dict(dataset_root, data)


def unlock_filters(dataset_root: Path) -> Path:
    data = read_study_dict(dataset_root)
    f = data.setdefault("settings", {}).setdefault("filters", {})
    f["locked"] = False
    return write_study_dict(dataset_root, data)


def set_allocation(
    dataset_root: Path, strategy: str, *, seed: int | None = None, assignments: dict[str, list[str]] | None = None
) -> Path:
    data = read_study_dict(dataset_root)
    alloc: dict[str, Any] = {"strategy": strategy}
    if seed is not None:
        alloc["seed"] = int(seed)
    if assignments is not None:
        alloc["assignments"] = {normalise_annotator_id(k): list(v) for k, v in assignments.items()}
    data["allocation"] = alloc
    return write_study_dict(dataset_root, data)


def make_balanced_allocation(
    dataset_root: Path, recording_ids: list[str], annotators: list[str], raters_per_recording: int, seed: int
) -> dict[str, list[str]]:
    ids = [normalise_annotator_id(a) for a in annotators]
    assignments = balanced_allocation(recording_ids, ids, raters_per_recording, seed)
    set_allocation(dataset_root, "manual", seed=seed, assignments=assignments)
    data = read_study_dict(dataset_root)
    data["allocation"]["design"] = {"raters_per_recording": raters_per_recording, "seed": seed, "method": "balanced"}
    write_study_dict(dataset_root, data)
    return assignments


def assessment_progress(layout: OutputLayout, rs: ReferenceSet, annotators: list[str]) -> list[dict[str, Any]]:
    reg = CompletionRegister(layout)
    rows = []
    for a in annotators:
        aid = normalise_annotator_id(a)
        done = reg.completed(aid, "assessment", rs.set_id) & set(rs.assessment_recordings)
        practice = reg.completed(aid, "practice", rs.set_id) & set(rs.practice_recordings)
        rows.append({
            "annotator_id": aid,
            "practice_completed": len(practice),
            "practice_total": len(rs.practice_recordings),
            "assessment_completed": len(done),
            "assessment_total": len(rs.assessment_recordings),
        })
    return rows


def resolve_failure(layout: OutputLayout, recording_id: str, note: str, by: str = "administrator") -> None:
    FailureLog(layout).mark_resolved(recording_id, note, by)


def copy_without_secrets(data: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(data)
    if "admin_passphrase" in out:
        out["admin_passphrase"] = "(set)"
    return out
