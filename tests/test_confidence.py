"""Confidence ratings (a 5-point scale) and notes on annotations: the model, the store, the five result
files, the study setting, the service's checks and the agreement analysis (docs/design_decisions.md,
"Confidence and notes")."""

from __future__ import annotations

import dataclasses
import json
import time

import pytest

from electrotag.app.annotations.labels import default_catalogue
from electrotag.app.annotations.model import (
    CONFIDENCE_ANCHORS,
    MAX_NOTE_CHARS,
    AnnotationDocument,
    AnnotationError,
    ArtifactAnnotation,
    RecordingInfo,
    check_note,
    is_confidence,
    join_notes,
    lower_confidence,
)
from electrotag.app.annotations.store import AnnotationStore
from electrotag.app.annotations.timing import RecordingTiming
from electrotag.app.io.canonical import document_from_dict, document_to_dict
from electrotag.app.io.export import annotations_from_events_tsv, build_events_sidecar, events_tsv_bytes
from electrotag.app.io.tsv import parse_tsv_text, tsv_bytes
from electrotag.config.settings import Settings, SettingsError, load_default_settings_dict
from electrotag.reliability.analysis import run_analysis, write_outputs
from electrotag.reliability.config import ANY_ARTIFACT, AnalysisConfig
from electrotag.reliability.data import build_dataset
from tests.conftest import make_session

CAT = default_catalogue()
CH = ("C1", "C2", "C3", "C4")
SF = 100.0


def _store(**kw):
    rec = RecordingInfo("rec", RecordingTiming(SF, 10000), CH)
    return AnnotationStore(rec, CAT, **kw)


# ------------------------------------------------------------------ the model
def test_the_scale_has_five_anchored_levels():
    assert CONFIDENCE_ANCHORS == {1: "Not at all confident", 2: "Slightly confident", 3: "Moderately confident",
                                  4: "Very confident", 5: "Completely confident"}
    assert [is_confidence(v) for v in (1, 5, 0, 6, 3.0, "3", True, None)] == [True, True] + [False] * 6


def test_notes_are_checked_and_joined():
    assert check_note("  blink or eye movement? ") == "blink or eye movement?"
    assert check_note(None) == "" and check_note("") == ""
    assert check_note("x" * MAX_NOTE_CHARS) == "x" * MAX_NOTE_CHARS
    for bad, why in (("x" * (MAX_NOTE_CHARS + 1), "at most 200"), ("two\nlines", "single line"),
                     ("a\ttab", "single line"), ("n/a", "n/a"), (5, "text")):
        with pytest.raises(AnnotationError, match=why):
            check_note(bad)
    assert join_notes(["first", "", "second", "first"]) == "first; second"
    long = join_notes(["a" * 150, "b" * 150])
    assert len(long) == MAX_NOTE_CHARS and long.endswith("…") and long.startswith("a" * 150 + "; ")


def test_the_lower_rating_wins_and_an_unrated_mark_adds_nothing():
    assert lower_confidence([5, 2, 4]) == 2
    assert lower_confidence([4, None]) == 4
    assert lower_confidence([None, None]) is None


def test_old_annotation_files_read_as_not_rated_and_no_note():
    rec = RecordingInfo("rec", RecordingTiming(SF, 1000), CH)
    doc = AnnotationDocument(rec, "A", [ArtifactAnnotation("x", "EMG-artifact", 10, 20)], CAT)
    data = document_to_dict(doc)
    for a in data["annotations"]:
        del a["confidence"], a["note"]
    data["schema_version"] = "1.0.0"
    back = document_from_dict(data)
    assert (back.annotations[0].confidence, back.annotations[0].note, back.confidence_mode) == (None, "", "")


