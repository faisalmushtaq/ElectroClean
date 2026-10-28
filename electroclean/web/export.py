"""``electroclean-web export``: a Firestore study's results in ElectroClean's usual folders.

::

    DIR/
        electroclean_study.json      the study's settings (so DIR can be used as a study folder)
        Annotated_Events/            as written by the desktop application
            completion_register.tsv, session_log.jsonl, annotator-<ID>/..., training/...
            training_progress/<set>/annotator-<ID>.json
            interaction_logs/annotator-<ID>/<time>_<mode>.jsonl

The result files are exactly those the desktop application's code wrote when each recording was
saved (kept in Firestore since); the completion register is updated with ElectroClean's own
register code, so ``electroclean-agreement DIR/Annotated_Events`` and ``electroclean-activity
DIR/Annotated_Events`` work as for a desktop study. Exporting again adds what is new; a file that
already exists with different contents is never replaced.
"""

from __future__ import annotations

import json
from pathlib import Path, PurePosixPath
from typing import Any

from electroclean.app.io.atomic import atomic_write_bytes, atomic_write_json, atomic_write_text
from electroclean.app.io.naming import OutputLayout
from electroclean.app.session.register import CompletionRegister
from electroclean.config.settings import STUDY_CONFIG_FILENAME
from electroclean.web.store import StoreError


class ExportError(RuntimeError):
    pass


def safe_path(root: Path, rel: str) -> Path:
    """``root / rel``, refusing anything that would leave ``root``."""
    parts = PurePosixPath(str(rel)).parts
    if not parts or ".." in parts or PurePosixPath(str(rel)).is_absolute() or "\\" in str(rel):
        raise ExportError(f"Refusing to write outside the results folder: {rel!r}")
    return root.joinpath(*parts)


_safe = safe_path


def visit_log_text(header: dict[str, Any], events: list[dict[str, Any]]) -> str:
    """A visit's interaction log as the JSON Lines file the desktop application writes."""
    return _jsonl(header) + "".join(_jsonl(e) for e in events)


def _put(path: Path, data: bytes, counts: dict[str, int]) -> None:
    if path.exists():
        if path.read_bytes() == data:
            counts["unchanged"] += 1
            return
        raise ExportError(f"{path} already exists with different contents; export into an empty folder")
    atomic_write_bytes(path, data)
    counts["written"] += 1


def _jsonl(obj: dict[str, Any]) -> str:
    from electroclean.app.session.interaction_log import _jsonable

    return json.dumps(_jsonable(obj), ensure_ascii=False, separators=(",", ":")) + "\n"


def export_study(store: Any, to: Path | str) -> dict[str, int]:
    """Write the study held by ``store`` (a FirestoreStore) into ``to`` (see the module docstring)."""
    to = Path(to)
    to.mkdir(parents=True, exist_ok=True)
    try:
        overrides = store.settings_overrides
        settings = store.settings
    except StoreError as exc:
        raise ExportError(str(exc)) from exc
    cfg = to / STUDY_CONFIG_FILENAME
    if not cfg.exists():
        atomic_write_json(cfg, {"study_id": store.study_id, "name": store.name, "settings": overrides,
                                "exported_from": "firestore"})
    layout = OutputLayout(to / settings.output_directory_name)
    layout.root.mkdir(parents=True, exist_ok=True)
    register = CompletionRegister(layout, settings.register_lock_timeout_s)
    counts = {"recordings": 0, "written": 0, "unchanged": 0, "visits": 0, "progress": 0, "reports": 0,
              "other": 0}
    known = {e.get("session_id") for e in register.entries()}
    session_log: list[str] = []
    for entry, files, log_lines in sorted(store.submission_files(), key=lambda x: x[0].get("completed_at", "")):
        folder = _safe(layout.root, entry["output_dir"])
        for name, data in sorted(files.items()):
            if "/" in name or "\\" in name:
                raise ExportError(f"Unsuitable file name {name!r}")
            _put(folder / name, data, counts)
        if entry.get("session_id") not in known:
            register.add(entry)
            session_log.extend(log_lines)
            known.add(entry.get("session_id"))
        counts["recordings"] += 1
    if session_log:
        with open(layout.session_log, "a", encoding="utf-8") as fh:
            fh.write("".join(line.rstrip("\n") + "\n" for line in session_log))
    for d in store.progress_records():
        if d.get("reference_set_id") and d.get("annotator_id"):
            path = layout.root / "training_progress" / d["reference_set_id"] / f"annotator-{d['annotator_id']}.json"
            atomic_write_json(path, d)
            counts["progress"] += 1
    for set_id, aid, report in store.reports():
        base = layout.root / "training" / set_id / "reports" / f"annotator-{aid}_competency_report"
        atomic_write_text(base.with_suffix(".json"), report.get("json", ""))
        if report.get("html"):
            atomic_write_text(base.with_suffix(".html"), report["html"])
        counts["reports"] += 1
    for visit, header, events in sorted(store.visit_logs(), key=lambda v: v[0].get("opened_at", "")):
        folder = layout.interaction_logs / f"annotator-{visit['annotator_id']}"
        stem = str(visit.get("stem") or visit["visit_id"])
        path = folder / f"{stem}.jsonl"
        n = 2
        while path.exists() and _visit_id_of(path) != visit["visit_id"]:
            path = folder / f"{stem}-{n}.jsonl"
            n += 1
        text = visit_log_text(header, events)
        folder.mkdir(parents=True, exist_ok=True)
        atomic_write_text(path, text)
        counts["visits"] += 1
    for rel, data in sorted(store.result_files()):  # quiz results and other files kept as they were written
        _put(safe_path(layout.root, rel), data, counts)
        counts["other"] += 1
    return counts


#: The largest results zip the administrator's area downloads (larger studies: ``electroclean-web export``).
MAX_RESULTS_ZIP = 25_000_000


def results_zip_file(store: Any) -> Path:
    """A zip of the study's results folder (results, interaction logs, training progress, reports and quiz
    results), in a temporary file the caller deletes."""
    import tempfile
    import zipfile

    from electroclean.app.common import now_local_iso
    from electroclean.app.io.naming import INTERNAL_DIR

    tmp = tempfile.NamedTemporaryFile(prefix="electroclean-results-", suffix=".zip", delete=False)
    tmp.close()
    with tempfile.TemporaryDirectory(prefix="electroclean-export-") as work:
        if getattr(store, "kind", "") == "firestore":
            export_study(store, work)
            root = Path(work) / store.settings.output_directory_name
        else:
            root = store.layout.root
        base = root.name or "Annotated_Events"
        with zipfile.ZipFile(tmp.name, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            if root.is_dir():
                for path in sorted(root.rglob("*")):
                    rel = path.relative_to(root)
                    if (rel.parts and rel.parts[0] == INTERNAL_DIR) or not path.is_file():
                        continue
                    zf.write(path, f"{base}/{rel.as_posix()}")
            zf.writestr(f"{base}/README.txt", f"Results of the ElectroClean study {store.name}, downloaded "
                        f"{now_local_iso()}.\nAnalyse them with electroclean-agreement and electroclean-activity, as "
                        "for the desktop application.\n")
    return Path(tmp.name)


def _visit_id_of(path: Path) -> str:
    try:
        with open(path, encoding="utf-8") as fh:
            return str(json.loads(fh.readline()).get("visit_id", ""))
    except (OSError, ValueError):
        return ""
