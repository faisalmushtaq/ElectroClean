"""The ElectroClean server (electroclean/web/app.py) with the files store, end to end over HTTP."""

from __future__ import annotations

import io
import json
import time
import zipfile
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from electroclean.app.io.naming import OutputLayout  # noqa: E402
from electroclean.app.session.register import CompletionRegister  # noqa: E402
from electroclean.web.app import PAGES_ORIGIN, create_app  # noqa: E402
from tests.web_helpers import (  # noqa: E402
    GUIDED1,
    GUIDED2,
    H,
    PRACTICE1,
    SUB1,
    SUB2,
    SUB3,
    Api,
    ann,
    as_wire,
    copy_demo,
    make_template,
    match_body,
    reference_annotations,
    submission,
)


@pytest.fixture(scope="module")
def template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_template(tmp_path_factory.mktemp("web-demo"))


@pytest.fixture
def study(template: Path, tmp_path: Path) -> Path:
    return copy_demo(template, tmp_path)


@pytest.fixture
def recordings(template: Path) -> Path:
    return template / "recordings"


@pytest.fixture
def app(study: Path, template: Path):
    a = create_app(study, demo=True, demo_zip=template / "recordings.zip", allowed_origins=["https://lab.example.org"])
    yield a
    a.state.store.close()


@pytest.fixture
def client(app) -> TestClient:
    return TestClient(app)


BLINK = ann("b" * 32, "Eye-blink-artifact", 500, 100, ["Fp1", "Fp2"])
EMG = ann("c" * 32, "EMG-artifact", 3000, 250, [])


# ---------------------------------------------------------------- the basics
def test_health_is_open_to_every_origin(client: TestClient) -> None:
    r = client.get("/api/v1/health", headers={"Origin": "https://anywhere.example"})
    assert r.status_code == 200
    assert r.json() == {"ok": True, "version": r.json()["version"], "study": "ElectroClean demonstration",
                        "demo": True}
    assert r.headers["access-control-allow-origin"] == "*"


def test_requests_need_the_electroclean_header(client: TestClient) -> None:
    r = client.post("/api/v1/login", json={"annotator_id": "A01", "password": "electroclean"})
    assert r.status_code == 403 and r.json()["error"] == "missing_header"