def test_annotation_file_keeps_rating_note_and_setting():
    rec = RecordingInfo("rec", RecordingTiming(SF, 1000), CH)
    anns = [ArtifactAnnotation("x", "EMG-artifact", 10, 20, confidence=2, note="near the chin"),
            ArtifactAnnotation("y", "Eye-blink-artifact", 100, 20)]
    doc = AnnotationDocument(rec, "A", anns, CAT, confidence_mode="every_mark")
    data = json.loads(json.dumps(document_to_dict(doc)))
    assert data["schema_version"] == "1.2.0" and data["session"]["confidence"] == "every_mark"
    assert [(a["confidence"], a["note"]) for a in data["annotations"]] == [(2, "near the chin"), (None, "")]
    assert data["confidence_convention"]["levels"]["1"] == "Not at all confident"
    back = document_from_dict(data)
    assert [(a.confidence, a.note) for a in back.sorted_annotations()] == [(2, "near the chin"), (None, "")]
    for bad in (6, "3", 2.5, True):
        data["annotations"][0]["confidence"] = bad
        with pytest.raises(AnnotationError, match="whole number from 1 to 5"):
            document_from_dict(data)


# ------------------------------------------------------------------ the setting
def test_the_study_setting_is_optional_by_default_and_checked():
    d = load_default_settings_dict()
    assert d["annotation"]["confidence"] == "optional"
    assert Settings.from_dict(d).confidence == "optional"
    for given, read in (("every_mark", "every_mark"), ("on", "every_mark"), ("off", "optional")):
        d["annotation"]["confidence"] = given
        assert Settings.from_dict(d).confidence == read
    for bad in ("always", True, None):
        d["annotation"]["confidence"] = bad
        with pytest.raises(SettingsError, match='annotation.confidence must be "optional"'):
            Settings.from_dict(d)


# ------------------------------------------------------------------ the store
def test_new_marks_are_never_rated_and_ratings_undo():
    s = _store()
    a = s.add("EMG-artifact", 100, 50)
    assert (a.confidence, a.note) == (None, "")
    s.set_confidence(a.annotation_id, 4)
    assert s.get(a.annotation_id).confidence == 4 and s.undo_description == "set confidence 4"
    s.set_confidence(a.annotation_id, None)
    assert s.get(a.annotation_id).confidence is None and s.undo_description == "clear confidence"
    s.set_note(a.annotation_id, "might be a cable")
    assert s.undo_description == "add note"
    s.set_note(a.annotation_id, "a cable")
    assert s.undo_description == "change note"
    s.set_note(a.annotation_id, "")
    assert s.undo_description == "remove note" and s.get(a.annotation_id).note == ""
    states = []
    for _ in range(5):
        s.undo()
        cur = s.get(a.annotation_id)
        states.append((cur.confidence, cur.note))
    assert states == [(None, "a cable"), (None, "might be a cable"), (None, ""), (4, ""), (None, "")]
    s.redo()
    assert s.get(a.annotation_id).confidence == 4
    for bad in (6, "4", True, 2.5):
        with pytest.raises(AnnotationError, match="1 to 5"):
            s.set_confidence(a.annotation_id, bad)
    with pytest.raises(AnnotationError, match="at most 200"):
        s.set_note(a.annotation_id, "x" * 201)


def test_several_marks_are_rated_in_one_step():
    s = _store()
    a = s.add("EMG-artifact", 100, 50)
    b = s.add("Movement-artifact", 2000, 50)
    s.set_confidence_many([a.annotation_id, b.annotation_id], 3)
    assert {x.confidence for x in s.annotations()} == {3}
    assert s.undo_description == "set confidence 3 (2 annotations)"
    with pytest.raises(AnnotationError):
        s.set_confidence_many([a.annotation_id], 0)


def test_automatic_merge_keeps_the_lower_rating_and_both_notes():
    s = _store()
    a = s.add("EMG-artifact", 100, 100, confidence=5, note="jaw")
    s.add("Eye-blink-artifact", 120, 30, confidence=1, note="other type")  # another type: not merged
    b = s.add("EMG-artifact", 150, 100, confidence=3, note="chewing?")
    assert b.annotation_id == a.annotation_id and s.last_auto_merged == 1
    merged = s.get(a.annotation_id)
    assert (merged.onset_sample, merged.duration_samples) == (100, 150)
    assert (merged.confidence, merged.note) == (3, "jaw; chewing?")
    s.undo()
    assert len(s) == 2 and s.get(a.annotation_id).confidence == 5
    # Without a rating on one side, the other's is kept.
    c = s.add("EMG-artifact", 5000, 100)
    s.add("EMG-artifact", 5050, 100, confidence=2)
    assert s.get(c.annotation_id).confidence == 2 and s.get(c.annotation_id).note == ""


