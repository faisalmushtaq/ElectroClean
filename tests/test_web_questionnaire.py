"""The sign-up questionnaire and contact details (electrotag/web/questionnaire.py, docs/web/api.md).

The gate on work, the history of answers, the checks of a study's own questionnaire, the results zip
with and without the contacts list, the analyses' tables of the answers current at each piece of work,
and that nothing personal reaches the audit log. The Firestore store is tested in test_web_firestore.py.
"""

from __future__ import annotations

import base64
import io
import json
import zipfile
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from electrotag.config.questionnaire import DEFAULT_QUESTIONS, PREFER_NOT, version_of  # noqa: E402
from electrotag.web.app import create_app  # noqa: E402
from electrotag.web.questionnaire import GATED_OPERATIONS, answers_at  # noqa: E402
from tests.web_helpers import SUB1, Api, admin_audit, ann, copy_demo, make_template, match_body, submission  # noqa: E402

pytestmark = pytest.mark.questionnaire

BLINK = ann("b" * 32, "Eye-blink-artifact", 500, 100, ["Fp1", "Fp2"])
BLINK2 = ann("e" * 32, "Eye-blink-artifact", 510, 95, ["Fp1", "Fp2"])
ANSWERS: dict[str, Any] = {
    "datasets_analysed": "11–30", "eeg_years": "6–10", "annotation_hours": "51–200", "artifact_training": "Other",
    "eeg_systems": ["OpenBCI", "BioSemi"], "eeg_setting": "Both", "confidence": "4", "career_stage": "Postdoc",
    "discipline": "Engineering", "country": "Ghana", "age_band": PREFER_NOT, "gender": "Prefer to self-describe",
    "first_language": "Twi",
}
CONTACTS = {"full_name": "Ama Owusu", "email": "ama@example.org", "phone": "+44 113 000 0000",
            "institution": "University of Leeds"}
#: Words that identify Ama or that she typed: none may reach the audit log or the interaction log.
PERSONAL = ("Ama Owusu", "ama@example.org", "113 000", "University of Leeds", "summer school", "Agender", "Twi")


@pytest.fixture(scope="module")
def template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_template(tmp_path_factory.mktemp("questionnaire-demo"))


@pytest.fixture
def client(template: Path, tmp_path: Path):
    app = create_app(copy_demo(template, tmp_path), demo=True)
    yield TestClient(app)
    app.state.store.close()


@pytest.fixture
def recordings(template: Path) -> Path:
    return template / "recordings"


def newcomer(client: TestClient, aid: str = "A03", roles: list[str] | None = None) -> Api:
    admin = Api(client, "ADMIN")
    admin.admin_ok("user_add", {"annotator_id": aid, "display_name": "Newcomer", "email": f"{aid.lower()}@example.org",
                                "password": "long enough", "roles": roles or ["annotator"]})
    admin.admin_ok("assign", {"annotator_ids": [aid], "all": True})
    return Api(client, aid, "long enough")


def answer(api: Api, answers: dict[str, Any] | None = None, contacts: dict[str, str] | None = None,
           other: dict[str, str] | None = None) -> dict[str, Any]:
    return api.ok("post", "/me/questionnaire", {"answers": answers or ANSWERS, "contacts": contacts or CONTACTS,
                                                "other": other or {}})


def test_the_default_questionnaire_has_the_project_leads_questions() -> None:
    by_id = {q["id"]: q for q in DEFAULT_QUESTIONS}
    assert by_id["datasets_analysed"]["options"] == ["0", "1–2", "3–10", "11–30", "31–100", "Over 100"]
    assert by_id["career_stage"]["options"] == ["Undergraduate", "Master's", "PhD", "Postdoc", "Faculty", "Clinician",
                                                "EEG technologist", "Industry", "Other"]
    assert by_id["discipline"]["options"] == ["Neuroscience", "Psychology", "Engineering", "Medicine", "Other"]
    assert by_id["confidence"]["options"][0].startswith("1") and by_id["confidence"]["options"][-1].startswith("5")
    assert by_id["gender"]["other_option"] == "Prefer to self-describe"
    assert [q["group"] for q in DEFAULT_QUESTIONS].count("demographics") == 3
    for q in DEFAULT_QUESTIONS:  # "Prefer not to say" is offered by ElectroTag, never listed
        assert all("prefer not" not in o.lower() for o in q.get("options", []))


