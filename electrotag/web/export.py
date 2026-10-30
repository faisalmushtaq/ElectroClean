"""``electrotag-web export``: a Firestore study's results in ElectroTag's usual folders.

::

    DIR/
        electrotag_study.json      the study's settings (so DIR can be used as a study folder)
        Annotated_Events/            ElectroTag's results layout
            completion_register.tsv, session_log.jsonl, annotator-<ID>/..., training/...
            derived/<kind>/                  corrections and adjudicated versions, each tree with its own
                                             completion_register.tsv (docs/file_formats.md)
            training/<set>/quiz/annotator-<ID>_quiz_<mode>_<session>.json
            training_progress/<set>/annotator-<ID>.json
            problem_reports/problem_reports.tsv, .json      the problems annotators reported (docs/file_formats.md)
            reviews/annotator-<ID>/<recording>_attempt-<n>_review-<time>-<id>.tsv, .json   each review of saved work
            tasks/tasks.tsv, .json, gold_scores.tsv           the tasks and the known-answer scores
            interaction_logs/annotator-<ID>/<time>_<mode>.jsonl

The result files are exactly those the desktop application's code wrote when each recording was
saved (kept in Firestore since); the completion register is updated with ElectroTag's own
register code, so ``electrotag-agreement DIR/Annotated_Events`` and ``electrotag-activity
DIR/Annotated_Events`` work on it directly. Exporting again adds what is new; a file that
already exists with different contents is never replaced.
"""

from __future__ import annotations

import json
from pathlib import Path, PurePosixPath
from typing import Any

from electrotag.app.io.atomic import atomic_write_bytes, atomic_write_json, atomic_write_text
from electrotag.app.io.naming import OutputLayout
from electrotag.app.session.register import CompletionRegister
from electrotag.config.settings import STUDY_CONFIG_FILENAME
from electrotag.web.store import StoreError


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
    from electrotag.app.session.interaction_log import _jsonable

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
    recovered = store.recover_interrupted()  # pieces of interrupted writes, which hold no result
    cfg = to / STUDY_CONFIG_FILENAME
    if not cfg.exists():
        atomic_write_json(cfg, {"study_id": store.study_id, "name": store.name, "settings": overrides,
                                "exported_from": "firestore"})
    layout = OutputLayout(to / settings.output_directory_name)
    layout.root.mkdir(parents=True, exist_ok=True)
    register = CompletionRegister(layout, settings.register_lock_timeout_s)
    counts = {"recordings": 0, "written": 0, "unchanged": 0, "visits": 0, "progress": 0, "reports": 0,
              "other": 0, "cleaned_up": len(recovered)}
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
    _export_derived(store, layout, settings, counts)
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
    from electrotag.web.feedback import feedback_files

    # The problem reports and reviews as they stand now (a report may have been resolved since the last export).
    for rel, data in sorted(feedback_files(store).items()):
        atomic_write_bytes(safe_path(layout.root, rel), data)
        counts["feedback"] = counts.get("feedback", 0) + 1
    from electrotag.web.tasks import task_files

    for rel, data in sorted(task_files(store).items()):  # the tasks and the known-answer scores as they stand now
        atomic_write_bytes(safe_path(layout.root, rel), data)
        counts["tasks"] = counts.get("tasks", 0) + 1
    return counts


def _export_derived(store: Any, layout: OutputLayout, settings: Any, counts: dict[str, int]) -> None:
    """The derived versions (corrections, adjudicated versions) into ``derived/<kind>/``, each tree with its own
    completion register and session log, as the files store keeps them."""
    from electrotag.web.store import DERIVED_DIR

    rows = getattr(store, "derived_submission_files", lambda: [])()
    by_kind: dict[str, list[str]] = {}
    for kind, entry, files, log_lines in sorted(rows, key=lambda x: (x[0], x[1].get("completed_at", ""))):
        tree = OutputLayout(layout.root / DERIVED_DIR / kind)
        tree.root.mkdir(parents=True, exist_ok=True)
        register = CompletionRegister(tree, settings.register_lock_timeout_s)
        folder = _safe(tree.root, entry["output_dir"])
        for name, data in sorted(files.items()):
            if "/" in name or "\\" in name:
                raise ExportError(f"Unsuitable file name {name!r}")
            _put(folder / name, data, counts)
        if entry.get("session_id") not in {e.get("session_id") for e in register.entries()}:
            register.add(entry)
            by_kind.setdefault(kind, []).extend(log_lines)
        counts["derived"] = counts.get("derived", 0) + 1
    for kind, lines in by_kind.items():
        if lines:
            with open(OutputLayout(layout.root / DERIVED_DIR / kind).session_log, "a", encoding="utf-8") as fh:
                fh.write("".join(line.rstrip("\n") + "\n" for line in lines))


