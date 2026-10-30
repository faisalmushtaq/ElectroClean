"""Tracking: who has been given, has opened and has saved which study recordings, and when (docs/web/api.md,
"Datasets, collections, groups and hand-outs"). Every figure is derived from the assignments, the completion
register, the drafts, the visit index and the reports of recordings that cannot be annotated; nothing new is stored.

The study is read once per build (:class:`TrackingIndex`): the light rows of the manifests (never their blobs), the
assignments, the completion register, each person's draft keys, the active "cannot be annotated" reports, the
openings of the visit index, the training gate of each person and the records of datasets, collections, hand-outs
and tasks. On Firestore the built index is kept for :data:`TRACKING_CACHE_S` on the service instance, forgotten
after every administrative change made through it (:meth:`Tracking.forget`, called by ``Admin.run``) and bypassed
by ``"refresh": true``; the answers say ``generated_at`` and ``cached``.

The notices that would be sent (datasets and collections newly fully rated, people with overdue work, a weekly
summary the team can copy) are computed here too, for the admin area to list (:meth:`Tracking.notices`,
``notify_preview_get``). Nothing is sent: email notices wait for a choice of email service and a check of the ethics
approval and data protection arrangements (HANDOVER.md). A notifier would send what :meth:`Tracking.notices`
returns.
"""

from __future__ import annotations

import csv
import io
import json
import threading
import time
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import TYPE_CHECKING, Any

from electrotag.web import datasets as datasets_mod
from electrotag.web.errors import ApiError
from electrotag.web.store import User, attempt_of, item_key, parse_roles

if TYPE_CHECKING:
    from electrotag.web.service import StudyService

#: How long a Firestore study keeps a built index on the service instance (the files store builds afresh).
TRACKING_CACHE_S = 120.0
#: The status of one (person, recording) cell, in order of precedence (docs/web/api.md).
STATUSES = ("set_aside", "revised", "saved", "locked", "in_progress", "opened", "given", "not_given")
KINDS = ("dataset", "collection", "handout")
LIMIT_MAX = 1000
#: "Newly" fully rated: within this many days, today included.
RECENT_DAYS = 7
NOTICE_KINDS = ("weekly", "complete", "overdue", "all")
#: The long format of one cell (the Tracking tab's CSV and ``datasets/tracking.tsv``).
CELL_COLUMNS = ("target_kind", "target_id", "recording_id", "file_name", "dataset_id", "annotator_id", "status",
                "assigned_at", "assigned_by", "handout_id", "task_id", "opened_at", "first_saved_at", "saved_at",
                "version", "set_aside_at", "due_at", "overdue", "n_rated", "generated_at")
FINISHED = ("set_aside", "revised", "saved")


def _bad(message: str) -> ApiError:
    return ApiError(400, "bad_request", message)


def day_long(day: str) -> str:
    """``Friday 20 November``."""
    d = date.fromisoformat(day)
    return f"{d.strftime('%A')} {datasets_mod.day_words(day)}"


def _count(n: int, word: str, plural: str | None = None) -> str:
    return f"{n:,} {word if n == 1 else (plural or word + 's')}"


