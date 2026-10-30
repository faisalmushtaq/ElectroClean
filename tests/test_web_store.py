"""The storage interface's additions on the files store (electrotag/web/store_files.py).

Derived versions (corrections, adjudicated versions) are full journalled saves into trees of their
own, ``Annotated_Events/derived/<kind>/``, with their own completion registers, so they are never
anyone's attempt; saved attempts can be read by number; the competency status is read for the
training gate; and each visit keeps an index of the recordings it opened, with its log read in
pages. The same interface on Firestore is in test_web_firestore.py.
"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

from electrotag.app.io.naming import OutputLayout
from electrotag.app.session.register import CompletionRegister
from electrotag.web.service import StudyService
from electrotag.web.store import DERIVED_KINDS, StoreError, User, index_rows, page_of
from electrotag.web.store_files import FilesStore
from tests.web_helpers import SUB1, SUB2, ann, copy_demo, derived_maker, make_template, submission

BLINK = ann("b" * 32, "Eye-blink-artifact", 500, 100, ["Fp1", "Fp2"])
EMG = ann("c" * 32, "EMG-artifact", 3000, 250, [])
A01, E01 = User("A01", "Annotator one"), User("E01", "Expert one", roles=("annotator", "expert"))


@pytest.fixture(scope="module")
def template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_template(tmp_path_factory.mktemp("store-demo"))


@pytest.fixture
def study(template: Path, tmp_path: Path) -> Path:
    return copy_demo(template, tmp_path)


@pytest.fixture
def service(study: Path):
    svc = StudyService(FilesStore(study))
    yield svc
    svc.store.close()


def test_a_derived_version_is_saved_in_its_own_tree_and_is_nobodys_attempt(service: StudyService, study: Path,
                                                                           template: Path) -> None:
    store = service.store
    service.call("submit", A01, submission(template / "recordings", SUB1, [BLINK]))
    saved = store.save_derived("corrections", derived_maker(store, "A01", SUB1, [BLINK, EMG]), elapsed_s=12.5,
                               started_at="2026-10-30T10:00:00.000+00:00")
    assert saved.attempt == 1 and saved.result is not None
    tree = study / "Annotated_Events" / "derived" / "corrections"
    names = sorted(saved.files)
    assert len(names) == 5 and all(n.startswith("sub-001_task-rest_eeg_annotator-A01_") for n in names)
    assert sorted(p.name for p in (tree / "annotator-A01" / "sub-001" / "eeg").iterdir()) == names
    doc = json.loads(saved.files[next(n for n in names if n.endswith("_annotations.json"))])
    assert doc["session"]["context"]["derived"]["kind"] == "correction" and len(doc["annotations"]) == 2
    # its own completion register; the study's register, the annotator's attempts and work items are unchanged
    assert CompletionRegister(OutputLayout(tree)).is_completed(SUB1, "A01")
    assert [e["recording_id"] for e in store.derived_entries("corrections")] == [SUB1]
    assert store.derived_entries("corrections", "A02") == [] and store.derived_entries("adjudications") == []
    assert len([e for e in store.completion_entries("A01") if e["recording_id"] == SUB1]) == 1
    assert len(store.saved_files("A01", SUB1, "standard", "")) == 5
    assert json.loads(store.saved_document("A01", SUB1, "standard", ""))["annotations"][0]["label"] == BLINK["label"]
    # a second correction of the same work is the derived tree's next attempt
    second = store.save_derived("corrections", derived_maker(store, "A01", SUB1, [EMG], by="E02"), elapsed_s=3,
                                started_at="")
    assert second.attempt == 2 and any("_attempt-02_" in n for n in second.files)
    latest = store.derived_files("corrections", "A01", SUB1)
    assert json.loads(next(b for n, b in latest.items() if n.endswith("_annotations.json")))["annotations"][0][
        "label"] == "EMG-artifact"
    first = store.derived_files("corrections", "A01", SUB1, attempt=1)
    assert sorted(first) == names and store.derived_files("corrections", "A01", SUB1, attempt=3) == {}
    assert store.derived_files("corrections", "A01", SUB2) == {}
    with pytest.raises(StoreError):
        store.save_derived("drafts", derived_maker(store, "A01", SUB1, [EMG]), elapsed_s=0, started_at="")


def test_the_analyses_and_the_zip_keep_derived_versions_apart(service: StudyService, study: Path,
                                                              template: Path) -> None:
    from electrotag.reliability.config import AnalysisConfig
    from electrotag.reliability.data import load_dataset

    store = service.store
    service.call("submit", A01, submission(template / "recordings", SUB1, [BLINK]))
    service.call("submit", User("A02"), submission(template / "recordings", SUB1, [BLINK, EMG]))
    store.save_derived("corrections", derived_maker(store, "A01", SUB1, [EMG]), elapsed_s=1, started_at="")
    ds = load_dataset([study / "Annotated_Events"], AnalysisConfig())
    docs = ds.groups[SUB1].docs
    assert set(docs) == {"A01", "A02"} and len(docs["A01"].annotations) == 1  # the original, not the correction
    from electrotag.web.export import results_zip_file

    path = results_zip_file(store)
    try:
        names = zipfile.ZipFile(path).namelist()
    finally:
        path.unlink()
    assert "Annotated_Events/derived/corrections/completion_register.tsv" in names
    assert sum(n.startswith("Annotated_Events/derived/corrections/annotator-A01/sub-001/") for n in names) == 5
    assert not [n for n in names if "/.electrotag/" in n]


def test_an_interrupted_derived_save_is_rolled_forward_when_the_study_opens(service: StudyService, study: Path,
                                                                           monkeypatch: pytest.MonkeyPatch) -> None:
    import electrotag.web.saving as saving

    real = saving.WebSession.finish

    def finish(self, *, fault=None):
        def register_unavailable(stage: str) -> None:
            if stage == "register":
                raise OSError("the register is busy")

        return real(self, fault=register_unavailable)

    store = service.store
    monkeypatch.setattr(saving.WebSession, "finish", finish)
    monkeypatch.setattr(FilesStore, "recover_interrupted", lambda self: [])  # the server stopped at that moment
    saved = store.save_derived("corrections", derived_maker(store, "A01", SUB1, [EMG]), elapsed_s=1, started_at="")
    assert saved.result is None and store.derived_entries("corrections") == []
    monkeypatch.undo()
    again = FilesStore(study)  # the server starts again
    try:
        assert [(a["action"], a.get("derived")) for a in again.recovered] == [("rolled_forward", "corrections")]
        assert [e["recording_id"] for e in again.derived_entries("corrections")] == [SUB1]
        assert len(again.derived_files("corrections", "A01", SUB1)) == 5
        assert again.completion_entries("A01") == []  # never the annotator's own
        entries, _ = again.audit_page(None, 3)
        assert entries[0]["op"] == "save_recovered" and entries[0]["details"]["derived"] == "corrections"
    finally:
        again.close()


def test_saved_attempts_are_read_by_number(service: StudyService, template: Path) -> None:
    rec = template / "recordings"
    service.call("submit", A01, submission(rec, SUB1, [BLINK]))
    service.call("submit", A01, {**submission(rec, SUB1, [BLINK, EMG]), "revises": 1})
    store = service.store
    n = lambda f: len(json.loads(next(b for k, b in f.items() if k.endswith("_annotations.json")))["annotations"])  # noqa: E731
    assert n(store.saved_files("A01", SUB1, "standard", "")) == 2
    assert n(store.saved_files("A01", SUB1, "standard", "", attempt=1)) == 1
    assert n(store.saved_files("A01", SUB1, "standard", "", attempt=2)) == 2
    assert store.saved_files("A01", SUB1, "standard", "", attempt=3) == {}
    assert json.loads(store.saved_document("A01", SUB1, "standard", "", attempt=1))["annotations"][0]["annotation_id"] \
        == BLINK["annotation_id"]


def test_the_competency_status_is_read_for_the_gate(service: StudyService, study: Path) -> None:
    store = service.store
    assert store.report_status("example", "T01") == ""
    folder = study / "Annotated_Events" / "training" / "example" / "reports"
    folder.mkdir(parents=True)
    (folder / "annotator-T01_competency_report.json").write_text(json.dumps({"status": "met", "status_text": "Met"}))
    assert store.report_status("example", "T01") == "met"


def test_assignments_carry_their_task(service: StudyService) -> None:
    store = service.store
    assert all(a.task_id == "" for a in store.assignments("A01"))
    assert store.assign("E01", [SUB1], task_id="t-0123456789ab") == 1
    assert [(a.recording_id, a.task_id) for a in store.assignments("E01")] == [(SUB1, "t-0123456789ab")]


# ------------------------------------------------------------------ visit index and paging
OPENED = {"type": "recording_opened", "recording": SUB1, "window_no": 1, "session_id": "s" * 32, "mode": "standard"}


def test_the_index_rows_follow_the_events() -> None:
    ev = [{"seq": 2, "t": 1.0, **OPENED}, {"seq": 3, "t": 2.0, "type": "key", "window_no": 1},
          {"seq": 4, "t": 9.0, "type": "recording_finished", "window_no": 1},
          {"seq": 5, "t": 10.0, **OPENED, "window_no": 2, "recording": SUB2, "mode": "practice"},
          {"seq": 6, "t": 11.0, "type": "log_closed"}]
    rows = index_rows([], ev, "example")
    assert [(r["recording_id"], r["first_seq"], r["last_seq"], r["outcome"], r["context_id"]) for r in rows] == [
        (SUB1, 2, 4, "finished", ""), (SUB2, 5, 6, "", "example")]
    assert index_rows(rows[:1], ev[3:4], "") [1]["last_seq"] is None  # still open
    page, nxt = page_of(ev, 3, 2)
    assert [e["seq"] for e in page] == [3, 4] and nxt == 5
    assert page_of(ev, 5, 10) == (ev[3:], None)


def test_each_visit_keeps_an_index_of_the_recordings_it_opened(service: StudyService, study: Path) -> None:
    store = service.store
    v = service.call("visit_open", A01, {"client": {"user_agent": "pytest"}})["visit_id"]
    assert store.visit_index(v) == []
    service.call("visit_events", A01, {"visit_id": v, "events": [
        {"t": 1.0, "type": "recording_opened", "recording": SUB1, "window_no": 1, "session_id": "a" * 32,
         "mode": "standard"},
        {"t": 2.0, "type": "pointer", "recording": SUB1, "window_no": 1}]})
    rows = store.visit_index(v)
    assert len(rows) == 1 and rows[0]["recording_id"] == SUB1 and rows[0]["last_seq"] is None
    service.call("visit_events", A01, {"visit_id": v, "events": [
        {"t": 5.0, "type": "closed_without_saving", "recording": SUB1, "window_no": 1, "kept": True},
        {"t": 6.0, "type": "recording_opened", "recording": SUB2, "window_no": 2, "session_id": "b" * 32,
         "mode": "standard"}]})
    service.call("visit_close", A01, {"visit_id": v, "reason": "signed_out"})
    rows = store.visit_index(v)
    assert [(r["recording_id"], r["window_no"], r["outcome"]) for r in rows] == [
        (SUB1, 1, "closed_without_saving"), (SUB2, 2, "")]
    assert rows[0]["first_seq"] == 2 and rows[0]["last_seq"] == 4 and rows[1]["last_seq"] == 6
    assert store.visit_index("f" * 32) == []


def test_a_visit_logged_before_the_index_is_read_through(service: StudyService, study: Path) -> None:
    import sqlite3

    store = service.store
    v = service.call("visit_open", A01, {"client": {}})["visit_id"]
    service.call("visit_events", A01, {"visit_id": v, "events": [
        {"t": 1.0, "type": "recording_opened", "recording": SUB1, "window_no": 1, "mode": "standard"}]})
    con = sqlite3.connect(str(study / "server.sqlite"))
    with con:  # as a visit kept by an older server
        con.execute("UPDATE visits SET indexed=0 WHERE visit_id=?", (v,))
        con.execute("DELETE FROM visit_recordings WHERE visit_id=?", (v,))
    con.close()
    assert [r["recording_id"] for r in store.visit_index(v)] == [SUB1]


def test_a_visits_log_is_read_in_pages(service: StudyService) -> None:
    store = service.store
    v = service.call("visit_open", A01, {"client": {}})["visit_id"]
    service.call("visit_events", A01, {"visit_id": v, "events": [{"t": float(i), "type": "key"} for i in range(25)]})
    first = store.visit_log(v, from_seq=0, limit=10)
    assert first["header"]["visit_id"] == v and first["header"]["type"] == "header"
    assert [e["seq"] for e in first["events"]] == list(range(1, 11)) and first["next_seq"] == 11
    assert first["events"][0]["type"] == "visit_started"
    seen = [e["seq"] for e in first["events"]]
    nxt = first["next_seq"]
    while nxt is not None:
        page = store.visit_log(v, from_seq=nxt, limit=10)
        seen += [e["seq"] for e in page["events"]]
        nxt = page["next_seq"]
    assert seen == list(range(1, 27))
    assert store.visit_log(v, from_seq=100)["events"] == []
    with pytest.raises(StoreError):
        store.visit_log("0" * 32)


def test_the_derived_kinds() -> None:
    assert DERIVED_KINDS == ("corrections", "adjudications")