def test_explicit_merge_follows_the_same_rule():
    s = _store()
    a = s.add("EMG-artifact", 100, 50, ["C1"], note="left")
    b = s.add("EMG-artifact", 400, 50, ["C2"], confidence=4, note="right")
    m = s.merge([b.annotation_id, a.annotation_id])
    assert (m.confidence, m.note, m.channels) == (4, "left; right", ("C1", "C2"))


# ------------------------------------------------------------- the result files
def _session_with_marks(layout, settings, catalogue, loaded):
    s = make_session(layout, settings, catalogue, loaded)
    s.start()
    s.start_timer()
    one = s.store.add_interval("EMG-artifact", 2.0, 3.0)
    two = s.store.add_interval("Eye-blink-artifact", 5.0, 5.4, ["Fp1"])
    s.store.add_interval("Movement-artifact", 8.0, 9.0)
    s.store.set_confidence(one.annotation_id, 2)
    s.store.set_confidence(two.annotation_id, 5)
    s.store.set_note(two.annotation_id, "could be an eye movement")
    time.sleep(0.02)
    return s, s.finish()


def _rows(path):
    cols, rows = parse_tsv_text(path.read_text(encoding="utf-8"))
    return cols, [dict(zip(cols, r, strict=True)) for r in rows]


@pytest.mark.parametrize("mode", ["optional", "every_mark"])
def test_saved_files_carry_ratings_and_notes(layout, settings, catalogue, loaded, mode):
    settings = dataclasses.replace(settings, confidence=mode)
    s, res = _session_with_marks(layout, settings, catalogue, loaded)
    cols, rows = _rows(res.commit.paths["events_tsv"])
    assert cols[-2:] == ["confidence", "annotation_note"]
    art = {r["trial_type"]: r for r in rows if r["event_source"] == "electrotag_artifact"}
    assert (art["EMG-artifact"]["confidence"], art["EMG-artifact"]["annotation_note"]) == ("2", "n/a")
    assert (art["Eye-blink-artifact"]["confidence"], art["Eye-blink-artifact"]["annotation_note"]) == (
        "5", "could be an eye movement")
    assert art["Movement-artifact"]["confidence"] == "n/a"  # no mark starts with a rating, in either setting
    originals = [r for r in rows if r["event_source"].startswith("original:")]
    assert originals and all(r["confidence"] == r["annotation_note"] == "n/a" for r in originals)
    sidecar = json.loads(res.commit.paths["events_json"].read_text(encoding="utf-8"))
    assert sidecar["confidence"]["Levels"] == {str(k): v for k, v in CONFIDENCE_ANCHORS.items()}
    assert "5-point Likert" in sidecar["confidence"]["Description"] and "annotation_note" in sidecar
    assert ("self-selected" in sidecar["confidence"]["Description"]) == (mode == "optional")
    assert sidecar["ElectroTagMetadata"]["confidence_setting"] == mode
    meta = json.loads(res.commit.paths["session_json"].read_text(encoding="utf-8"))
    block = meta["annotations"]["confidence"]
    assert block["setting"] == mode and meta["annotations"]["n_with_note"] == 1
    assert block["by_level"] == {"1": 0, "2": 1, "3": 0, "4": 0, "5": 1}
    assert (block["n_given"], block["n_not_given"]) == (2, 1)
    doc = json.loads(res.commit.paths["annotations_json"].read_text(encoding="utf-8"))
    assert doc["session"]["confidence"] == mode


def test_events_files_without_the_new_columns_are_still_read(layout, settings, catalogue, loaded):
    s = make_session(layout, settings, catalogue, loaded)
    s.store.add_interval("EMG-artifact", 2.0, 3.0)
    doc = s.build_document()
    cols, rows = parse_tsv_text(events_tsv_bytes(loaded.original_events, doc).decode())
    keep = [i for i, c in enumerate(cols) if c not in ("confidence", "annotation_note")]
    old = tsv_bytes([cols[i] for i in keep], [[r[i] for i in keep] for r in rows])
    back = annotations_from_events_tsv(old, doc.recording, catalogue)
    assert [(a.label, a.confidence, a.note) for a in back] == [("EMG-artifact", None, "")]


