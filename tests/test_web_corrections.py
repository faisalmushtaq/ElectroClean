"""Experts' corrections of saved work (electrotag/web/corrections.py, docs/web/api.md "Corrections and replay").

An expert corrects someone's saved attempt with a reason for each change; the correction is a
derived version (five files in derived/corrections with their own register, provenance in
context.derived), the original never changes, the same correction is kept once however often it is
sent, and the annotator sees the changes when the study shows them."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from electrotag.web import corrections  # noqa: E402
from electrotag.web.app import create_app  # noqa: E402
from electrotag.web.corrections import corrections_of, diff_annotations, needs_reason  # noqa: E402
from tests.web_helpers import SUB1, SUB2, Api, admin_audit, ann, copy_demo, make_template, submission  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
CASES = json.loads((REPO / "web_tests" / "unit" / "correction_diff_cases.json").read_text(encoding="utf-8"))["cases"]
BLINK = ann("b" * 32, "Eye-blink-artifact", 500, 100, ["Fp1", "Fp2"])
EMG = ann("c" * 32, "EMG-artifact", 3000, 250, [])
NEW = ann("e" * 32, "Chewing-artifact", 6000, 400, [])


def cid(n: int) -> str:
    return f"{n:032x}"


@pytest.fixture(scope="module")
def template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_template(tmp_path_factory.mktemp("web-corrections"))


@pytest.fixture
def study(template: Path, tmp_path: Path) -> Path:
    return copy_demo(template, tmp_path)


@pytest.fixture
def recordings(template: Path) -> Path:
    return template / "recordings"


@pytest.fixture
def app(study: Path):
    a = create_app(study, demo=True)
    yield a
    a.state.store.close()


@pytest.fixture
def client(app) -> TestClient:
    return TestClient(app)


@pytest.fixture
def admin(client: TestClient) -> Api:
    return Api(client, "ADMIN")


def expert(api: Api, op: str, body: dict | None = None):
    return api.post(f"/expert/{op}", body or {})


def expert_ok(api: Api, op: str, body: dict | None = None) -> dict:
    r = expert(api, op, body)
    assert r.status_code == 200, f"{op}: {r.status_code} {r.text}"
    return r.json()


def expert_error(api: Api, op: str, body: dict, status: int, code: str) -> dict:
    r = expert(api, op, body)
    assert (r.status_code, r.json().get("error")) == (status, code), f"{op}: {r.status_code} {r.text}"
    return r.json()


def correction(recordings: Path, n: int, annotations: list, reasons: dict, *, rid: str = SUB1, attempt: int = 1,
               aid: str = "A01", note: str = "") -> dict:
    sub = submission(recordings, rid, annotations, elapsed=95.0)
    return {"correction_id": cid(n), "annotator_id": aid, "recording_id": rid, "attempt": attempt,
            "annotations": annotations, "sha256": sub["sha256"], "session": sub["session"], "overall_note": note,
            "changes": [{"annotation_id": k, "reason": r, "note": "n" * 3} for k, r in reasons.items()]}


def checksums(folder: Path) -> dict[str, str]:
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(folder.iterdir())}


@pytest.fixture
def saved(client: TestClient, recordings: Path) -> Api:
    a01 = Api(client, "A01")
    a01.ok("post", "/submissions", submission(recordings, SUB1, [BLINK, EMG]))
    return a01


# ------------------------------------------------------------------ the difference
@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_the_difference_is_the_browsers(case: dict) -> None:
    got = [{k: c[k] for k in ("annotation_id", "change", "fields")} for c in diff_annotations(case["original"],
                                                                                              case["current"])]
    assert got == case["expected"]


def test_which_changes_need_a_reason() -> None:
    assert all(needs_reason(c, "always") for c in ("added", "removed", "changed"))
    assert [needs_reason(c, "edited_or_none") for c in ("added", "removed", "changed")] == [False, True, True]
    assert not any(needs_reason(c, "never") for c in ("added", "removed", "changed"))


# ------------------------------------------------------------------ saving a correction
def test_a_correction_is_a_derived_version_and_the_original_never_changes(client: TestClient, saved: Api,
                                                                           admin: Api, study: Path,
                                                                           recordings: Path) -> None:
    e01 = Api(client, "E01")
    work = expert_ok(e01, "work_list")
    row = next(i for i in work["items"] if i["annotator_id"] == "A01" and i["recording_id"] == SUB1)
    assert (row["attempt"], row["corrections"], row["n_annotations"], row["own"]) == (1, 0, 2, False)
    got = expert_ok(e01, "saved_attempt_get", {"annotator_id": "A01", "recording_id": SUB1})
    assert got["attempt"] == 1 and got["attempts"] == [1] and len(got["annotations"]) == 2
    assert got["reason_required"] == "always" and got["corrections"] == [] and got["manifest"]["file_name"]
    folder = study / "Annotated_Events" / "annotator-A01" / "sub-001" / "eeg"
    before = checksums(folder)
    entries = admin.admin_ok("stats", {})
    fixed = {**BLINK, "label": "Eye-artifact"}
    out = expert_ok(e01, "correction_save", correction(recordings, 1, [fixed, NEW],
                                                       {BLINK["annotation_id"]: "wrong_type", EMG["annotation_id"]:
                                                        "not_artifact", NEW["annotation_id"]: "missed"},
                                                       note="Look again at the jaw"))
    c = out["correction"]
    assert out["already"] is False and len(out["files"]) == 5
    assert c["counts"] == {"added": 1, "removed": 1, "changed": 1} and c["summary"] == "1 added, 1 removed, 1 changed"
    assert c["corrector_id"] == "E01" and c["number"] == 1 and c["n_corrections_of_version"] == 1
    assert [(x["change"], x["reason"]) for x in c["changes"]] == [("changed", "wrong_type"), ("removed",
                                                                    "not_artifact"), ("added", "missed")]
    assert checksums(folder) == before, "the original files are never changed"
    # the five files in derived/corrections, with their own register and the provenance
    tree = study / "Annotated_Events" / "derived" / "corrections"
    files = sorted(p.name for p in (tree / "annotator-A01" / "sub-001" / "eeg").iterdir())
    assert len(files) == 5 and all("_annotator-A01" in f for f in files)
    doc = json.loads(next((tree / "annotator-A01" / "sub-001" / "eeg").glob("*_annotations.json")).read_text())
    d = doc["session"]["context"]["derived"]
    assert d["kind"] == "correction" and d["correction_id"] == cid(1) and d["corrector_id"] == "E01"
    assert d["corrected_from"]["attempt"] == 1 and len(d["corrected_from"]["annotations_sha256"]) == 64
    assert doc["annotator"]["display_name"] == "A01 corrected by E01" and doc["session"]["session_id"] == cid(1)
    assert sorted(a["label"] for a in doc["annotations"]) == ["Chewing-artifact", "Eye-artifact"]
    session = json.loads(next((tree / "annotator-A01" / "sub-001" / "eeg").glob("*_session.json")).read_text())
    assert session["context"]["derived"]["changes"][0]["reason"] == "wrong_type"
    assert (tree / "completion_register.tsv").exists()
    # never A01's attempt, completion or time
    assert expert_ok(e01, "saved_attempt_get", {"annotator_id": "A01", "recording_id": SUB1})["attempts"] == [1]
    assert admin.admin_ok("stats", {})["totals"] == entries["totals"]
    # listed, and one correction with both versions
    listed = expert_ok(e01, "corrections_list", {"annotator_id": "A01"})["corrections"]
    assert [x["correction_id"] for x in listed] == [cid(1)]
    full = expert_ok(e01, "correction_get", {"correction_id": cid(1)})
    assert len(full["annotations"]) == 2 and len(full["original"]) == 2 and full["manifest"]["recording_id"] == SUB1
    assert full["changes"][0]["reason_text"] == "Wrong type"
    assert expert_ok(e01, "work_list", {"corrected": True})["items"][0]["corrections"] == 1
    assert expert_ok(e01, "work_list", {"corrected": False, "recording_id": SUB1})["items"] == []
    # audited, with the note's length only
    entry = admin_audit(admin)[0]
    assert entry["op"] == "correction_save" and entry["by"] == "E01"
    assert entry["summary"] == f"Corrected A01's {SUB1} (version 1): 1 added, 1 removed, 1 changed"
    assert entry["details"]["overall_note_length"] == len("Look again at the jaw")
    assert "Look again" not in json.dumps(entry)
    # the results zip: the derived version, and every change with its reason in corrections/
    import base64
    import io
    import zipfile

    names = zipfile.ZipFile(io.BytesIO(base64.b64decode(admin.admin_ok("results_zip", {})["base64"]))).namelist()
    assert any("/derived/corrections/annotator-A01/" in n and n.endswith("_annotations.json") for n in names)
    tsv = next(n for n in names if n.endswith("corrections/corrections.tsv"))
    text = zipfile.ZipFile(io.BytesIO(base64.b64decode(admin.admin_ok("results_zip", {})["base64"]))).read(tsv).decode()
    lines = text.splitlines()
    assert lines[0].startswith("correction_id\tcorrected_at\tcorrector_id") and len(lines) == 5  # 3 changes, the note
    assert "wrong_type" in text and "Look again at the jaw" in text


def test_each_change_needs_its_reason_as_the_study_asks(client: TestClient, saved: Api, admin: Api,
                                                       recordings: Path) -> None:
    e01 = Api(client, "E01")
    body = correction(recordings, 2, [BLINK, NEW], {})
    err = expert_error(e01, "correction_save", body, 422, "reason_missing")
    assert sorted(err["annotation_ids"]) == sorted([EMG["annotation_id"], NEW["annotation_id"]])
    expert_error(e01, "correction_save", correction(recordings, 2, [BLINK, NEW], {NEW["annotation_id"]: "lunch"}), 400,
                 "bad_request")
    admin.admin_ok("settings_update", {"settings": {"review": {"reason_required": "edited_or_none"}}})
    err = expert_error(e01, "correction_save", body, 422, "reason_missing")
    assert err["annotation_ids"] == [EMG["annotation_id"]], "an added mark needs no reason then"
    admin.admin_ok("settings_update", {"settings": {"review": {"reason_required": "never"}}})
    out = expert_ok(e01, "correction_save", body)
    assert [c["reason"] for c in out["correction"]["changes"]] == ["", ""]


def test_what_is_refused(client: TestClient, saved: Api, admin: Api, recordings: Path) -> None:
    e01 = Api(client, "E01")
    unchanged = correction(recordings, 3, [BLINK, EMG], {})
    expert_error(e01, "correction_save", unchanged, 422, "no_changes")
    expert_error(e01, "correction_save", {**unchanged, "correction_id": "short"}, 400, "bad_request")
    expert_error(e01, "correction_save", {**unchanged, "annotator_id": "A02"}, 404, "no_saved_annotations")
    expert_error(saved, "correction_save", correction(recordings, 4, [BLINK], {EMG["annotation_id"]: "other"}), 403,
                 "forbidden")
    # an expert's own work is revised from their history, not corrected
    expert_ok(admin, "work_list")  # an administrator may do what an expert does
    admin.admin_ok("assign", {"annotator_ids": ["E01"], "recording_ids": [SUB2]})
    e01.ok("post", "/submissions", submission(recordings, SUB2, [BLINK]))
    expert_error(e01, "correction_save", correction(recordings, 5, [], {BLINK["annotation_id"]: "other"}, rid=SUB2,
                                                    aid="E01"), 409, "own_work")
    assert next(i for i in expert_ok(e01, "work_list")["items"] if i["annotator_id"] == "E01")["own"] is True
    # A01 saves a revision while E01 corrects version 1
    saved.ok("post", "/submissions", {**submission(recordings, SUB1, [BLINK]), "revises": 1})
    err = expert_error(e01, "correction_save", correction(recordings, 6, [BLINK], {EMG["annotation_id"]: "other"}),
                       409, "not_latest")
    assert "version 2" in err["message"]
    assert expert_ok(e01, "saved_attempt_get", {"annotator_id": "A01", "recording_id": SUB1,
                                                "attempt": 1})["attempt"] == 1
    admin.admin_ok("settings_update", {"settings": {"review": {"corrections": False}}})
    expert_error(e01, "correction_save", correction(recordings, 7, [], {BLINK["annotation_id"]: "other"},
                                                    attempt=2), 409, "corrections_off")
    expert_error(e01, "correction_get", {"correction_id": cid(99)}, 404, "not_found")


def test_the_same_correction_is_kept_once(client: TestClient, saved: Api, app, recordings: Path,
                                         monkeypatch: pytest.MonkeyPatch) -> None:
    e01 = Api(client, "E01")
    store = app.state.store
    body = correction(recordings, 8, [BLINK], {EMG["annotation_id"]: "not_artifact"})
    first = expert_ok(e01, "correction_save", body)
    again = expert_ok(e01, "correction_save", body)
    assert again["already"] is True and again["correction"]["correction_id"] == cid(8)
    assert len(store.derived_entries("corrections", "A01")) == 1
    # someone else sending the same ID is not given the correction
    expert_error(Api(client, "ADMIN"), "correction_save", body, 409, "conflict")
    assert first["correction"]["number"] == 1
    # A request that saved the files but stopped before marking its record: the next one with the same ID finds the
    # version in the register by its ID and saves nothing more.
    real = store.update_record
    calls = {"n": 0}

    def stops_at_the_end(kind, record_id, annotator_id, change):
        calls["n"] += 1
        if kind == "corrections" and calls["n"] == 2:
            raise RuntimeError("the server stopped")
        return real(kind, record_id, annotator_id, change)

    body2 = correction(recordings, 9, [BLINK, EMG, NEW], {NEW["annotation_id"]: "missed"})
    monkeypatch.setattr(store, "update_record", stops_at_the_end)
    assert client.post("/api/v1/expert/correction_save", json=body2, headers=e01.headers).status_code == 500
    monkeypatch.setattr(store, "update_record", real)
    pending = next(r for r in store.records("corrections", "A01") if r["correction_id"] == cid(9))
    assert pending["state"] == "pending"
    expert_error(e01, "correction_save", body2, 409, "busy")  # it may still be saving
    monkeypatch.setattr(corrections, "PENDING_STALE_S", 0.0)
    out = expert_ok(e01, "correction_save", body2)
    assert out["already"] is False and out["correction"]["state"] == "saved" and out["correction"]["number"] == 2
    assert len(store.derived_entries("corrections", "A01")) == 2, "the version saved before is not saved again"


def test_two_experts_correcting_the_same_version_are_both_kept(client: TestClient, saved: Api, admin: Api, app,
                                                              recordings: Path) -> None:
    e01 = Api(client, "E01")
    expert_ok(e01, "correction_save", correction(recordings, 10, [BLINK], {EMG["annotation_id"]: "not_artifact"}))
    expert_ok(e01, "correction_save", correction(recordings, 11, [EMG], {BLINK["annotation_id"]: "not_artifact"}))
    out = expert_ok(admin, "correction_save", correction(recordings, 12, [BLINK, EMG, NEW],
                                                         {NEW["annotation_id"]: "missed"}))
    assert out["correction"]["n_corrections_of_version"] == 2
    assert "corrected by E01 as well, so the corrections go to adjudication" in admin_audit(admin)[0]["summary"]
    service = app.state.service
    latest = corrections_of(service, "A01", SUB1, 1)
    assert [r["correction_id"] for r in latest] == [cid(11), cid(12)], "each expert's latest correction"
    assert len(corrections_of(service, "A01", SUB1, 1, latest_per_corrector=False)) == 3
    assert corrections_of(service, "A01", SUB1, 2) == []
    got = expert_ok(e01, "saved_attempt_get", {"annotator_id": "A01", "recording_id": SUB1})
    assert [c["corrector_id"] for c in got["corrections"]] == ["E01", "E01", "ADMIN"]


# ------------------------------------------------------------------ the annotator's view
def test_the_annotator_sees_the_changes_when_the_study_shows_them(client: TestClient, saved: Api, admin: Api,
                                                                 recordings: Path) -> None:
    e01 = Api(client, "E01")
    expert_ok(e01, "correction_save", correction(recordings, 13, [{**BLINK, "onset_sample": 480}, EMG],
                                                 {BLINK["annotation_id"]: "boundaries"}, note="Starts earlier"))
    fb = saved.ok("get", "/me/feedback")["corrections"]
    assert fb["shown"] is True and len(fb["items"]) == 1
    item = fb["items"][0]
    assert item["corrector_id"] == "E01" and item["counts"]["changed"] == 1 and item["of_latest"] is True
    assert item["changes"][0]["reason_text"] == "Start or end" and item["changes"][0]["fields"] == ["onset", "end"]
    assert item["overall_note"] == "Starts earlier" and "output_basename" not in item
    mine = expert_ok(saved, "my_correction_get", {"correction_id": cid(13)})
    assert mine["annotations"][0]["onset_sample"] == 480 and mine["original"][0]["onset_sample"] == 500
    expert_error(Api(client, "A02"), "my_correction_get", {"correction_id": cid(13)}, 404, "not_found")
    expert_error(saved, "correction_get", {"correction_id": cid(13)}, 403, "forbidden")
    assert Api(client, "A02").ok("get", "/me/feedback")["corrections"]["items"] == []
    admin.admin_ok("settings_update", {"settings": {"review": {"show_corrections_to_annotators": False}}})
    assert saved.ok("get", "/me/feedback")["corrections"] == {"shown": False, "items": []}
    expert_error(saved, "my_correction_get", {"correction_id": cid(13)}, 403, "forbidden")
    # a revision after the correction: it is of an earlier version
    admin.admin_ok("settings_update", {"settings": {"review": {"show_corrections_to_annotators": True}}})
    saved.ok("post", "/submissions", {**submission(recordings, SUB1, [BLINK]), "revises": 1})
    assert saved.ok("get", "/me/feedback")["corrections"]["items"][0]["of_latest"] is False


def test_a_reason_must_suit_its_change(client: TestClient, saved: Api, recordings: Path) -> None:
    e01 = Api(client, "E01")
    added = correction(recordings, 20, [BLINK, EMG, NEW], {NEW["annotation_id"]: "not_artifact"})
    err = expert_error(e01, "correction_save", added, 400, "bad_request")
    assert err["message"].startswith('"Not an artifact" is not a reason for an added mark')
    removed = correction(recordings, 21, [BLINK], {EMG["annotation_id"]: "missed"})
    assert "a removed mark" in expert_error(e01, "correction_save", removed, 400, "bad_request")["message"]
    changed = correction(recordings, 22, [{**BLINK, "label": "EMG-artifact"}, EMG], {BLINK["annotation_id"]: "missed"})
    expert_error(e01, "correction_save", changed, 400, "bad_request")
    assert sorted(corrections.REASONS_FOR) == sorted(corrections.CHANGES)
    assert all(set(v) <= set(corrections.REASONS) for v in corrections.REASONS_FOR.values())


def test_two_experts_disagree_the_annotator_sees_neither_version_until_it_is_settled(
        client: TestClient, saved: Api, admin: Api, recordings: Path) -> None:
    """Finding 3 of the expert review: never one expert's version where experts disagree; the adjudicated corrected
    version and its decisions once the adjudication is finished."""
    from tests.web_helpers import DEMO_PASSWORD

    admin.admin_ok("user_add", {"annotator_id": "E03", "display_name": "Expert three", "password": DEMO_PASSWORD,
                                "roles": ["expert"]})
    e01, e03 = Api(client, "E01"), Api(client, "E03")
    move = "Eye-movement-artifact"
    expert_ok(e01, "correction_save", correction(recordings, 30, [{**BLINK, "label": move}, EMG],
                                                 {BLINK["annotation_id"]: "wrong_type"}, note="Look at F7"))
    single = saved.ok("get", "/me/feedback")["corrections"]["items"]
    assert [(i["standing"], i["counts"]["changed"]) for i in single] == [("single", 1)]
    expert_ok(admin, "correction_save", correction(recordings, 31, [{**BLINK, "label": "EMG-artifact"}, EMG],
                                                   {BLINK["annotation_id"]: "wrong_type"}))
    # pending: who corrected it, and nothing of what either changed
    items = saved.ok("get", "/me/feedback")["corrections"]["items"]
    assert len(items) == 1, "one item for the version corrected"
    item = items[0]
    assert item["standing"] == "pending" and item["changes"] == [] and item["overall_note"] == ""
    assert [c["corrector_id"] for c in item["correctors"]] == ["E01", "ADMIN"]
    err = expert_error(saved, "my_correction_get", {"correction_id": cid(30)}, 409, "pending_adjudication")
    assert "disagree in places" in err["message"]
    expert_error(saved, "my_correction_get", {"correction_id": cid(31)}, 409, "pending_adjudication")
    # E03 adjudicates and keeps E01's version of the blink
    from electrotag.web.adjudication import unit_id_for

    uid = unit_id_for("corrections", "A01", SUB1, "1")
    got = expert_ok(e03, "adjudication_start", {"unit_id": uid})
    assert len(got["conflicts"]) == 1
    c = got["conflicts"][0]
    letter = next(m["letter"] for m in c["marks"] if m["annotator_id"] == "E01")
    expert_ok(e03, "adjudication_decide", {"unit_id": uid, "conflict_id": c["conflict_id"], "choice": letter,
                                           "reason_code": "type_evidence", "reason": "the eyes move sideways"})
    expert_ok(e03, "adjudication_finish", {"unit_id": uid})
    item = saved.ok("get", "/me/feedback")["corrections"]["items"][0]
    assert item["standing"] == "adjudicated" and item["counts"] == {"added": 0, "removed": 0, "changed": 1}
    assert item["adjudication"]["adjudicator_id"] == "E03" and item["adjudication"]["n_conflicts"] == 1
    change = item["changes"][0]
    assert change["annotation_id"] == BLINK["annotation_id"] and change["after"]["label"] == move
    assert change["decision"]["kept"] == ["E01"] and change["decision"]["reason"] == "the eyes move sideways"
    assert change["reason_text"] == "Settled by the adjudicator"
    assert {r["corrector_id"] for r in change["reasons"]} == {"E01", "ADMIN"}
    row = item["adjudication"]["conflicts"][0]
    assert [v["corrector_id"] for v in row["versions"]] == sorted(["E01", "ADMIN"], key=lambda p: next(
        m["letter"] for m in c["marks"] if m["annotator_id"] == p))
    assert row["yours"][0]["label"] == "Eye-blink-artifact" and row["decision"]["marks"][0]["label"] == move
    shown = expert_ok(saved, "my_correction_get", {"correction_id": cid(31)})
    assert shown["standing"] == "adjudicated"
    assert sorted((a["annotation_id"], a["label"]) for a in shown["annotations"]) == sorted(
        [(BLINK["annotation_id"], move), (EMG["annotation_id"], "EMG-artifact")]), "the adjudicated corrected version"
    assert [a["label"] for a in shown["original"]] == ["Eye-blink-artifact", "EMG-artifact"]
    assert len(shown["changes"]) == 1 and shown["overall_note"].endswith("Look at F7")