#: The largest results zip the administrator's area downloads (larger studies: ``electrotag-web export``).
MAX_RESULTS_ZIP = 25_000_000


def results_zip_file(store: Any) -> Path:
    """A zip of the study's results folder (results, interaction logs, training progress, reports, quiz results,
    problem reports and reviews) with the study's settings, audit log and manifests under ``study/`` and a
    README, in a temporary file the caller deletes."""
    import tempfile
    import zipfile

    from electrotag.app.common import now_local_iso
    from electrotag.app.io.naming import INTERNAL_DIR

    tmp = tempfile.NamedTemporaryFile(prefix="electrotag-results-", suffix=".zip", delete=False)
    tmp.close()
    with tempfile.TemporaryDirectory(prefix="electrotag-export-") as work:
        if getattr(store, "kind", "") == "firestore":
            export_study(store, work)
            root = Path(work) / store.settings.output_directory_name
        else:
            root = store.layout.root
        from electrotag.web.feedback import feedback_files

        from electrotag.web.tasks import task_files

        extra = {} if getattr(store, "kind", "") == "firestore" else {**feedback_files(store), **task_files(store)}
        base = root.name or "Annotated_Events"
        with zipfile.ZipFile(tmp.name, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            if root.is_dir():
                for path in sorted(root.rglob("*")):
                    rel = path.relative_to(root)
                    # the journalled saves' own workings (locks, staging), in the results tree and each derived one
                    if INTERNAL_DIR in rel.parts or not path.is_file():
                        continue
                    zf.write(path, f"{base}/{rel.as_posix()}")
            for rel, data in sorted(extra.items()):  # the problem reports and reviews (the files store keeps them)
                zf.writestr(f"{base}/{rel}", data)
            for rel, data in study_record_files(store).items():
                zf.writestr(rel, data)
            zf.writestr("README.txt", results_readme(store.name, base, now_local_iso()))
    return Path(tmp.name)


def study_record_files(store: Any) -> dict[str, bytes]:
    """The study's own records for the results zip: its settings, its audit log and its recordings' manifests."""
    entries: list[dict[str, Any]] = []
    before = None
    while True:
        page, before = store.audit_page(before, 500)
        entries.extend(page)
        if not before or not page:
            break
    audit_text = "".join(json.dumps(e, ensure_ascii=False, sort_keys=True) + "\n" for e in reversed(entries))
    manifests = sorted(store.manifests(), key=lambda m: (str(m.get("scope", "")), str(m.get("recording_id", ""))))
    settings = {"study_id": store.study_id, "name": store.name, "settings": store.settings_overrides}
    dump = lambda obj: (json.dumps(obj, ensure_ascii=False, indent=2) + "\n").encode("utf-8")  # noqa: E731
    return {
        f"study/{STUDY_CONFIG_FILENAME}": dump(settings),
        "study/audit_log.jsonl": audit_text.encode("utf-8"),
        "study/manifests.json": dump({"manifests": manifests}),
    }


def results_readme(study_name: str, base: str, when: str) -> str:
    """What the results zip holds, and how to analyse it."""
    return (
        f"Results of the ElectroTag study {study_name}, downloaded {when}.\n\n"
        f"{base}/ holds the saved annotations of each annotator (an _annotations.json, _events.tsv, _events.json\n"
        "and _session.json for each recording), the completion register, the interaction logs, the training\n"
        "progress and competency reports, the quiz results, the problem reports, the reviews, and the tasks\n"
        "that shared recordings out with their known-answer scores (tasks/).\n"
        f"{base}/derived/ holds the versions made from them (experts' corrections, adjudicated versions), each\n"
        "kind with its own completion register; the originals are never changed.\n\n"
        f"study/{STUDY_CONFIG_FILENAME} holds the study's settings, study/audit_log.jsonl every change an\n"
        "administrator made (oldest first, one JSON object a line), and study/manifests.json the description\n"
        "of each registered recording (its fingerprint, timing, channels and events). The EEG files\n"
        "themselves never reached the study.\n\n"
        "Analyse the results with ElectroTag's commands, for example:\n"
        f"  electrotag-agreement {base} --config agreement_settings.json\n"
        f"  electrotag-activity {base}\n"
        "where agreement_settings.json is The settings used (JSON) of an agreement report in the admin area.\n"
    )


def _visit_id_of(path: Path) -> str:
    try:
        with open(path, encoding="utf-8") as fh:
            return str(json.loads(fh.readline()).get("visit_id", ""))
    except (OSError, ValueError):
        return ""