def test_work_waits_for_the_questionnaire(client: TestClient, recordings: Path) -> None:
    a03 = newcomer(client)
    me = a03.ok("get", "/me")["questionnaire"]
    assert me["asked"] is True and me["answered"] is False
    for method, path, body in (("post", "/match", match_body(recordings, SUB1)),
                               ("post", "/submissions", submission(recordings, SUB1, [BLINK])),
                               ("put", f"/drafts/{SUB1}?mode=standard&context=", {"annotations": []}),
                               ("get", "/training", None),
                               ("post", "/training/stage", {"stage": "tour", "action": "skip"}),
                               ("post", "/quiz/example", {"action": "get"}),
                               ("post", "/expert/replay_consent_get", {})):
        r = getattr(a03, method)(path, body) if body is not None else getattr(a03, method)(path)
        assert r.status_code == 403 and r.json()["error"] == "questionnaire_required", (path, r.text)
        assert "questionnaire" in r.json()["message"]
    # what is not work stays open: the home page's list, the questionnaire itself
    assert a03.ok("get", "/assignments")["items"]
    q = a03.ok("get", "/me/questionnaire")
    assert q["contacts"]["values"]["email"] == "a03@example.org"  # prefilled from the account
    assert [g["key"] for g in q["groups"]] == ["experience", "career", "demographics"]
    answer(a03)
    assert a03.ok("get", "/me")["questionnaire"]["answered"] is True
    assert a03.ok("post", "/match", match_body(recordings, SUB1))["status"] == "matched"
    assert set(GATED_OPERATIONS) >= {"match", "put_draft", "submit", "training", "quiz", "expert"}


def test_administrators_who_do_not_annotate_are_not_asked(client: TestClient) -> None:
    admin = Api(client, "ADMIN")
    assert admin.ok("get", "/me")["questionnaire"]["asked"] is False
    assert admin.ok("post", "/expert/replay_consent_get", {})  # an administrator's expert work is not held up
    both = newcomer(client, "D01", ["admin", "annotator"])
    assert both.ok("get", "/me")["questionnaire"]["asked"] is True  # an administrator who annotates is asked
    admin.admin_ok("settings_update", {"settings": {"questionnaire": {"enabled": False}}})
    a04 = newcomer(client, "A04")
    assert a04.ok("get", "/me")["questionnaire"]["asked"] is False
    assert a04.post("/training/stage", {"stage": "tour", "action": "skip"}).json()["error"] != "questionnaire_required"
    r = a04.post("/me/questionnaire", {"answers": ANSWERS, "contacts": CONTACTS})
    assert (r.status_code, r.json()["error"]) == (409, "questionnaire_off")


def test_answers_are_checked_with_prefer_not_to_say_on_every_question(client: TestClient) -> None:
    a03 = newcomer(client)

    def refused(body: dict[str, Any], code: str = "invalid_answers") -> str:
        r = a03.post("/me/questionnaire", body)
        assert (r.status_code, r.json()["error"]) == (422, code), r.text
        return r.json()["message"]

    assert "Please answer “How many years have you worked with EEG?”, or choose Prefer not to say." == refused(
        {"answers": {**ANSWERS, "eeg_years": None}, "contacts": CONTACTS}, "questionnaire_incomplete")
    assert "is not one of the answers" in refused({"answers": {**ANSWERS, "eeg_years": "ages"}, "contacts": CONTACTS})
    assert "cannot be chosen together" in refused({"answers": {**ANSWERS, "eeg_systems": ["OpenBCI", PREFER_NOT]},
                                                   "contacts": CONTACTS})
    refused({"answers": {**ANSWERS, "shoe_size": "9"}, "contacts": CONTACTS}, "unknown_question")
    assert refused({"answers": ANSWERS, "contacts": {**CONTACTS, "full_name": ""}},
                   "questionnaire_incomplete") == "Please give your full name."
    refused({"answers": ANSWERS, "contacts": {**CONTACTS, "email": "ama"}})
    refused({"answers": ANSWERS, "contacts": {**CONTACTS, "phone": "call me"}})
    refused({"contacts": CONTACTS})  # a POST without answers saves nothing
    every = {q["id"]: ([PREFER_NOT] if q["type"] == "multi" else PREFER_NOT) for q in DEFAULT_QUESTIONS}
    out = answer(a03, every, {"full_name": "Ama Owusu", "email": "ama@example.org"})
    assert out["answers"] == every and out["n_answered"] == len(DEFAULT_QUESTIONS)
    # the words given with "Other" are kept only with that option, and the options of several in their own order
    out = answer(a03, {**ANSWERS, "eeg_systems": ["Other", "BioSemi"]},
                 other={"artifact_training": "A summer school", "eeg_systems": "Our own amplifier", "age_band": "x"})
    assert out["answers"]["eeg_systems"] == ["BioSemi", "Other"]
    assert out["other"] == {"artifact_training": "A summer school", "eeg_systems": "Our own amplifier"}