def test_read_back_check_catches_a_lost_or_wrong_rating(layout, settings, catalogue, loaded):
    from electrotag.app.validation.exports import ValidationError, validate_events_tsv

    s = make_session(layout, settings, catalogue, loaded)
    a = s.store.add_interval("EMG-artifact", 2.0, 3.0)
    s.store.set_confidence(a.annotation_id, 4)
    doc = s.build_document()
    good = events_tsv_bytes(loaded.original_events, doc)
    validate_events_tsv(good, loaded.original_events, doc)
    with pytest.raises(ValidationError, match="do not reproduce"):
        validate_events_tsv(good.replace(b"\t4\tn/a\n", b"\tn/a\tn/a\n"), loaded.original_events, doc)
    with pytest.raises(AnnotationError, match="whole number from 1 to 5"):
        validate_events_tsv(good.replace(b"\t4\tn/a\n", b"\t7\tn/a\n"), loaded.original_events, doc)
    sidecar, _ = build_events_sidecar({}, loaded.original_events, doc)
    assert sidecar["confidence"]["Levels"]["3"] == "Moderately confident"


# ------------------------------------------------------------------ the service
def test_service_takes_whole_ratings_from_1_to_5_only():
    from electrotag.web.errors import ApiError
    from electrotag.web.service import parse_annotations

    rec = RecordingInfo("rec", RecordingTiming(SF, 1000), CH)
    base = {"annotation_id": "a1", "label": "EMG-artifact", "onset_sample": 10, "duration_samples": 20,
            "channels": []}
    ok = parse_annotations([{**base, "confidence": 5, "note": " jaw "}], rec, CAT, 1)
    assert (ok[0].confidence, ok[0].note) == (5, "jaw")
    none = parse_annotations([{**base, "confidence": None}], rec, CAT, 1)
    assert (none[0].confidence, none[0].note) == (None, "")
    for bad in ({"confidence": 0}, {"confidence": 6}, {"confidence": "3"}, {"confidence": 2.5},
                {"confidence": True}, {"confidence": "high"}, {"note": "x" * 201}, {"note": ["x"]},
                {"note": "a\nb"}):
        with pytest.raises(ApiError) as exc:
            parse_annotations([{**base, **bad}], rec, CAT, 1)
        assert exc.value.status == 422


# ------------------------------------------------------------------ the analyses
def _doc(annotator, anns, mode="optional", rid="rec.vhdr"):
    rec = RecordingInfo(rid, RecordingTiming(SF, 1000), CH)
    items = [ArtifactAnnotation(f"{annotator}-{i}", lab, int(a * SF), int((b - a) * SF), (), confidence=c, note=n)
             for i, (lab, a, b, c, n) in enumerate(anns)]
    return AnnotationDocument(rec, annotator, items, CAT, session_id=annotator, confidence_mode=mode)


def _analyse(docs, **cfg):
    config = AnalysisConfig(**{"resolutions_s": (1.0,), **cfg})
    return run_analysis(build_dataset([(d.annotator_id, d) for d in docs], config), config)


def _pair(mode="optional"):
    # Both agree on the confident blink; A also marks EMG with low confidence, B a movement A does not mark.
    a = _doc("A", [("Eye-blink-artifact", 1.0, 1.5, 5, ""), ("EMG-artifact", 4.0, 6.0, 2, "jaw?")], mode)
    b = _doc("B", [("Eye-blink-artifact", 1.0, 1.5, None, ""), ("Movement-artifact", 7.0, 8.0, 4, "head turn")], mode)
    return a, b


def test_analysis_reports_each_annotators_ratings():
    res = _analyse(list(_pair()))
    by = res.table("confidence_by_annotator").set_index("annotator")
    assert by.loc["A", "n_rated"] == 2 and by.loc["A", "n_rated_2"] == 1 and by.loc["A", "n_rated_5"] == 1
    assert by.loc["A", "share_rated"] == 1.0 and by.loc["A", "median_confidence"] == 3.5
    assert by.loc["B", "n_rated"] == 1 and by.loc["B", "n_not_rated"] == 1 and by.loc["B", "median_confidence"] == 4
    assert by.loc["B", "n_with_note"] == 1 and by.loc["A", "confidence_setting"] == "optional"
    assert res.settings_record["confidence"]["setting"] == "optional"