def test_cors_answers_only_allowed_origins(client: TestClient) -> None:
    pre = {"Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,x-electroclean"}
    ok = client.options("/api/v1/me", headers={"Origin": "https://lab.example.org", **pre})
    assert ok.status_code == 204
    assert ok.headers["access-control-allow-origin"] == "https://lab.example.org"
    assert "X-ElectroClean" in ok.headers["access-control-allow-headers"]
    assert "access-control-allow-credentials" not in ok.headers
    assert int(ok.headers["access-control-max-age"]) > 0
    pages = client.options("/api/v1/me", headers={"Origin": PAGES_ORIGIN, **pre})  # the demo allows GitHub Pages
    assert pages.headers["access-control-allow-origin"] == PAGES_ORIGIN
    bad = client.options("/api/v1/me", headers={"Origin": "https://evil.example", **pre})
    assert "access-control-allow-origin" not in bad.headers
    r = client.get("/api/v1/me", headers={**H, "Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in r.headers


def test_sign_in_tokens_and_sign_out(client: TestClient, app) -> None:
    bad = client.post("/api/v1/login", json={"annotator_id": "A01", "password": "wrong-password"}, headers=H)
    assert bad.status_code == 401 and bad.json()["error"] == "bad_credentials"
    api = Api(client, "a01")  # IDs are not case-sensitive
    me = api.ok("get", "/me")
    assert me["annotator_id"] == "A01" and me["role"] == "annotator"
    assert me["study"]["filters"]["notch_hz"] == 50.0 and me["study"]["logging_notice"]
    assert len(me["catalogue"]["labels"]) == 29 and me["programme"] is None
    # only a hash of the token is kept
    db = app.state.store.db
    assert api.token not in Path(db.path).read_bytes().decode("latin-1")
    # 12 hours without use: expired
    with db._lock:
        db._db.execute("UPDATE tokens SET last_used = ?", (time.time() - 13 * 3600,))
    assert api.get("/me").status_code == 401
    api = Api(client, "A01")
    assert api.ok("post", "/logout") == {}
    r = api.get("/me")
    assert r.status_code == 401 and r.json()["error"] == "not_signed_in"


def test_sign_in_attempts_are_limited(client: TestClient) -> None:
    for _ in range(10):
        client.post("/api/v1/login", json={"annotator_id": "A02", "password": "nope-nope"}, headers=H)
    r = client.post("/api/v1/login", json={"annotator_id": "A02", "password": "electroclean"}, headers=H)
    assert r.status_code == 429 and r.json()["error"] == "too_many_attempts"


def test_errors_never_show_a_stack_trace(client: TestClient, app, monkeypatch: pytest.MonkeyPatch) -> None:
    api = Api(client, "A01")

    def boom(*_a, **_k):
        raise RuntimeError("secret internals")

    monkeypatch.setattr(app.state.service, "me", boom)
    r = api.get("/me")
    assert r.status_code == 500 and r.json()["error"] == "internal"
    assert "secret" not in r.text and "Traceback" not in r.text
    assert api.get("/nothing-here").json()["error"] == "not_found"
    assert api.post("/match", {"sha256": "x"}).status_code == 400


def test_the_server_serves_the_browser_application(study: Path, tmp_path: Path) -> None:
    static = tmp_path / "static"
    (static / "js").mkdir(parents=True)
    (static / "index.html").write_text("<!doctype html><title>ElectroClean</title><script src='js/main.js'></script>")
    (static / "js" / "main.js").write_text("export const ok = true;\n")
    (static / "config.json").write_text(json.dumps({"firebase": {"apiKey": "x"}, "study": "pilot"}))
    app = create_app(study, demo=True, static_dir=static)
    c = TestClient(app)
    assert "<title>ElectroClean</title>" in c.get("/").text
    js = c.get("/js/main.js")
    assert js.status_code == 200 and "javascript" in js.headers["content-type"]
    # served from here, the application talks to this server, whatever config.json it was published with
    assert c.get("/config.json").json() == {"server": "http://testserver", "study": "demo"}
    assert c.get("/api/v1/health").json()["ok"] is True
    assert c.get("/api/v1/nope", headers=H).json()["error"] == "not_found"
    assert c.get("/missing.html").status_code == 404
    # the application on GitHub Pages calling the demonstration on this computer (Chrome asks first)
    pre = c.options("/api/v1/me", headers={"Origin": PAGES_ORIGIN, "Access-Control-Request-Method": "GET",
                                           "Access-Control-Request-Private-Network": "true"})
    assert pre.headers["access-control-allow-private-network"] == "true"
    app.state.store.close()


def test_static_application_and_demo_recordings(client: TestClient) -> None:
    r = client.get("/")
    assert r.status_code == 200 and "ElectroClean" in r.text
    z = client.get("/demo/recordings.zip")
    assert z.status_code == 200
    names = zipfile.ZipFile(io.BytesIO(z.content)).namelist()
    assert any(n.endswith("sub-001_task-rest_eeg.vhdr") for n in names)
    assert any(n.endswith("sub-example01_task-example_eeg.vhdr") for n in names)
    assert not any("reference" in n or n.endswith("_annotations.json") for n in names)  # the answers stay hidden


# ---------------------------------------------------- assignments and matching
def test_assignments_and_matching(client: TestClient, recordings: Path) -> None:
    api = Api(client, "A01")
    a = api.ok("get", "/assignments")
    assert [i["recording_id"] for i in a["items"]] == [SUB1, SUB2, SUB3]
    assert a["next"] == SUB1 and all(i["status"] == "todo" for i in a["items"])
    edf = next(i for i in a["items"] if i["recording_id"] == SUB3)
    assert edf["format"] == "edf" and edf["n_channels"] == 22 and edf["size_bytes"] > 0
    m = api.ok("post", "/match", match_body(recordings, SUB3))
    assert m["status"] == "matched" and m["recording_id"] == SUB3 and m["mode"] == "standard"
    man = m["manifest"]
    assert man["format"] == "edf" and man["sfreq"] == 128.0
    assert "COUNTER" in man["hidden_channels"] and "COUNTER" not in man["ch_names"]
    assert man["fingerprint"]["hex"] == match_body(recordings, SUB3)["sha256"]
    assert man["original_events"] and man["display"]["scalings"]["eeg"] > 0
    assert m["draft"] is None
    # a copy that was changed: name, rate, length and channels match, the checksum does not
    body = {**match_body(recordings, SUB1), "sha256": "0" * 64, "sfreq": 250.0, "n_samples": 15000,
            "ch_names": man_channels(api, recordings, SUB1)}
    mm = api.ok("post", "/match", body)
    assert mm["status"] == "matched_metadata" and mm["recording_id"] == SUB1 and mm["differences"]
    unknown = api.ok("post", "/match", {"file_name": "other.edf", "size_bytes": 10, "sha256": "1" * 64})
    assert unknown["status"] == "unknown" and unknown["manifest"] is None
    # a training recording is a study recording, but not A01's
    na = api.ok("post", "/match", match_body(recordings, GUIDED1))
    assert na["status"] == "not_assigned"


def man_channels(api: Api, recordings: Path, rid: str) -> list[str]:
    return api.ok("post", "/match", match_body(recordings, rid))["manifest"]["ch_names"]


def test_drafts_are_kept_and_offered_again(client: TestClient, recordings: Path) -> None:
    api = Api(client, "A01")
    draft = {"annotations": [BLINK], "view": {"start_s": 12.0, "duration_s": 10.0}, "elapsed_s": 31.0}
    saved = api.ok("put", f"/drafts/{SUB2}?mode=standard", draft)
    assert saved["saved_at"]
    m = api.ok("post", "/match", match_body(recordings, SUB2))
    assert m["draft"]["annotations"] == [BLINK] and m["draft"]["elapsed_s"] == 31.0
    a = api.ok("get", "/assignments")
    assert next(i for i in a["items"] if i["recording_id"] == SUB2)["status"] == "in_progress"
    assert api.ok("get", "/assignments")["next"] == SUB2  # unfinished work first
    api.ok("delete", f"/drafts/{SUB2}?mode=standard")
    assert api.ok("post", "/match", match_body(recordings, SUB2))["draft"] is None
    assert api.put(f"/drafts/{GUIDED1}", draft).status_code == 404  # not a study recording
    assert api.put(f"/drafts/{GUIDED1}?mode=guided&context=example", draft).status_code == 403  # not A01's


# --------------------------------------------------------------------- saving
def test_saving_writes_the_desktop_outputs(client: TestClient, recordings: Path, study: Path) -> None:
    api = Api(client, "A01")
    api.ok("put", f"/drafts/{SUB1}", {"annotations": [BLINK], "view": {}, "elapsed_s": 3.0})
    r = api.ok("post", "/submissions", submission(recordings, SUB1, [BLINK, EMG]))
    assert r["saved"] and r["attempt"] == 1 and r["next"] == SUB2 and r["feedback"] is None
    assert sorted(r["files"]) == sorted(f"sub-001_task-rest_eeg_annotator-A01{s}" for s in (
        "_events.tsv", "_events.json", "_annotations.json", "_time_viewed.txt", "_session.json"))
    folder = study / "Annotated_Events" / "annotator-A01" / "sub-001" / "eeg"
    assert sorted(p.name for p in folder.iterdir()) == sorted(r["files"])
    doc = json.loads((folder / "sub-001_task-rest_eeg_annotator-A01_annotations.json").read_text())
    assert [a["label"] for a in doc["annotations"]] == ["Eye-blink-artifact", "EMG-artifact"]
    sess = json.loads((folder / "sub-001_task-rest_eeg_annotator-A01_session.json").read_text())
    assert sess["application"]["client"] == "web" and sess["timing"]["elapsed_seconds"] == 61.5
    assert sess["display"]["duration_s"] == 10.0
    assert any("SHA-256 matched" in n for n in sess["notes"])
    assert (folder / "sub-001_task-rest_eeg_annotator-A01_time_viewed.txt").read_text().strip() == "61.500"
    reg = CompletionRegister(OutputLayout(study / "Annotated_Events"))
    assert reg.is_completed(SUB1, "A01")
    # the draft is gone, the recording is done and is not saved twice
    m = api.ok("post", "/match", match_body(recordings, SUB1))
    assert m["status"] == "done"
    again = api.post("/submissions", submission(recordings, SUB1, [BLINK]))
    assert again.status_code == 409 and again.json()["error"] == "already_done"


@pytest.mark.parametrize("bad, words", [
    (ann("d" * 32, "Not-a-label", 10, 10), "label"),
    (ann("d" * 32, "EMG-artifact", 14990, 100), "sample"),
    (ann("d" * 32, "EMG-artifact", 10, 0), "sample"),
    (ann("d" * 32, "EMG-artifact", 10, 10, ["Fp1", "Nope"]), "channel"),
    ({**ann("d" * 32, "EMG-artifact", 10, 10), "onset_sample": 10.5}, "whole number"),
    ({**ann("d" * 32, "EMG-artifact", 10, 10), "annotation_id": "../x"}, "annotation_id"),
])
def test_invalid_annotations_are_refused(client: TestClient, recordings: Path, study: Path, bad: dict,
                                        words: str) -> None:
    api = Api(client, "A01")
    r = api.post("/submissions", submission(recordings, SUB1, [BLINK, bad]))
    assert r.status_code == 422 and r.json()["error"] == "invalid_annotation"
    assert words.lower() in r.json()["message"].lower()
    assert not (study / "Annotated_Events" / "annotator-A01" / "sub-001").exists()


def test_unsafe_recording_ids_are_refused(client: TestClient) -> None:
    api = Api(client, "A01")
    for rid in ("../../etc/passwd", "/etc/passwd", "sub-001/../../x.vhdr"):
        r = api.put(f"/drafts/{rid}", {"annotations": []})
        # Refused by the drafts route (403, 404) or, where ".." takes the path out of /api/v1, by the
        # application's static files, which take no PUT (405).
        assert r.status_code in (403, 404, 405), rid


def test_web_outputs_match_the_desktop(client: TestClient, recordings: Path, study: Path, tmp_path: Path) -> None:
    """The same annotations saved by the desktop application give the same files."""
    from electroclean.app.annotations.labels import default_catalogue
    from electroclean.app.annotations.model import ArtifactAnnotation
    from electroclean.app.eeg.loading import load_recording
    from electroclean.app.io.discovery import discover_recordings
    from electroclean.app.session.session import AnnotationSession
    from electroclean.web.store_files import FilesStore

    api = Api(client, "A01")
    for rid in (SUB1, SUB3):  # BrainVision and EDF+
        api.ok("post", "/submissions", submission(recordings, rid, [BLINK, EMG]))
    store = FilesStore(study)
    settings, cat = store.settings, default_catalogue()
    desktop = OutputLayout(tmp_path / "desktop" / "Annotated_Events")
    found = {r.recording_id: r for r in discover_recordings(recordings / "study")}
    for rid in (SUB1, SUB3):
        loaded = load_recording(found[rid], settings, settings.filters, cat)
        anns = [ArtifactAnnotation(a["annotation_id"], a["label"], a["onset_sample"], a["duration_samples"],
                                   tuple(a["channels"]), a["created_at"], a["modified_at"]) for a in (BLINK, EMG)]
        s = AnnotationSession(layout=desktop, settings=settings, filters=settings.filters, catalogue=cat,
                              loaded=loaded, annotator_id="A01", display_name="Annotator one",
                              initial_annotations=anns)
        s.start()
        s.finish()
        loaded.close()
        rel = Path("annotator-A01") / Path(rid).parent
        stem = Path(rid).name.rsplit(".", 1)[0] + "_annotator-A01"
        web_dir = study / "Annotated_Events" / rel
        assert (web_dir / f"{stem}_events.tsv").read_bytes() == (desktop.root / rel / f"{stem}_events.tsv").read_bytes()
        for suffix in ("_events.json", "_annotations.json"):  # the same but for the session's ID and time
            w = without_session(json.loads((web_dir / f"{stem}{suffix}").read_text()))
            d = without_session(json.loads((desktop.root / rel / f"{stem}{suffix}").read_text()))
            assert w == d, suffix
        ws = json.loads((web_dir / f"{stem}_session.json").read_text())
        ds = json.loads((desktop.root / rel / f"{stem}_session.json").read_text())
        assert ws["recording"] == ds["recording"]
        assert ws["annotations"] == ds["annotations"] and ws["original_events"] == ds["original_events"]
        assert ws["label_catalogue"] == ds["label_catalogue"] and ws["channel_check"] == ds["channel_check"]
    store.close()


def without_session(obj: object) -> object:
    """A JSON value without the fields that differ between two saves (session ID and time)."""
    if isinstance(obj, dict):
        return {k: without_session(v) for k, v in obj.items() if k not in ("session_id", "created_at")}
    if isinstance(obj, list):
        return [without_session(v) for v in obj]
    return obj


def test_agreement_analysis_runs_on_the_study_folder(client: TestClient, recordings: Path, study: Path,
                                                     tmp_path: Path) -> None:
    from electroclean.reliability.cli import main as agreement

    a1, a2 = Api(client, "A01"), Api(client, "A02")
    a1.ok("post", "/submissions", submission(recordings, SUB1, [BLINK, EMG]))
    a2.ok("post", "/submissions", submission(recordings, SUB1, [ann("e" * 32, "Eye-blink-artifact", 510, 95,
                                                                     ["Fp1", "Fp2"])]))
    out = tmp_path / "agreement"
    assert agreement([str(study / "Annotated_Events"), "--out", str(out), "--no-html"]) == 0
    assert any(out.glob("*.tsv"))


# --------------------------------------------------------------------- visits
def test_interaction_logs_are_desktop_logs(client: TestClient, study: Path) -> None:
    from electroclean.activity.logs import find_logs, read_visit_log
    from electroclean.activity.summary import summarise

    api = Api(client, "A01")
    v = api.ok("post", "/visits", {"client": {"user_agent": "pytest-browser", "screen": {"width": 1280,
                                                                                          "height": 800}}})
    assert v["logging"]["interactions"] is True and len(v["visit_id"]) == 32
    vid = v["visit_id"]
    events = [{"t": 1.5, "type": "recording_opened", "recording": SUB1},
              {"t": 2.0, "type": "key", "key": "1", "password": "never-kept"},
              {"t": 2.5, "type": "annotation_created", "recording": SUB1, "label": "Eye-blink-artifact"},
              {"t": 3.0, "type": "BAD TYPE"}]
    r = api.ok("post", f"/visits/{vid}/events", {"events": events})
    assert r == {"received": 3, "skipped": 1}
    # the page is being hidden: sendBeacon, which cannot set headers, sends the token in a text/plain body
    beacon = client.post(f"/api/v1/visits/{vid}/events", headers={"Content-Type": "text/plain"},
                         content=json.dumps({"token": api.token, "events": [{"t": 4.0, "type": "idle_start"}]}))
    assert beacon.status_code == 200
    closed = client.post(f"/api/v1/visits/{vid}/close", headers={"Content-Type": "text/plain"},
                         content=json.dumps({"token": api.token, "reason": "page_hidden"}))
    assert closed.status_code == 200
    assert api.post(f"/visits/{vid}/events", {"events": [{"t": 5.0, "type": "key"}]}).status_code == 409
    assert Api(client, "A02").post(f"/visits/{vid}/events", {"events": []}).status_code == 404  # not theirs
    logs = find_logs([study / "Annotated_Events"])
    assert len(logs) == 1 and logs[0].parent.name == "annotator-A01" and logs[0].name.endswith("_standard.jsonl")
    log = read_visit_log(logs[0])
    assert log.header["client"] == "web" and log.header["visit_id"] == vid and log.closed
    assert log.close_reason == "page_hidden" and log.bad_lines == 0
    assert [e["seq"] for e in log.events] == list(range(1, len(log.events) + 1))
    assert [e["type"] for e in log.events] == ["visit_started", "recording_opened", "key", "annotation_created",
                                               "idle_start", "log_closed"]
    assert "password" not in json.dumps(log.events)
    tables = summarise([log])
    assert tables  # electroclean-activity summarises it like a desktop visit


# ------------------------------------------------------------------- training
def test_guided_training_with_the_coach(client: TestClient, recordings: Path, study: Path) -> None:
    from electroclean.training.guided import STARS_FIRST, STARS_SHOWN
    from electroclean.web.store_files import FilesStore

    store = FilesStore(study)
    steps = reference_annotations(store, "example", GUIDED1)
    store.close()
    api = Api(client, "T01")
    me = api.ok("get", "/me")
    assert me["programme"] == {"set_id": "example", "name": me["programme"]["name"]}
    tr = api.ok("get", "/training")
    assert [(s["key"], s["status"]) for s in tr["stages"]] == [("guided", "available"), ("practice", "locked"),
                                                               ("assessment", "not_used")]
    assert tr["next"]["recording_id"] == GUIDED1 and tr["next"]["mode"] == "guided"
    items = api.ok("get", "/assignments")["items"]
    assert {(i["recording_id"], i["mode"]) for i in items} == {(GUIDED1, "guided"), (GUIDED2, "guided")}
    m = api.ok("post", "/match", match_body(recordings, GUIDED1))
    assert m["status"] == "matched" and m["mode"] == "guided" and m["context_id"] == "example"
    g = api.ok("get", f"/training/guided/{GUIDED1}")
    assert g["n_steps"] == len(steps) and g["guidance"] == "show" and g["completed"] == []
    cur = g["current"]
    t = steps[0]
    assert cur["step"] == 1 and cur["label"] == t.label and cur["ghost"]["onset_sample"] == t.onset_sample
    assert cur["view"]["duration_s"] == 10.0
    # a first try that starts too early
    early = as_wire(t, "f" * 32)
    early["onset_sample"] -= 200
    early["duration_samples"] += 200
    c = api.ok("post", f"/training/guided/{GUIDED1}/check", {"step": 1, "annotations": [early]})
    assert not c["matched"] and "start" in c["problems"] and not c["can_continue"] and c["stars"] is None
    assert "too early" in c["messages"][0]
    # the same annotations checked again do not count as another attempt
    assert api.ok("post", f"/training/guided/{GUIDED1}/check", {"step": 1, "annotations": [early]})[
        "failed_attempts"] == 1
    # Continue before it matches is refused; checking the wrong step too
    assert api.post(f"/training/guided/{GUIDED1}/continue", {"step": 1}).json()["error"] == "not_matched"
    assert api.post(f"/training/guided/{GUIDED1}/check", {"step": 2, "annotations": []}).json()["error"] == "wrong_step"
    mine = [as_wire(t, "1" * 32)]
    c = api.ok("post", f"/training/guided/{GUIDED1}/check", {"step": 1, "annotations": mine})
    assert c["matched"] and c["can_continue"] and c["stars"] == 2
    nxt = api.ok("post", f"/training/guided/{GUIDED1}/continue", {"step": 1})
    assert nxt["previous"]["stars"] == 2 and nxt["step"] == 2
    # step 2 with Show me: the experts' annotation to place, one star
    sm = api.ok("post", f"/training/guided/{GUIDED1}/show-me", {"step": 2, "annotations": mine})
    assert sm["annotation"]["label"] == steps[1].label and sm["stars"] == STARS_SHOWN
    mine.append(sm["annotation"])
    c = api.ok("post", f"/training/guided/{GUIDED1}/check", {"step": 2, "annotations": mine})
    assert c["can_continue"] and c["stars"] == STARS_SHOWN
    api.ok("post", f"/training/guided/{GUIDED1}/continue", {"step": 2})
    # an extra annotation where the experts marked nothing must be removed first
    extra = ann("9" * 32, "EMG-artifact", 14000, 50)
    for i, t in enumerate(steps[2:], start=3):
        a = as_wire(t, f"{i:032x}")
        c = api.ok("post", f"/training/guided/{GUIDED1}/check", {"step": i, "annotations": mine + [a, extra]})
        assert c["matched"] and not c["can_continue"] and "extra" in c["problems"] and c["extras"] == [extra[
            "annotation_id"]]
        c = api.ok("post", f"/training/guided/{GUIDED1}/check", {"step": i, "annotations": mine + [a]})
        assert c["can_continue"] and c["stars"] == STARS_FIRST
        mine.append(a)
        last = api.ok("post", f"/training/guided/{GUIDED1}/continue", {"step": i})
    assert last["complete"] and last["summary"]["steps"] == len(steps)
    stars = 2 + STARS_SHOWN + STARS_FIRST * (len(steps) - 2)
    assert last["summary"]["stars"] == stars and last["summary"]["max_stars"] == STARS_FIRST * len(steps)
    # the guided state survives (another request, another server process)
    assert api.ok("get", f"/training/guided/{GUIDED1}")["complete"] is True
    # saving checks every step again
    bad = api.post("/submissions", submission(recordings, GUIDED1, mine[1:], "guided", "example"))
    assert bad.status_code == 422 and bad.json()["error"] == "guided_incomplete"
    assert api.ok("get", f"/training/guided/{GUIDED1}")["current"]["step"] == 1  # shown again
    for i, a in enumerate(mine, start=1):  # match them again, now on the first try each
        api.ok("post", f"/training/guided/{GUIDED1}/check", {"step": i, "annotations": mine})
        api.ok("post", f"/training/guided/{GUIDED1}/continue", {"step": i})
    r = api.ok("post", "/submissions", submission(recordings, GUIDED1, mine, "guided", "example"))
    assert r["guided"]["summary"]["steps"] == len(steps) and "stars" in r["guided"]["message"]
    assert r["next"] == GUIDED2
    tr = api.ok("get", "/training")
    assert tr["stages"][0]["status"] == "in_progress" and tr["stages"][0]["done"] == 1
    sess = next((study / "Annotated_Events" / "training" / "example" / "guided").rglob("*_session.json"))
    assert json.loads(sess.read_text())["context"]["guided"]["steps"] == len(steps)
    prog = study / "Annotated_Events" / "training_progress" / "example" / "annotator-T01.json"
    assert GUIDED1 in json.loads(prog.read_text())["guided"]


def _finish_guided(api: Api, study: Path, recordings: Path, rid: str) -> None:
    from electroclean.web.store_files import FilesStore

    store = FilesStore(study)
    steps = reference_annotations(store, "example", rid)
    store.close()
    mine = [as_wire(t, f"{i + 1:032x}") for i, t in enumerate(steps)]
    for i in range(1, len(steps) + 1):
        api.ok("post", f"/training/guided/{rid}/check", {"step": i, "annotations": mine})
        api.ok("post", f"/training/guided/{rid}/continue", {"step": i})
    api.ok("post", "/submissions", submission(recordings, rid, mine, "guided", "example"))


def test_practice_feedback_reveals_the_reference_after_saving(client: TestClient, recordings: Path,
                                                               study: Path) -> None:
    from electroclean.web.store_files import FilesStore

    api = Api(client, "T01")
    assert api.post("/submissions", submission(recordings, PRACTICE1, [], "practice", "example")).status_code == 403
    for rid in (GUIDED1, GUIDED2):
        _finish_guided(api, study, recordings, rid)
    tr = api.ok("get", "/training")
    assert tr["stages"][1]["status"] == "available" and tr["next"]["recording_id"] == PRACTICE1
    store = FilesStore(study)
    ref = reference_annotations(store, "example", PRACTICE1)
    store.close()
    mine = [as_wire(a, f"{i + 1:032x}") for i, a in enumerate(ref[:-1])]  # one missed
    r = api.ok("post", "/submissions", submission(recordings, PRACTICE1, mine, "practice", "example"))
    fb = r["feedback"]
    assert fb["review"] and fb["metrics"]["event_recall"] < 1.0 and fb["summary_html"].startswith("<h2>")
    assert [f["kind"] for f in fb["flags"]] == ["MISSED"] and fb["flags"][0]["source"] == "reference"
    assert len(fb["reference"]) == len(ref) and fb["pass_rule"]
    tr = api.ok("get", "/training")
    if not fb["passed"]:  # every practice recording done without passing: this one may be done again
        assert tr["next"]["repeat"] is True
        m = api.ok("post", "/match", match_body(recordings, PRACTICE1))
        assert m["status"] == "matched" and m["repeat"] is True
        perfect = [as_wire(a, f"{i + 1:032x}") for i, a in enumerate(ref)]
        r2 = api.ok("post", "/submissions", submission(recordings, PRACTICE1, perfect, "practice", "example"))
        assert r2["attempt"] == 2 and r2["feedback"]["passed"] is True and r2["feedback"]["flags"] == []
    tr = api.ok("get", "/training")
    assert tr["stages"][1]["status"] == "completed" and tr["complete"] is True


def test_assessment_completion_gives_the_competency_result(client: TestClient, recordings: Path,
                                                            study: Path) -> None:
    from electroclean.training.reference import ReferenceSet
    from electroclean.web.store_files import FilesStore

    store = FilesStore(study)
    rs = store.reference_set("example")
    rs2 = ReferenceSet.load(rs.directory)
    rs2.set_use(PRACTICE1, "assessment")
    rs2.save()
    store.assign("A01", [PRACTICE1], mode="assessment", context_id="example")
    ref = reference_annotations(store, "example", PRACTICE1)
    store.close()
    api = Api(client, "A01")
    m = api.ok("post", "/match", match_body(recordings, PRACTICE1))
    assert m["status"] == "matched" and m["mode"] == "assessment"
    r = api.ok("post", "/submissions", submission(recordings, PRACTICE1, [as_wire(a, f"{i + 1:032x}")
                                                                         for i, a in enumerate(ref)],
                                                  "assessment", "example"))
    assert r["feedback"] is None and r["assessment"]["complete"] is True
    # every recording done: a result (the example set has no criteria, so it is not judged)
    assert r["assessment"]["status"] in ("met", "not_met", "not_determined")
    assert "assessment" in r["assessment"]["summary_html"]
    report = study / "Annotated_Events" / "training" / "example" / "reports" / "annotator-A01_competency_report.json"
    assert json.loads(report.read_text())["status"] == r["assessment"]["status"]


# ------------------------------------------------------------- administration
def test_administration(client: TestClient, recordings: Path) -> None:
    a01 = Api(client, "A01")
    a01.ok("post", "/submissions", submission(recordings, SUB1, [BLINK]))
    assert a01.get("/admin/progress").status_code == 403
    assert a01.get("/admin/results.zip").status_code == 403
    admin = Api(client, "ADMIN")
    p = admin.ok("get", "/admin/progress")
    rows = {a["annotator_id"]: a for a in p["annotators"]}
    assert set(rows) == {"ADMIN", "A01", "A02", "T01"}
    first = next(i for i in rows["A01"]["items"] if i["recording_id"] == SUB1)
    assert first["status"] == "done" and first["attempts"] == 1 and first["last_activity"]
    assert rows["T01"]["programme"]["set_id"] == "example"
    z = admin.get("/admin/results.zip")
    assert z.status_code == 200 and z.headers["content-type"] == "application/zip"
    names = zipfile.ZipFile(io.BytesIO(z.content)).namelist()
    assert "Annotated_Events/completion_register.tsv" in names
    assert any(n.endswith("sub-001_task-rest_eeg_annotator-A01_events.tsv") for n in names)
    assert not any("/.electroclean/" in n for n in names)