def test_changes_are_kept_as_a_dated_history(client: TestClient) -> None:
    a03 = newcomer(client)
    first = answer(a03)
    assert first["changed"] is True and first["n_versions"] == 1
    again = answer(a03)  # the same answers sent again (a second press, a request that arrived twice)
    assert again["changed"] is False and again["n_versions"] == 1
    later = answer(a03, {**ANSWERS, "datasets_analysed": "31–100"})
    assert later["n_versions"] == 2 and later["answers"]["datasets_analysed"] == "31–100"
    admin = Api(client, "ADMIN")
    got = admin.admin_ok("questionnaire_get", {"annotator_id": "a03"})
    assert [h["answers"]["datasets_analysed"] for h in got["history"]] == ["31–100", "11–30"]  # newest first
    assert got["contacts"]["full_name"] == "Ama Owusu" and got["contacts"]["phone"] == "+44 113 000 0000"
    assert got["definitions"][got["history"][0]["version"]][0]["id"] == "datasets_analysed"
    record = {"history": list(reversed(got["history"]))}
    assert answers_at(record, got["history"][1]["at"])[0]["answers"]["datasets_analysed"] == "11–30"
    assert answers_at(record, "2099-01-01T00:00:00+00:00")[0]["answers"]["datasets_analysed"] == "31–100"
    entry, after = answers_at(record, "2000-01-01T00:00:00+00:00")
    assert after is True and entry["answers"]["datasets_analysed"] == "11–30"  # work from before any answer
    # the summary, by ID; the names in users_list are for the study team's lists
    s = admin.admin_ok("questionnaire_summary")
    row = next(r for r in s["rows"] if r["annotator_id"] == "A03")
    assert row["n_changes"] == 1 and s["counts"]["datasets_analysed"]["31–100"] >= 1
    assert "Ama Owusu" not in json.dumps(s)
    users = {u["annotator_id"]: u for u in admin.admin_ok("users_list")["users"]}
    assert users["A03"]["full_name"] == "Ama Owusu" and users["A03"]["questionnaire_answered"] is True


def test_the_study_team_edits_the_questionnaire(client: TestClient) -> None:
    admin = Api(client, "ADMIN")
    bad = [({"questions": [{"id": "x", "group": "career", "text": "X?", "type": "choice", "options": ["a", "A"]}]},
            "an option is given twice"),
           ({"questions": [{"id": "x", "group": "career", "text": "X?", "type": "choice",
                            "options": ["Yes", "Prefer not to say"]}]}, "leave out"),
           ({"questions": [{"id": "Bad id", "group": "career", "text": "X?", "type": "text"}]}, "id must be"),
           ({"questions": [{"id": "x", "group": "career", "text": "X?", "type": "text"}] * 2}, "used twice"),
           ({"contacts": {"phone": "sometimes"}}, "required, optional or off")]
    for block, words in bad:
        r = admin.admin_error("settings_update", {"settings": {"questionnaire": block}}, 400, "invalid_settings")
        assert words in r["message"], r["message"]
    mine = [{"id": "eeg_years", "group": "experience", "text": "Years with EEG?", "type": "choice",
             "options": ["Under 5", "5 or more"]},
            {"id": "lab", "group": "career", "text": "Your lab?", "type": "text", "required": False}]
    admin.admin_ok("settings_update", {"settings": {"questionnaire": {"questions": mine, "demographics": False,
                                                                       "contacts": {"phone": "off"}}}})
    a03 = newcomer(client)
    q = a03.ok("get", "/me/questionnaire")
    assert [x["id"] for x in q["questions"]] == ["eeg_years", "lab"] and q["version"] == version_of(q["questions"])
    assert [f["key"] for f in q["contacts"]["fields"]] == ["full_name", "email", "institution"]
    out = answer(a03, {"eeg_years": "Under 5"}, {"full_name": "Ama Owusu", "email": "ama@example.org"})
    assert out["answers"] == {"eeg_years": "Under 5"}  # the optional question left out