def test_sensitivity_analysis_leaves_out_low_confidence_marks():
    res = _analyse(list(_pair()))
    sens = res.table("confidence_sensitivity")
    anyrow = sens[(sens.category == ANY_ARTIFACT) & (sens.channel_mode == "time_only")].iloc[0]
    assert (anyrow.n_marks_all, anyrow.n_marks_without_low_confidence) == (4, 3)
    assert anyrow.f1_all == pytest.approx(0.5)  # 2 of 4 events matched
    assert anyrow.f1_without_low_confidence == pytest.approx(2 / 3)
    # Positive agreement: blink 0.5 s both; all marks: EMG 2 s only A, movement 1 s only B.
    assert anyrow.positive_agreement_all == pytest.approx(1.0 / (1.0 + 3.0))
    assert anyrow.positive_agreement_without_low_confidence == pytest.approx(1.0 / (1.0 + 1.0))
    ev = res.table("events_summary")  # the main tables still use every mark
    main = ev[(ev.category == ANY_ARTIFACT) & (ev.channel_mode == "time_only") & (ev.threshold == 0.2)].iloc[0]
    assert main.f1 == pytest.approx(0.5)


def test_calibration_gives_the_share_found_by_another_annotator_per_rating():
    a, b = _pair()
    c = _doc("C", [("EMG-artifact", 4.1, 6.0, 3, ""), ("Eye-blink-artifact", 1.0, 1.4, 5, "")])
    cal = _analyse([a, b, c]).table("confidence_calibration")
    row = lambda who, lv: cal[(cal.annotator == who) & (cal.confidence == lv)].iloc[0]  # noqa: E731
    assert (row("A", 5).n_marks, row("A", 5).n_matched) == (1, 1)  # the blink, found by B and C
    assert (row("A", 2).n_matched, row("A", 2).anchor) == (1, "Slightly confident")  # the EMG, found by C
    assert (row("B", 4).n_marks, row("B", 4).n_matched, row("B", 4).share_matched) == (1, 0, 0.0)
    assert row("B", "not rated").n_matched == 1
    everyone = row("ALL annotators", 5)
    assert (everyone.n_marks, everyone.n_matched) == (2, 2)


def test_without_any_rating_there_is_no_sensitivity_or_calibration():
    a = _doc("A", [("EMG-artifact", 1.0, 2.0, None, "")])
    b = _doc("B", [("EMG-artifact", 1.0, 2.0, None, "")])
    res = _analyse([a, b])
    assert res.table("confidence_sensitivity").empty and res.table("confidence_calibration").empty
    assert list(res.table("confidence_sensitivity").columns)[:4] == ["category", "channel_mode", "rater_1", "rater_2"]
    assert "reported once" in res.settings_record["confidence"]["explanation"]


def test_every_mark_explanation_and_notes_only_in_per_annotation_tables(tmp_path):
    res = _analyse(list(_pair("every_mark")))
    assert "asked to rate each new mark" in res.settings_record["confidence"]["explanation"]
    un = res.table("events_unmatched")
    emg = un[(un.label == "EMG-artifact") & (un.category == "EMG-artifact")].iloc[0]
    assert (emg.confidence, emg.note) == (2, "jaw?")
    matched = res.table("events_matched")
    blink = matched[matched.category == "Eye-blink-artifact"].iloc[0]
    assert blink.reference_confidence == 5 and blink.compared_confidence is None
    stats_tables = [n for n in res.tables if n not in ("events_matched", "events_unmatched")]
    for n in stats_tables:
        text = res.tables[n].to_csv()
        assert "jaw?" not in text and "head turn" not in text, n
    paths = write_outputs(res, tmp_path / "out")
    for name in ("confidence_by_annotator", "confidence_sensitivity", "confidence_calibration"):
        assert paths[name].exists()
    html = paths["report"].read_text(encoding="utf-8")
    assert "5. Confidence of the annotations" in html and "asked to rate each new mark" in html
    assert "Kappa, without low confidence" in html and "Share found by another" in html and "jaw?" not in html