@dataclass
class TrackingIndex:
    """Everything the tracking reads of the study, read once (see the module docstring)."""

    generated_at: str
    today: date
    built: float
    study_name: str
    heads: dict[str, dict[str, Any]]  # rid -> light manifest row (effective dataset_id), in recording ID order
    people: list[dict[str, Any]]  # the columns: annotators, and anyone who holds or saved study work
    names: dict[str, str]  # aid -> display name (every account)
    team: list[str]  # the active administrators (who the team's notices would go to)
    given: dict[tuple[str, str], tuple[str, str, str]]  # (aid, rid) -> (task_id, handout_id, assigned_at)
    saved: dict[tuple[str, str], dict[str, Any]]  # (aid, rid) -> {"first", "last", "version"}
    drafts: set[tuple[str, str]]
    set_aside: dict[tuple[str, str], str]  # (aid, rid) -> changed_at
    opened: dict[tuple[str, str], tuple[str, str]]  # (aid, rid) -> (first, last)
    locked: set[str]  # people whose study work waits for the competency assessment
    rated: dict[str, int]  # rid -> distinct people who saved it
    n_given: dict[str, int]
    reached: dict[str, list[str]]  # rid -> each person's first save, earliest first
    datasets: list[dict[str, Any]]  # records (the built-in one included), removed ones left out
    collections: list[dict[str, Any]]
    handouts: list[dict[str, Any]]  # every hand-out record, newest first
    handout_out: dict[str, dict[str, Any]]  # hid -> HandoutOut
    covered: dict[str, dict[str, list[str]]]  # hid -> aid -> rids
    covering: dict[tuple[str, str], list[str]]  # (aid, rid) -> open hand-outs covering it, earliest due first
    tasks: dict[str, dict[str, Any]]
    saves_week: int = 0
    savers_week: int = 0
    _cells: dict[tuple[str, str], dict[str, Any]] = field(default_factory=dict)

    # ------------------------------------------------------------- targets
    def target(self, kind: str, tid: str) -> dict[str, Any] | None:
        """``{"kind", "id", "name", "rids", "ratings_target", "pairs": None | aid -> set(rid), "record"}``."""
        if kind == "dataset":
            rec = next((d for d in self.datasets if d["dataset_id"] == tid), None)
            if rec is None:
                return None
            rids = [r for r, h in self.heads.items() if h["dataset_id"] == tid]
            return {"kind": kind, "id": tid, "name": rec.get("name", ""), "rids": rids, "pairs": None, "record": rec,
                    "ratings_target": int(rec.get("ratings_target") or datasets_mod.RATINGS_TARGET)}
        if kind == "collection":
            rec = next((c for c in self.collections if c["collection_id"] == tid), None)
            if rec is None:
                return None
            rids = [r for r in rec.get("recording_ids", []) if r in self.heads]
            return {"kind": kind, "id": tid, "name": rec.get("name", ""), "rids": rids, "pairs": None, "record": rec,
                    "ratings_target": int(rec.get("ratings_target") or datasets_mod.RATINGS_TARGET)}
        rec = next((h for h in self.handouts if h["handout_id"] == tid), None)
        if rec is None:
            return None
        inner = self.target(rec["target"]["kind"], rec["target"]["id"])
        cov = self.covered.get(tid, {})
        order = list(inner["rids"]) if inner else []
        union = {r for rs in cov.values() for r in rs if r in self.heads}
        rids = [r for r in order if r in union] + sorted(union - set(order))
        return {"kind": kind, "id": tid, "name": rec.get("name", ""), "rids": rids, "record": rec,
                "pairs": {a: set(rs) for a, rs in cov.items()},
                "ratings_target": inner["ratings_target"] if inner else datasets_mod.RATINGS_TARGET}

    # ------------------------------------------------------------- one cell
    def cell(self, aid: str, rid: str) -> dict[str, Any]:
        """The ``Cell`` of one person and one study recording (docs/web/api.md)."""
        key = (aid, rid)
        done = self._cells.get(key)
        if done is not None:
            return done
        held = self.given.get(key)
        saved = self.saved.get(key)
        aside = self.set_aside.get(key)
        opened = self.opened.get(key)
        if aside is not None:
            status = "set_aside"
        elif saved is not None:
            status = "revised" if saved["version"] >= 2 else "saved"
        elif held is None:
            status = "not_given"
        elif aid in self.locked:
            status = "locked"
        elif key in self.drafts:
            status = "in_progress"
        elif opened is not None:
            status = "opened"
        else:
            status = "given"
        hids = self.covering.get(key, [])
        hid = (held[1] if held and held[1] else "") or (hids[0] if hids else "")
        assigned_at = (held[2] or None) if held else None
        assigned_by = None
        if hid:
            rec = self.handout_out.get(hid)
            row = next((r for r in (rec or {}).get("recipients", []) if r["annotator_id"] == aid), None)
            if row is not None:
                assigned_at = assigned_at or row.get("given_at") or None
                assigned_by = row.get("given_by") or (rec or {}).get("handed_out_by") or None
        if held and held[0] and assigned_by is None:
            assigned_by = (self.tasks.get(held[0]) or {}).get("created_by") or None
        dues = [self.handout_out[h]["due_at"] for h in hids if self.handout_out[h]["due_at"]]
        due_at = min(dues) if dues else None
        overdue = status not in FINISHED and held is not None and any(
            d and self.today > date.fromisoformat(d) for d in dues)
        out = {"status": status, "assigned_at": assigned_at if held else None,
               "assigned_by": assigned_by if held else None, "handout_id": hid or None,
               "task_id": (held[0] or None) if held else None, "opened_at": opened[1] if opened else None,
               "first_saved_at": saved["first"] if saved else None, "saved_at": saved["last"] if saved else None,
               "version": saved["version"] if saved else None, "set_aside_at": aside, "due_at": due_at,
               "overdue": bool(overdue)}
        self._cells[key] = out
        return out

    # ------------------------------------------------------------- one row of the summary
    def summary_row(self, t: dict[str, Any]) -> dict[str, Any]:
        rids = t["rids"]
        members = set(rids)
        live = [r for r in rids if not self.heads[r]["retired"]]
        target_n = t["ratings_target"]
        n_rated = sum(1 for r in live if self.rated.get(r, 0) >= target_n)
        cells = {}
        for p in self.people:
            aid = p["annotator_id"]
            c = {"given": 0, "opened": 0, "in_progress": 0, "saved": 0, "revised": 0, "set_aside": 0, "locked": 0,
                 "first_assigned_at": None, "last_saved_at": None, "due_at": None, "overdue": 0}
            mine = t["pairs"].get(aid, set()) if t["pairs"] is not None else None
            for rid in rids:
                if mine is not None and rid not in mine:
                    continue
                x = self.cell(aid, rid)
                if x["status"] == "not_given":
                    continue
                c["given"] += 1
                c["opened"] += int(x["opened_at"] is not None)
                c["in_progress"] += int(x["status"] == "in_progress")
                c["saved"] += int(x["saved_at"] is not None)
                c["revised"] += int(x["status"] == "revised")
                c["set_aside"] += int(x["status"] == "set_aside")
                c["locked"] += int(x["status"] == "locked")
                c["overdue"] += int(x["overdue"])
                if x["assigned_at"] and (c["first_assigned_at"] is None or x["assigned_at"] < c["first_assigned_at"]):
                    c["first_assigned_at"] = x["assigned_at"]
                if x["saved_at"] and (c["last_saved_at"] is None or x["saved_at"] > c["last_saved_at"]):
                    c["last_saved_at"] = x["saved_at"]
                if x["due_at"] and (c["due_at"] is None or x["due_at"] < c["due_at"]):
                    c["due_at"] = x["due_at"]
            cells[aid] = c
        row = {"kind": t["kind"], "id": t["id"], "name": t["name"], "n_recordings": len(rids),
               "n_retired": len(rids) - len(live), "ratings_target": target_n,
               "ratings": datasets_mod.ratings_histogram(rids, self.rated), "n_rated": n_rated,
               "n_set_aside": sum(1 for (_a, r) in self.set_aside if r in members),
               "state": t["record"].get("state", "open" if t["kind"] == "handout" else "active"), "cells": cells}
        if t["kind"] == "handout":
            h = self.handout_out[t["id"]]
            row.update(complete=h["complete"], title=h["title"], due_at=h["due_at"], mode=h["mode"], k=h["k"],
                       target={k: h["target"][k] for k in ("kind", "id", "name")},
                       overdue_people=h["counts"]["overdue_people"])
        else:
            row["complete"] = bool(live) and n_rated == len(live)
        return row

    def fully_rated_at(self, t: dict[str, Any]) -> str | None:
        """When a fully rated target met its target: the moment its last recording in use reached it."""
        live = [r for r in t["rids"] if not self.heads[r]["retired"]]
        n = t["ratings_target"]
        if not live or any(self.rated.get(r, 0) < n for r in live):
            return None
        return max(self.reached[r][n - 1] for r in live)

    def targets(self, kinds: tuple[str, ...]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        if "dataset" in kinds:
            out += [t for d in self.datasets if (t := self.target("dataset", d["dataset_id"])) is not None]
        if "collection" in kinds:
            out += [t for c in self.collections if (t := self.target("collection", c["collection_id"])) is not None]
        if "handout" in kinds:
            out += [t for h in self.handouts if (t := self.target("handout", h["handout_id"])) is not None]
        return out


def build_index(service: StudyService) -> TrackingIndex:
    """Read the study once (see the module docstring)."""
    from electrotag.web.datasets import Progress

    store = service.store
    ds = service.datasets
    generated_at, today = datasets_mod._now(), datasets_mod.today()
    with ds.reading():
        heads = {h["recording_id"]: h for h in ds.heads()}
        given: dict[tuple[str, str], tuple[str, str, str]] = {}
        held: dict[str, dict[str, tuple[str, str]]] = {}
        n_given: dict[str, int] = {}
        for a in store.assignments():
            if a.mode != "standard" or a.context_id:
                continue
            aid = a.annotator_id.upper()
            given[(aid, a.recording_id)] = (a.task_id, a.handout_id, a.assigned_at)
            held.setdefault(aid, {})[a.recording_id] = (a.task_id, a.handout_id)
            n_given[a.recording_id] = n_given.get(a.recording_id, 0) + 1
        saved: dict[tuple[str, str], dict[str, Any]] = {}
        week_from = (today - timedelta(days=RECENT_DAYS - 1)).isoformat()
        saves_week, savers_week = 0, set()
        for e in store.completion_entries():
            if e.get("status") != "completed" or e.get("mode", "standard") != "standard" or e.get("context"):
                continue
            key = (str(e.get("annotator_id", "")).upper(), e["recording_id"])
            at = str(e.get("completed_at") or "")
            s = saved.setdefault(key, {"first": at, "last": at, "version": 0})
            s["first"], s["last"] = min(s["first"], at), max(s["last"], at)
            s["version"] = max(s["version"], attempt_of(e))
            if at[:10] >= week_from:
                saves_week += 1
                savers_week.add(key[0])
        rated: dict[str, int] = {}
        reached: dict[str, list[str]] = {}
        for (_aid, rid), s in saved.items():
            rated[rid] = rated.get(rid, 0) + 1
            reached.setdefault(rid, []).append(s["first"])
        for v in reached.values():
            v.sort()
        set_aside: dict[tuple[str, str], str] = {}
        unusable: set[tuple[str, str]] = set()
        for r in store.records("unusable"):
            if not r.get("active") or not isinstance(r.get("key"), str):
                continue
            aid = str(r.get("annotator_id", "")).upper()
            unusable.add((aid, r["key"]))
            if r.get("mode", "standard") == "standard" and not r.get("context_id") and r.get("recording_id"):
                set_aside[(aid, r["recording_id"])] = str(r.get("changed_at") or "") or generated_at
        opened: dict[tuple[str, str], tuple[str, str]] = {}
        for o in store.opened_index():
            if o.get("mode", "standard") != "standard":
                continue
            key = (str(o["annotator_id"]).upper(), o["recording_id"])
            at = str(o.get("opened_at") or "")
            first, last = opened.get(key, (at, at))
            opened[key] = (min(first, at), max(last, at))
        # the people: every annotator, and anyone else who holds or saved study work
        from electrotag.web.admin import _rec_roles

        accounts = {r["annotator_id"].upper(): r for r in store.user_records()}
        names = {aid: r.get("display_name", "") for aid, r in accounts.items()}
        team = sorted(aid for aid, r in accounts.items() if "admin" in _rec_roles(r)
                      and r.get("status", "active") == "active")
        aids = {aid for aid, r in accounts.items() if "annotator" in _rec_roles(r)}
        aids |= {a for a, _r in given} | {a for a, _r in saved}
        people = []
        for aid in sorted(aids):
            rec = accounts.get(aid)
            people.append({"annotator_id": aid, "display_name": (rec or {}).get("display_name", ""),
                           "roles": list(_rec_roles(rec)) if rec else [],
                           "status": rec.get("status", "active") if rec else "removed"})
        drafts: set[tuple[str, str]] = set()
        draft_keys: dict[str, set[str]] = {}
        locked: set[str] = set()
        holders = {a for a, _r in given}
        wanted = {item_key(r, "standard", ""): r for r in heads}
        for p in people:
            aid = p["annotator_id"]
            if p["status"] == "removed":
                draft_keys[aid] = set()
                continue
            keys = store.draft_keys(aid)
            draft_keys[aid] = keys
            drafts |= {(aid, wanted[k]) for k in keys if k in wanted}
            person = User(aid, p["display_name"], roles=parse_roles(p["roles"] or None))
            if aid in holders and not service.training_path.gate(person)["open"]:
                locked.add(aid)
        # the records: datasets, collections, hand-outs and tasks
        datasets = ds.all_datasets()
        collections = sorted((c for c in store.records("collections") if c.get("state") != "removed"
                              and c.get("collection_id")), key=lambda c: str(c.get("name", "")).lower())
        handouts = sorted((h for h in store.records("handouts") if h.get("handout_id")),
                          key=lambda h: str(h.get("handed_out_at", "")), reverse=True)
        task_list = service.tasks.all()
        progress = Progress(service, saved={k: s["version"] for k, s in saved.items()}, unusable=unusable,
                            _drafts=draft_keys, _opened=set(opened))
        h_out: dict[str, dict[str, Any]] = {}
        covered: dict[str, dict[str, list[str]]] = {}
        covering: dict[tuple[str, str], list[str]] = {}
        for h in handouts:
            hid = h["handout_id"]
            h_out[hid] = ds.handout_out(h, progress, held=held, tasks=task_list)
            try:
                target_rids = ds.target_of(h["target"], active=False)["rids"]
            except ApiError:
                target_rids = []
            covered[hid] = ds.covered(h, held=held, tasks=task_list, target_rids=target_rids)
            if h.get("state") == "open":
                for aid, rids in covered[hid].items():
                    for rid in rids:
                        covering.setdefault((aid.upper(), rid), []).append(hid)
        for hids in covering.values():
            hids.sort(key=lambda x: (h_out[x]["due_at"] or "9999-12-31", h_out[x]["handed_out_at"]))
    return TrackingIndex(
        generated_at=generated_at, today=today, built=time.monotonic(), study_name=store.name, heads=heads,
        people=people, names=names, team=team, given=given, saved=saved, drafts=drafts, set_aside=set_aside,
        opened=opened, locked=locked, rated=rated, n_given=n_given, reached=reached, datasets=datasets,
        collections=collections, handouts=handouts, handout_out=h_out, covered=covered, covering=covering,
        tasks={t["task_id"]: t for t in task_list}, saves_week=saves_week, savers_week=len(savers_week))


class Tracking:
    """The tracking reads of the admin area (``Admin.op_<name>`` delegates here)."""

    def __init__(self, service: StudyService) -> None:
        self.service = service
        self._lock = threading.Lock()
        self._index: TrackingIndex | None = None
        #: Seconds a built index is kept (Firestore only: the files store reads its own disk quickly).
        self.cache_s = TRACKING_CACHE_S if getattr(service.store, "kind", "") == "firestore" else 0.0

    def forget(self) -> None:
        """Drop what this instance keeps of the figures (called after every administrative change)."""
        with self._lock:
            self._index = None

    def index(self, refresh: bool = False) -> tuple[TrackingIndex, bool]:
        """The study's tracking index and whether it came from the cache."""
        with self._lock:
            idx = self._index
            if (not refresh and idx is not None and self.cache_s > 0
                    and time.monotonic() - idx.built < self.cache_s):
                return idx, True
        idx = build_index(self.service)
        with self._lock:
            self._index = idx if self.cache_s > 0 else None
        return idx, False

    @staticmethod
    def _refresh(body: dict[str, Any]) -> bool:
        value = body.get("refresh", False)
        if not isinstance(value, bool):
            raise _bad("refresh must be true or false")
        return value

    # ------------------------------------------------------------- the datasets x people summary
    def op_tracking_datasets_get(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        kind = body.get("kind")
        if kind is not None and kind not in (*KINDS, "all"):
            raise _bad("kind must be 'dataset', 'collection', 'handout' or 'all'")
        idx, cached = self.index(self._refresh(body))
        kinds = KINDS if kind in (None, "all") else (kind,)
        return {"generated_at": idx.generated_at, "cached": cached, "today": idx.today.isoformat(),
                "people": [dict(p) for p in idx.people], "rows": [idx.summary_row(t) for t in idx.targets(kinds)]}

    # ------------------------------------------------------------- the recordings x people grid
    def op_tracking_recordings_get(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        from electrotag.web.admin import _aid, _bool

        kind, tid = body.get("kind"), body.get("id")
        if kind not in KINDS:
            raise _bad("kind must be 'dataset', 'collection' or 'handout'")
        if not isinstance(tid, str) or not tid:
            raise _bad("id is missing")
        status = body.get("status")
        if status is not None and status not in STATUSES:
            raise _bad("status must be one of " + ", ".join(STATUSES))
        overdue, rated = _bool(body, "overdue"), _bool(body, "rated")
        query = body.get("query")
        if query is not None and (not isinstance(query, str) or len(query) > 200):
            raise _bad("query must be text of at most 200 characters")
        offset, limit = body.get("offset", 0), body.get("limit", LIMIT_MAX)
        if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
            raise _bad("offset must be a whole number, 0 or more")
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= LIMIT_MAX:
            raise _bad(f"limit must be a whole number from 1 to {LIMIT_MAX:,}")
        idx, cached = self.index(self._refresh(body))
        t = idx.target(kind, tid)
        if t is None and cached:  # made since the figures were read, through another instance
            idx, cached = self.index(True)
            t = idx.target(kind, tid)
        if t is None:
            raise {"dataset": ApiError(404, "unknown_dataset", f"This study has no dataset {tid!r}"),
                   "collection": ApiError(404, "unknown_collection", f"This study has no collection {tid!r}"),
                   "handout": ApiError(404, "unknown_handout", f"This study has no hand-out {tid!r}")}[kind]
        people = idx.people
        if t["pairs"] is not None:
            people = [p for p in people if p["annotator_id"] in t["pairs"]]
        if body.get("annotator_id") is not None:
            aid = _aid(body["annotator_id"])
            people = [p for p in idx.people if p["annotator_id"] == aid]
            if not people:
                raise ApiError(404, "unknown_user", f"{aid} has no study work and is no annotator of this study")
        needle = (query or "").strip().lower()
        n = t["ratings_target"]
        filtering = status is not None or overdue is not None

        def cells_of(rid: str) -> dict[str, Any]:
            return {p["annotator_id"]: (idx.cell(p["annotator_id"], rid) if t["pairs"] is None
                                        or rid in t["pairs"].get(p["annotator_id"], set()) else None)
                    for p in people}

        rows: list[tuple[str, dict[str, Any], dict[str, Any] | None]] = []
        for rid in t["rids"]:
            h = idx.heads[rid]
            if needle and needle not in rid.lower() and needle not in str(h.get("file_name", "")).lower():
                continue
            if rated is not None and (idx.rated.get(rid, 0) >= n) != rated:
                continue
            cells = None
            if filtering:  # otherwise the cells of the page only are made
                cells = cells_of(rid)
                shown = [c for c in cells.values() if c is not None]
                if status is not None and not any(c["status"] == status for c in shown):
                    continue
                if overdue is not None and any(c["overdue"] for c in shown) != overdue:
                    continue
            rows.append((rid, h, cells))
        page = rows[offset:offset + limit]
        return {"generated_at": idx.generated_at, "cached": cached, "today": idx.today.isoformat(),
                "target": {"kind": kind, "id": tid, "name": t["name"]}, "ratings_target": n,
                "people": [dict(p) for p in people], "total": len(rows), "offset": offset,
                "next": offset + limit if offset + limit < len(rows) else None,
                "rows": [{"recording_id": rid, "file_name": h.get("file_name", ""), "dataset_id": h["dataset_id"],
                          "retired": bool(h["retired"]), "n_given": idx.n_given.get(rid, 0),
                          "n_rated": idx.rated.get(rid, 0), "ratings_target": n,
                          "rated": idx.rated.get(rid, 0) >= n,
                          "n_set_aside": sum(1 for p in idx.people if (p["annotator_id"], rid) in idx.set_aside),
                          "cells": {a: (dict(c) if c is not None else None)
                                    for a, c in (cells if cells is not None else cells_of(rid)).items()}}
                         for rid, h, cells in page]}

    # ------------------------------------------------------------- what would be notified
    def op_notify_preview_get(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        kind = body.get("kind", "all")
        if kind not in NOTICE_KINDS:
            raise _bad("kind must be 'weekly', 'complete', 'overdue' or 'all'")
        idx, cached = self.index(self._refresh(body))
        return {"generated_at": idx.generated_at, "cached": cached, "today": idx.today.isoformat(),
                "notices": self.notices(idx, kind), "sent": False}

    def notices(self, idx: TrackingIndex, kind: str = "all") -> list[dict[str, Any]]:
        """What a notifier would send now: ``{"notice_id", "kind", "to": [aid], "subject", "text"}``. The
        ``notice_id`` is the key a notifier would send each notice under once."""
        out: list[dict[str, Any]] = []
        if kind in ("complete", "all"):
            out += self._complete_notices(idx)
        if kind in ("overdue", "all"):
            out += self._overdue_notices(idx)
        if kind in ("weekly", "all"):
            out.append(self._weekly_notice(idx))
        return out

    def _complete_notices(self, idx: TrackingIndex) -> list[dict[str, Any]]:
        since = (idx.today - timedelta(days=RECENT_DAYS - 1)).isoformat()
        out = []
        for t in idx.targets(("dataset", "collection")):
            at = idx.fully_rated_at(t)
            if at is None or at[:10] < since:
                continue
            live = sum(1 for r in t["rids"] if not idx.heads[r]["retired"])
            what = "dataset" if t["kind"] == "dataset" else "collection"
            out.append({"notice_id": f"{what}-complete-{t['id']}", "kind": "complete", "to": list(idx.team),
                        "subject": f"The {what} {t['name']} is fully rated",
                        "text": (f"The {what} {t['name']} in the study {idx.study_name} is fully rated: "
                                 f"each of its {_count(live, 'recording')} in use has been saved by at least "
                                 f"{_count(t['ratings_target'], 'person', 'people')}. The last of them reached "
                                 f"its target on {day_long(at[:10])}.\n")})
        return out

    def _overdue_notices(self, idx: TrackingIndex) -> list[dict[str, Any]]:
        """One reminder per person and overdue hand-out, as the annotator would read it: the hand-out's title,
        how many recordings remain and the due date; never a recording's name nor anyone else's."""
        out = []
        for h in idx.handouts:
            o = idx.handout_out[h["handout_id"]]
            if o["state"] != "open":
                continue
            for p in o["per_person"]:
                if not p["overdue"]:
                    continue
                left = _count(p["remaining"], "recording")
                out.append({"notice_id": f"overdue-{o['handout_id']}-{p['annotator_id']}", "kind": "overdue",
                            "to": [p["annotator_id"]], "subject": f"{o['title']}: {left} still to annotate",
                            "text": (f"This is a reminder from the study {idx.study_name}. {left} of "
                                     f"{o['title']} {'is' if p['remaining'] == 1 else 'are'} still to annotate; "
                                     f"they were due on {day_long(o['due_at'])}. Open ElectroTag to carry on, or "
                                     "tell the study team if something is in the way.\n")})
        return out

    def _weekly_notice(self, idx: TrackingIndex) -> dict[str, Any]:
        year, week, _day = idx.today.isocalendar()
        lines = [f"{idx.study_name}: the week to {day_long(idx.today.isoformat())}", "",
                 f"Saved in the last {RECENT_DAYS} days: {_count(idx.saves_week, 'recording')} by "
                 f"{_count(idx.savers_week, 'person', 'people')}.", ""]
        open_ = [h for h in idx.handouts if idx.handout_out[h["handout_id"]]["state"] == "open"]
        lines.append("Hand-outs" if open_ else "No hand-outs are open.")
        for h in open_:
            o = idx.handout_out[h["handout_id"]]
            c = o["counts"]
            due = f", due {day_long(o['due_at'])}" if o["due_at"] else ""
            late = [p["annotator_id"] for p in o["per_person"] if p["overdue"]]
            who = ", ".join(f"{a} ({idx.names[a]})" if idx.names.get(a) else a for a in late)
            lines.append(f"- {o['name']} ({o['target']['kind']} {o['target']['name']}{due}): {c['given']:,} given, "
                         f"{c['saved']:,} saved, {c['set_aside']:,} set aside"
                         + (". Complete." if o["complete"] else ".")
                         + (f" Overdue: {who}." if late else ""))
        lines += ["", "Datasets and collections"]
        for t in idx.targets(("dataset", "collection")):
            live = [r for r in t["rids"] if not idx.heads[r]["retired"]]
            if not live:
                continue
            n = sum(1 for r in live if idx.rated.get(r, 0) >= t["ratings_target"])
            what = "" if t["kind"] == "dataset" else "collection "
            state = "fully rated" if n == len(live) else (
                f"{n:,} of {_count(len(live), 'recording')} rated by "
                f"{_count(t['ratings_target'], 'person', 'people')} or more")
            lines.append(f"- {what}{t['name']}: {state}.")
        return {"notice_id": f"weekly-{year}-W{week:02d}", "kind": "weekly", "to": list(idx.team),
                "subject": f"{idx.study_name}: the week to {datasets_mod.day_words(idx.today.isoformat())}",
                "text": "\n".join(lines) + "\n"}


# ---------------------------------------------------------------------- the results folder
def _tsv(columns: tuple[str, ...], rows: list[dict[str, Any]]) -> bytes:
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=list(columns), delimiter="\t", lineterminator="\n", extrasaction="ignore")
    w.writeheader()
    for r in rows:
        w.writerow({k: _cell_text(r.get(k)) for k in columns})
    return buf.getvalue().encode("utf-8")


def _cell_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value).replace("\t", " ").replace("\r", " ").replace("\n", " ")


def _json(obj: Any) -> bytes:
    return (json.dumps(obj, indent=1, ensure_ascii=False, sort_keys=False) + "\n").encode("utf-8")


DATASET_COLUMNS = ("dataset_id", "name", "state", "default", "origin", "licence", "citation", "contact",
                   "path_prefix", "ratings_target", "n_recordings", "n_retired", "formats", "sfreq",
                   "n_channels_min", "n_channels_max", "duration_s", "size_bytes", "first_registered_at",
                   "last_registered_at", "n_handouts", "n_rated", "fully_rated", "created_at", "created_by",
                   "updated_at")
MEMBER_COLUMNS = ("group_id", "group_name", "annotator_id", "added_at", "added_by", "removed_at", "removed_by")
HANDOUT_COLUMNS = ("handout_id", "name", "title", "target_kind", "target_id", "target_name", "mode", "k", "due_at",
                   "state", "handed_out_at", "handed_out_by", "people", "groups", "follow_groups", "recipients",
                   "given", "saved", "set_aside", "overdue_people", "complete")
RATING_COLUMNS = ("recording_id", "dataset_id", "retired", "n_given", "n_rated", "n_set_aside")


def dataset_files(store: Any) -> dict[str, bytes]:
    """The datasets, collections, groups and hand-outs, and the tracking of them as it stands now, as files of
    the results folder under ``datasets/`` (docs/file_formats.md). Removed datasets, collections and groups are
    kept, marked ``removed``; nothing names a person other than by annotator ID."""
    from electrotag.web.service import StudyService

    service = StudyService(store)
    ds = service.datasets
    idx = build_index(service)
    stamp = idx.generated_at
    out: dict[str, bytes] = {}
    with ds.reading():
        heads = list(idx.heads.values())
        handouts = store.records("handouts")
        records = {r["dataset_id"]: r for r in store.records("datasets") if r.get("dataset_id")}
        records.setdefault(datasets_mod.DEFAULT_DATASET_ID, ds._virtual_default())
        dsets = []
        for rec in sorted(records.values(), key=lambda r: (not r.get("default"), str(r.get("dataset_id")))):
            shown = ds._dataset_out(rec, heads, idx.rated, handouts)
            dsets.append({**{k: v for k, v in rec.items() if k != "request_id"}, **shown,
                          "state": rec.get("state", "active")})
        out["datasets/datasets.json"] = _json({"schema": "electrotag.datasets", "schema_version": 1,
                                               "generated_at": stamp, "datasets": dsets})
        rows = []
        for d in dsets:
            s = d["summary"]
            rows.append({**d, **{k: s[k] for k in ("n_recordings", "n_retired", "duration_s", "size_bytes",
                                                   "first_registered_at", "last_registered_at")},
                         "formats": ",".join(f"{f}:{n}" for f, n in sorted(s["formats"].items())),
                         "sfreq": ",".join(f"{f:g}" for f in s["sfreq"]),
                         "n_channels_min": s["n_channels"]["min"], "n_channels_max": s["n_channels"]["max"]})
        out["datasets/datasets.tsv"] = _tsv(DATASET_COLUMNS, rows)
        by_id = {h["recording_id"]: h for h in heads}
        colls = []
        for rec in sorted(store.records("collections"), key=lambda r: str(r.get("collection_id"))):
            if not rec.get("collection_id"):
                continue
            shown = ds._collection_out(rec, by_id, idx.rated, ids=True)
            colls.append({**{k: v for k, v in rec.items() if k != "request_id"}, **shown,
                          "state": rec.get("state", "active")})
        out["datasets/collections.json"] = _json({"schema": "electrotag.collections", "schema_version": 1,
                                                  "generated_at": stamp, "collections": colls})
        groups = sorted((g for g in store.records("groups") if g.get("group_id")), key=lambda g: g["group_id"])
        out["datasets/groups.json"] = _json({"schema": "electrotag.groups", "schema_version": 1,
                                             "generated_at": stamp,
                                             "groups": [{k: v for k, v in g.items() if k != "request_id"}
                                                        for g in groups]})
        out["datasets/group_members.tsv"] = _tsv(MEMBER_COLUMNS, [
            {**r, "group_id": g["group_id"], "group_name": g.get("name", "")}
            for g in groups for r in g.get("history", [])])
        hs = []
        hrows = []
        for h in sorted(idx.handouts, key=lambda h: str(h.get("handed_out_at", ""))):
            o = idx.handout_out[h["handout_id"]]
            hs.append({**{k: v for k, v in h.items() if k not in ("request_id", "linked")},
                       "progress": {k: o[k] for k in ("counts", "per_person", "complete", "new_recordings",
                                                      "n_tasks")}})
            hrows.append({**o, "target_kind": o["target"]["kind"], "target_id": o["target"]["id"],
                          "target_name": o["target"]["name"], "people": ",".join(o["people"]),
                          "groups": ",".join(o["groups"]),
                          "recipients": ",".join(r["annotator_id"] for r in o["recipients"]),
                          **{k: o["counts"][k] for k in ("given", "saved", "set_aside", "overdue_people")}})
        out["datasets/handouts.json"] = _json({"schema": "electrotag.handouts", "schema_version": 1,
                                               "generated_at": stamp, "handouts": hs})
        out["datasets/handouts.tsv"] = _tsv(HANDOUT_COLUMNS, hrows)
    cells = []
    for t in idx.targets(KINDS):
        for rid in t["rids"]:
            h = idx.heads[rid]
            for p in idx.people:
                aid = p["annotator_id"]
                if t["pairs"] is not None and rid not in t["pairs"].get(aid, set()):
                    continue
                c = idx.cell(aid, rid)
                if c["status"] == "not_given":
                    continue
                cells.append({**c, "target_kind": t["kind"], "target_id": t["id"], "recording_id": rid,
                              "file_name": h.get("file_name", ""), "dataset_id": h["dataset_id"],
                              "annotator_id": aid, "n_rated": idx.rated.get(rid, 0), "generated_at": stamp})
    out["datasets/tracking.tsv"] = _tsv(CELL_COLUMNS, cells)
    out["datasets/recording_ratings.tsv"] = _tsv(RATING_COLUMNS, [
        {"recording_id": rid, "dataset_id": h["dataset_id"], "retired": bool(h["retired"]),
         "n_given": idx.n_given.get(rid, 0), "n_rated": idx.rated.get(rid, 0),
         "n_set_aside": sum(1 for p in idx.people if (p["annotator_id"], rid) in idx.set_aside)}
        for rid, h in idx.heads.items()])
    return out


__all__ = ["CELL_COLUMNS", "KINDS", "STATUSES", "TRACKING_CACHE_S", "Tracking", "TrackingIndex", "build_index",
           "dataset_files", "day_long"]