def test_the_results_zip_is_pseudonymised_unless_the_contacts_are_asked_for(client: TestClient) -> None:
    a03 = newcomer(client)
    answer(a03, other={"artifact_training": "A summer school"})
    answer(a03, {**ANSWERS, "gender": "Prefer to self-describe"}, other={"artifact_training": "A summer school",
                                                                          "gender": "Agender"})
    admin = Api(client, "ADMIN")
    z = zipfile.ZipFile(io.BytesIO(base64.b64decode(admin.admin_ok("results_zip")["base64"])))
    names = z.namelist()
    tsv = z.read("Annotated_Events/questionnaire/answers.tsv").decode("utf-8")
    doc = json.loads(z.read("Annotated_Events/questionnaire/answers.json"))
    assert "contacts.csv" not in names
    lines = [line.split("\t") for line in tsv.strip().split("\n")]
    head = lines[0]
    assert head[:4] == ["annotator_id", "questionnaire_version", "answered_at", "current"]
    mine = [dict(zip(head, line, strict=True)) for line in lines[1:] if line[0] == "A03"]
    assert [r["current"] for r in mine] == ["false", "true"] and mine[1]["gender_other"] == "Agender"
    assert mine[0]["artifact_training_other"] == "A summer school" and mine[0]["eeg_systems"] == "BioSemi; OpenBCI"
    assert doc["prefer_not_to_say"] == PREFER_NOT and doc["current_version"] in doc["definitions"]
    for name in names:  # names and contact details are nowhere in the research files
        text = z.read(name).decode("utf-8", "replace")
        for word in ("Ama Owusu", "ama@example.org", "University of Leeds"):
            assert word not in text, (name, word)
    before = len(admin_audit(admin))
    got = admin.admin_ok("results_zip", {"include_contacts": True})
    z = zipfile.ZipFile(io.BytesIO(base64.b64decode(got["base64"])))
    contacts = z.read("contacts.csv").decode("utf-8").splitlines()
    assert contacts[0] == "annotator_id,full_name,email,phone,institution,updated_at,account"
    expected = "A03,Ama Owusu,ama@example.org,'+44 113 000 0000,University of Leeds,"
    assert any(line.startswith(expected) for line in contacts)
    assert "This file names people" in z.read("README.txt").decode("utf-8")
    entries = admin_audit(admin)
    assert len(entries) == before + 1 and entries[0]["op"] == "results_zip_contacts"
    r = admin.admin_ok("contacts_download")
    assert "A03" in {row["annotator_id"] for row in r["rows"]} and r["warning"].startswith("This file names people")
    assert admin_audit(admin)[0]["summary"].startswith("Downloaded the contact details of ")


def test_nothing_personal_reaches_the_audit_log(client: TestClient) -> None:
    a03 = newcomer(client)
    answer(a03, other={"artifact_training": "A summer school", "gender": "Agender"})
    answer(a03, contacts={**CONTACTS, "phone": ""})
    admin = Api(client, "ADMIN")
    admin.admin_ok("contacts_download")
    admin.admin_ok("results_zip", {"include_contacts": True})
    text = json.dumps(admin_audit(admin, 200))
    for word in PERSONAL:
        assert word not in text, word
    changed = [e for e in admin_audit(admin, 200) if e["op"] == "contacts_changed"]
    assert len(changed) == 2 and changed[0]["summary"] == "A03's contact details changed"


def test_the_analyses_have_the_answers_current_at_each_piece_of_work(client: TestClient, recordings: Path) -> None:
    admin = Api(client, "ADMIN")
    a01, a02 = Api(client, "A01"), Api(client, "A02")
    a01.ok("post", "/submissions", submission(recordings, SUB1, [BLINK]))
    answer(a02, {**ANSWERS, "datasets_analysed": "Over 100"})  # A02 answers again before annotating
    a02.ok("post", "/submissions", submission(recordings, SUB1, [BLINK2]))
    r = admin.admin_ok("agreement", {"config": {"resolutions_s": [0.1], "iou_thresholds": [0.2]}})
    tsv = r["tables"]["questionnaire_at_annotation.tsv"].strip().split("\n")
    head = tsv[0].split("\t")
    rows = {line.split("\t")[1]: dict(zip(head, line.split("\t"), strict=True)) for line in tsv[1:]}
    assert head[:5] == ["recording_id", "rater", "mode", "annotated_at", "questionnaire_version"]
    assert rows["A01"]["datasets_analysed"] == "3–10" and rows["A02"]["datasets_analysed"] == "Over 100"
    assert "Ama Owusu" not in r["tables"]["questionnaire_at_annotation.tsv"]
    bands = r["tables"]["agreement_by_experience.tsv"].strip().split("\n")
    assert bands[0].split("\t") == ["datasets_analysed_bands", "category", "n_comparisons", "mean_cohen_kappa",
                                    "mean_positive_agreement"]
    assert any(line.startswith("3–10 & Over 100\t") for line in bands[1:])
    v = a01.ok("post", "/visits", {"client": {"user_agent": "pytest"}})
    a01.ok("post", f"/visits/{v['visit_id']}/events", {"events": [{"t": 1.0, "type": "questionnaire_answered",
                                                                   "n_answered": 13}]})
    act = admin.admin_ok("activity", {})
    visit = act["tables"]["questionnaire_at_visit.tsv"].strip().split("\n")
    assert visit[0].startswith("visit_id\tannotator_id\tstarted_at\tquestionnaire_version")
    assert v["visit_id"] in visit[1] and "\t3–10\t" in visit[1]