def test_optional_report_says_ratings_were_volunteered():
    res = _analyse(list(_pair()))
    from electrotag.reliability.report import build_html_report

    html = build_html_report(res)
    assert "self-selected subset" in html and "Share rated" in html


# ------------------------------------------------------------------ the server, end to end
fastapi = pytest.importorskip("fastapi")


@pytest.fixture(scope="module")
def template(tmp_path_factory):
    from tests.web_helpers import make_template

    return make_template(tmp_path_factory.mktemp("web-demo-confidence"))


@pytest.fixture
def client(template, tmp_path):
    from fastapi.testclient import TestClient

    from electrotag.web.app import create_app
    from tests.web_helpers import copy_demo

    app = create_app(copy_demo(template, tmp_path), demo=True)
    yield TestClient(app)
    app.state.store.close()


def test_server_sends_the_setting_checks_drafts_and_saves_both_fields(client, template, tmp_path):
    from tests.web_helpers import SUB1, SUB2, Api, ann, submission

    api, admin = Api(client, "A01"), Api(client, "ADMIN")
    assert api.ok("get", "/me")["study"]["annotation"]["confidence"] == "optional"
    admin.admin_error("settings_update", {"settings": {"annotation": {"confidence": "always"}}}, 400,
                      "invalid_settings")
    admin.admin_ok("settings_update", {"settings": {"annotation": {"confidence": "every_mark"}}})
    assert api.ok("get", "/me")["study"]["annotation"]["confidence"] == "every_mark"

    sure = {**ann("d" * 32, "EMG-artifact", 3000, 250), "confidence": 2, "note": "jaw clench?"}
    plain = ann("e" * 32, "Eye-blink-artifact", 500, 100, ["Fp1"])
    api.ok("put", f"/drafts/{SUB2}?mode=standard", {"annotations": [sure], "view": {}, "elapsed_s": 3.0})
    for bad in ({"confidence": 6}, {"confidence": "3"}, {"confidence": True}, {"note": "x" * 201}):
        r = api.put(f"/drafts/{SUB2}?mode=standard", {"annotations": [{**sure, **bad}], "view": {}, "elapsed_s": 3.0})
        assert (r.status_code, r.json()["error"]) == (422, "invalid_draft"), r.text
    r = api.post("/submissions", submission(template / "recordings", SUB1, [{**sure, "confidence": 0}]))
    assert (r.status_code, r.json()["error"]) == (422, "invalid_annotation")

    api.ok("post", "/submissions", submission(template / "recordings", SUB1, [sure, plain]))
    folder = tmp_path / "study" / "Annotated_Events" / "annotator-A01" / "sub-001" / "eeg"
    cols, rows = _rows(next(folder.glob("*_events.tsv")))
    art = {r["trial_type"]: r for r in rows if r["event_source"] == "electrotag_artifact"}
    assert (art["EMG-artifact"]["confidence"], art["EMG-artifact"]["annotation_note"]) == ("2", "jaw clench?")
    assert (art["Eye-blink-artifact"]["confidence"], art["Eye-blink-artifact"]["annotation_note"]) == ("n/a", "n/a")
    meta = json.loads(next(folder.glob("*_session.json")).read_text(encoding="utf-8"))
    assert meta["annotations"]["confidence"]["setting"] == "every_mark"
    assert meta["annotations"]["confidence"]["by_level"] == {"1": 0, "2": 1, "3": 0, "4": 0, "5": 0}
    assert (meta["annotations"]["confidence"]["n_given"], meta["annotations"]["confidence"]["n_not_given"]) == (1, 1)

    # A revision opens with both fields as saved.
    from tests.web_helpers import match_body

    m = api.ok("post", "/match", {**match_body(template / "recordings", SUB1), "revise": True})
    saved = {a["annotation_id"]: a for a in m["revision"]["annotations"]}
    assert (saved["d" * 32]["confidence"], saved["d" * 32]["note"]) == (2, "jaw clench?")
    assert (saved["e" * 32]["confidence"], saved["e" * 32]["note"]) == (None, "")
