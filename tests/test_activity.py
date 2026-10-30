"""Interaction logs: the log files, reading them safely, and the analytics (tables and report)."""

from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone

import pytest

from electrotag.activity.cli import main as activity_main
from electrotag.activity.cli import write_activity
from electrotag.activity.logs import find_logs, read_logs, read_visit_log
from electrotag.activity.summary import active_seconds, replay_annotations, summarise
from electrotag.app.session.interaction_log import NULL_LOG, InteractionLog
from tests.activity_logs_helper import LogBuilder, demo_logs

T0 = datetime(2026, 10, 1, 9, 0, tzinfo=timezone.utc)


def rows_for(*paths):
    visits, warnings = read_logs(paths)
    return summarise(visits, warnings=warnings)


# ------------------------------------------------------------------ the log
def test_log_lines_header_context_and_null_log(tmp_path):
    log = InteractionLog(tmp_path / "v.jsonl", {"annotator_id": "A01"})
    log.context["recording"] = "sub-001"
    log.event("thing", value=float("nan"), items=(1, 2), path=tmp_path, kind="field called kind")
    log.close(reason="test")
    lines = [json.loads(x) for x in (tmp_path / "v.jsonl").read_text(encoding="utf-8").splitlines()]
    assert lines[0]["type"] == "header" and lines[0]["annotator_id"] == "A01"
    assert lines[1]["type"] == "thing" and lines[1]["recording"] == "sub-001" and lines[1]["value"] is None
    assert lines[1]["items"] == [1, 2] and lines[1]["seq"] == 1 and lines[1]["t"] >= 0
    assert lines[1]["kind"] == "field called kind"
    assert lines[-1]["type"] == "log_closed" and lines[-1]["reason"] == "test"
    NULL_LOG.event("nothing")  # takes events and does nothing
    assert not NULL_LOG.enabled


# --------------------------------------------------------------- analytics
def test_active_time_caps_long_gaps_and_leaves_out_inactive_time():
    assert active_seconds([10, 20, 100], 0, 110, 30) == pytest.approx(10 + 10 + 30 + 10)
    # ElectroTag inactive from 30 to 40 s: inside the (capped) gap from 20 to 50 s.
    assert active_seconds([10, 20, 100], 0, 110, 30, [(30, 40)]) == pytest.approx(10 + 10 + 20 + 10)


def test_recording_row_numbers(tmp_path):
    b = LogBuilder(tmp_path / "interaction_logs" / "annotator-A01" / "v1.jsonl", "A01", T0)
    b.recording(0.0, "sub-001", 1, duration_s=60, clicks=[10.0, 100.0], annotations=[20.0],
                views=[(1.0, 0.0, 10.0), (15.0, 5.0, 10.0), (50.0, 50.0, 10.0)], finish=110.0)
    b.event(30.0, "app_state", state="inactive")
    b.event(40.0, "app_state", state="active")
    b.write()
    t = rows_for(b.path)
    (row,) = t.recordings
    assert row["outcome"] == "finished" and row["wall_s"] == pytest.approx(110)
    assert row["active_s"] == pytest.approx(50)  # 10 + 10 + (30 - 10 inactive) + 10
    assert row["inactive_s"] == pytest.approx(10) and row["idle_s"] == pytest.approx(50)
    assert row["clicks"] == 2 and row["annotations_created"] == 1 and row["final_annotations"] == 1
    assert row["created_by_drag"] == 1
    assert row["seconds_per_annotation"] == pytest.approx(50)
    assert row["share_seen"] == pytest.approx(25 / 60)  # 0-15 and 50-60 of 60 s
    assert row["screens_viewed"] == 3 and row["time_to_first_annotation_s"] == pytest.approx(20)
    (visit,) = t.visits
    assert visit["recordings_finished"] == 1 and visit["annotations_saved"] == 1 and visit["screen"] == "1920x1080"


def test_order_runs_across_visits_and_modes(tmp_path):
    for day, mode in ((0, "practice"), (1, "standard")):
        b = LogBuilder(tmp_path / f"v{day}.jsonl", "A01", T0 + timedelta(days=day), mode=mode)
        b.recording(0.0, "r1", 1, annotations=[5.0], finish=10.0)
        b.recording(20.0, "r2", 2, annotations=[25.0], finish=30.0)
        b.write()
    t = rows_for(tmp_path / "v1.jsonl", tmp_path / "v0.jsonl")
    assert [(r["mode"], r["recording"], r["order"], r["order_in_mode"]) for r in t.recordings] == [
        ("practice", "r1", 1, 1), ("practice", "r2", 2, 2), ("standard", "r1", 3, 1), ("standard", "r2", 4, 2)]


def test_training_measures_are_summarised(tmp_path):
    b = LogBuilder(tmp_path / "v.jsonl", "A01", T0, mode="practice", context_id="pilot")
    b.recording(0.0, "r1", 1, annotations=[5.0], finish=None)
    b.context = {"recording": "r1", "window_no": 1}
    b.event(6.0, "guided_check", ok=False)
    b.event(7.0, "guided_step_completed", attempts=2, stars=2, seconds=7.0)
    b.event(9.0, "guided_show_me")
    b.event(12.0, "guided_step_completed", attempts=3, stars=1, seconds=5.0, used_show_me=True)
    b.event(13.0, "recording_finished", n_annotations=1)
    b.context = {}
    b.event(14.0, "practice_scored", recording_id="r1", event_f1=0.75, passed=False)  # after the window closed
    for i, ok in enumerate((True, False, True, True)):
        b.event(20.0 + i, "quiz_answer", item_id=f"q{i}", correct=ok, response_time_s=2.0 + i)
    b.write()
    rows = {r["segment"]: r for r in rows_for(b.path).recordings}
    rec, quiz = rows["recording"], rows["quiz"]
    # One press of Show me (its event), which the second step's used_show_me does not count again.
    assert rec["guided_steps"] == 2 and rec["guided_attempts"] == 5 and rec["guided_show_me"] == 1
    assert rec["guided_stars_mean"] == pytest.approx(1.5) and rec["guided_seconds_per_step"] == pytest.approx(6)
    assert rec["practice_score"] == pytest.approx(0.75) and rec["score"] == pytest.approx(0.75)
    assert rec["practice_passed"] is False
    assert quiz["quiz_items"] == 4 and quiz["quiz_correct"] == 3 and quiz["score"] == pytest.approx(0.75)
    assert quiz["quiz_mean_response_s"] == pytest.approx(3.5)


def test_crashed_and_foreign_logs_are_read_safely(tmp_path):
    b = LogBuilder(tmp_path / "a.jsonl", "A01", T0)
    b.recording(0.0, "r1", 1, annotations=[5.0])
    path = b.write(closed=None)
    with path.open("a", encoding="utf-8") as fh:
        fh.write('{"seq": 99, "t": 1')  # cut short by a crash
    v = read_visit_log(path)
    assert v.bad_lines == 1 and not v.closed and v.close_reason.startswith("not closed")
    (tmp_path / "other.jsonl").write_text('{"hello": 1}\n', encoding="utf-8")
    newer = tmp_path / "newer.jsonl"
    newer.write_text(json.dumps({"type": "header", "schema": "electrotag.interaction_log",
                                 "schema_version": "9.0.0"}) + "\n", encoding="utf-8")
    visits, warnings = read_logs(find_logs([tmp_path]))
    assert [x.path.name for x in visits] == ["a.jsonl"]
    assert any("not an ElectroTag" in w for w in warnings) and any("not supported" in w for w in warnings)
    assert any("could not be read" in w for w in warnings)
    (row,) = summarise(visits).recordings
    assert row["outcome"] == "not_finished" and row["final_annotations"] == 1


def test_cli_writes_tables_and_report(tmp_path, capsys):
    root = demo_logs(tmp_path / "results")
    out = tmp_path / "out"
    assert activity_main([str(root), "--out", str(out), "--events"]) == 0
    for name in ("visits.tsv", "recordings.tsv", "events.tsv", "about_these_tables.txt", "activity_report.html"):
        assert (out / name).is_file(), name
    header = (out / "recordings.tsv").read_text(encoding="utf-8").splitlines()[0].split("\t")
    assert header[:5] == ["annotator_id", "visit_id", "mode", "context_id", "recording"]
    page = (out / "activity_report.html").read_text(encoding="utf-8")
    assert "Active minutes per recording" in page and "<svg" in page and "A02" in page
    assert "18 recording(s) finished" in capsys.readouterr().out
    # Annotators got faster in the demo: the change from first to last recordings is negative.
    tables, _ = write_activity([root], tmp_path / "out2", report=False)
    a01 = [r for r in tables.recordings if r["annotator_id"] == "A01"]
    assert a01[-1]["seconds_per_annotation"] < a01[0]["seconds_per_annotation"]
    assert activity_main([str(tmp_path / "empty_dir_missing")]) == 2
    (tmp_path / "empty").mkdir()
    assert activity_main([str(tmp_path / "empty")]) == 1


# ------------------------------------------- confidence, notes, problems and reviews
def _mark(aid, confidence=None, note_length=0):
    return {"id": aid, "label": "Eye-blink-artifact", "confidence": confidence, "note_length": note_length}


def marks_log(path):
    """A visit with ratings, notes, a problem report, the feedback on a review and a revision of the work."""
    b = LogBuilder(path, "A01", T0)
    b.context = {"recording": "r1", "window_no": 1}
    b.event(0.0, "recording_opened", duration_s=60, n_channels_shown=22, annotations_restored=0, resumed=False)
    b.event(0.0, "viewer_ready")
    for i, aid in enumerate(("a1", "a2", "a3"), start=1):
        b.event(float(i), "annotation_created", via="eeg_drag", n_total=i, annotations=[_mark(aid)])
    b.event(4.0, "confidence_set", via="shortcut:Confidence 3", n_total=3,
            annotations=[{"id": "a1", "label": "Eye-blink-artifact", "confidence": 3, "before": None}])
    b.event(5.0, "confidence_set", n_total=3, annotations=[{"id": "a2", "confidence": 5, "before": None}])
    b.event(6.0, "confidence_set", n_total=3, annotations=[{"id": "a2", "confidence": None, "before": 5}])
    b.event(7.0, "undo", n_total=3, added=[], removed=[], changed=[_mark("a2", 5)])  # the rating is back
    b.event(8.0, "confidence_prompt", trigger="key", outcome="rated", n_annotations=1, confidence=3)
    b.event(9.0, "confidence_prompt", trigger="new_mark", outcome="timeout", n_annotations=1)
    for t, change, length in ((10.0, "added", 12), (11.0, "changed", 20)):
        b.event(t, "note_set", n_total=3, annotations=[{"id": "a1", "change": change, "note_length": length}])
    b.event(12.0, "note_set", n_total=3, annotations=[{"id": "a3", "change": "added", "note_length": 5}])
    b.event(13.0, "note_set", n_total=3, annotations=[{"id": "a3", "change": "removed", "note_length": 0,
                                                       "previous_length": 5}])
    b.event(14.0, "problem_reported", recording_id="r1", mode="standard", reason="noisy", outcome="noted",
            where="annotate", already=False, note_length=0)
    b.event(15.0, "confidence_check", n_unrated=1, n_annotations=3, choice="rate")
    b.event(16.0, "confidence_check", n_unrated=1, n_annotations=3, choice="save")
    b.event(17.0, "recording_finished", n_annotations=3)
    b.context = {}
    b.event(18.0, "problem_reported", recording_id="r9", mode="standard", reason="will_not_open",
            outcome="unusable", where="home", already=False, note_length=30)
    # The annotator reads the review of r1 (read only), then revises it with the feedback beside it.
    b.context = {"recording": "r1", "window_no": 2}
    b.event(20.0, "recording_opened", segment="feedback", annotations_restored=0, duration_s=60)
    b.event(20.5, "feedback_shown", recording_id="r1", reviews=2, items=3, kind="feedback")
    b.event(21.0, "feedback_item_jumped", status="caveat", onset_s=1.0, item=1)
    b.event(22.0, "feedback_item_jumped", status="comment", onset_s=3.0, item=3)
    b.event(23.0, "feedback_closed", recording_id="r1", to="revision")
    b.context = {"recording": "r1", "window_no": 3}
    b.event(24.0, "feedback_shown", recording_id="r1", reviews=2, items=3, kind="annotate")
    b.event(24.0, "recording_opened", annotations_restored=0, revision=2, duration_s=60)
    b.event(24.0, "revision_started", version=2, revises=1, annotations_loaded=3)
    b.event(25.0, "confidence_set", n_total=3, annotations=[{"id": "a3", "confidence": 4, "before": None}])
    b.event(26.0, "recording_finished", n_annotations=3, version=2)
    # A draft continued from work the logs do not cover: its ratings are unknown.
    b.context = {"recording": "r2", "window_no": 4}
    b.event(30.0, "recording_opened", annotations_restored=2, resumed=True, duration_s=60)
    b.event(31.0, "confidence_set", n_total=2, annotations=[{"id": "x1", "confidence": 2, "before": None}])
    b.event(32.0, "recording_finished", n_annotations=2)
    b.context = {}
    return b.write()


def test_ratings_notes_problems_and_reviews_are_counted(tmp_path):
    t = rows_for(marks_log(tmp_path / "v.jsonl"))
    first, feedback, revision, draft = t.recordings
    assert [r["segment"] for r in t.recordings] == ["recording", "feedback", "recording", "recording"]
    assert first["ratings_given"] == 2 and first["ratings_cleared"] == 1
    # a1 rated 3, a2 back at 5 after the undo, a3 never rated
    assert first["annotations_rated"] == 2 and first["share_rated"] == pytest.approx(2 / 3)
    assert first["confidence_prompts"] == 2
    assert json.loads(first["confidence_prompts_by_outcome"]) == {"rated": 1, "timeout": 1}
    assert first["confidence_checks"] == 2 and json.loads(first["confidence_check_choices"]) == {"rate": 1, "save": 1}
    assert first["notes_written"] == 3 and first["notes_removed"] == 1 and first["annotations_with_note"] == 1
    assert first["problems_reported"] == 1 and first["set_aside"] is False
    assert first["reviews_received"] == 0
    assert feedback["outcome"] == "finished" and feedback["final_annotations"] == ""
    assert feedback["reviews_received"] == 2 and feedback["feedback_items"] == 3
    assert feedback["feedback_items_opened"] == 2 and feedback["annotations_rated"] == ""
    # The revision starts from the version saved in the first row, and rates the last mark.
    assert revision["reviews_received"] == 2 and revision["ratings_given"] == 1
    assert revision["annotations_rated"] == 3 and revision["share_rated"] == pytest.approx(1)
    assert revision["annotations_with_note"] == 1
    assert draft["ratings_given"] == 1 and draft["annotations_rated"] == "" and math.isnan(draft["share_rated"])
    (visit,) = t.visits
    assert visit["recordings_opened"] == 3  # the feedback view is left out
    assert visit["ratings_given"] == 4 and visit["notes_written"] == 3
    assert visit["problems_reported"] == 2 and visit["feedback_views"] == 2


def test_ratings_are_left_empty_when_the_log_cannot_show_them(tmp_path):
    b = LogBuilder(tmp_path / "v.jsonl", "A01", T0)
    b.recording(0.0, "r1", 1, annotations=[5.0, 6.0], finish=None)
    b.context = {"recording": "r1", "window_no": 1}
    b.event(7.0, "confidence_set", n_total=2, annotations=[{"id": "a1", "confidence": 4}])
    b.event(8.0, "undo", n_total=2)  # without the annotations it changed
    b.event(9.0, "recording_finished", n_annotations=2)
    b.recording(10.0, "r2", 2, annotations=[11.0], finish=None)
    b.context = {"recording": "r2", "window_no": 2}
    b.event(12.0, "confidence_set", n_total=1, annotations=[{"id": "a1", "confidence": 2}])
    b.event(13.0, "recording_finished", n_annotations=5)  # disagrees with the annotations in the log
    b.write()
    unknown, mismatch = rows_for(b.path).recordings
    assert unknown["ratings_given"] == 1 and unknown["annotations_rated"] == ""
    assert mismatch["annotations_rated"] == "" and mismatch["annotations_with_note"] == ""
    # Entries that do not name their annotation leave the result unknown rather than guessed.
    created = {"type": "annotation_created", "annotations": [_mark("a1", 2)]}
    assert replay_annotations({}, [created]) == {"a1": {"confidence": 2, "note_length": 0}}
    assert replay_annotations({}, [created, {"type": "note_set", "annotations": ["a1"]}]) is None
    assert replay_annotations({}, [{"type": "annotation_edited", "annotations": [{"label": "x"}]}]) is None


def test_report_and_tables_show_ratings_notes_problems_and_reviews(tmp_path):
    marks_log(tmp_path / "logs" / "v.jsonl")
    tables, paths = write_activity([tmp_path / "logs"], tmp_path / "out")
    header = paths["recordings"].read_text(encoding="utf-8").splitlines()[0].split("\t")
    for column in ("annotations_rated", "share_rated", "notes_written", "annotations_with_note",
                   "problems_reported", "reviews_received"):
        assert column in header
    assert "feedback_views" in paths["visits"].read_text(encoding="utf-8").splitlines()[0].split("\t")
    page = paths["report"].read_text(encoding="utf-8")
    assert "Confidence, notes, problems and reviews" in page
    # A01: 8 saved over three finished recordings; 5 rated of the 6 in the two whose ratings are known (the
    # continued draft is left out), 2 with a note, 2 problems, and r1's 2 reviews counted once.
    start = page.index("Confidence, notes, problems and reviews")
    row = page[page.index("<td>A01</td>", start):page.index("</tr>", page.index("<td>A01</td>", start))]
    cells = [c.split(">", 1)[1] for c in row.split("</td>") if ">" in c]
    assert cells == ["A01", "8", "5", "0.83", "2", "2", "2"]
    plain = demo_logs(tmp_path / "plain")
    _, paths = write_activity([plain], tmp_path / "out2")
    assert "Confidence, notes, problems and reviews" not in paths["report"].read_text(encoding="utf-8")


def test_the_logs_guide_lists_every_column_as_the_tables_describe_it():
    from pathlib import Path

    from electrotag.activity.summary import RECORDING_COLUMNS, VISIT_COLUMNS

    guide = (Path(__file__).resolve().parents[1] / "docs" / "activity_logs.md").read_text(encoding="utf-8")
    for heading, columns in (("### visits.tsv", VISIT_COLUMNS), ("### recordings.tsv", RECORDING_COLUMNS)):
        section = guide[guide.index(heading):]
        table = section[section.index("| Column | Meaning |"):].split("\n\n", 1)[0].splitlines()[2:]
        assert table == [f"| `{c}` | {d} |" for c, d in columns], heading


def expert_log(path):
    """An expert's visit: a correction, an adjudication, a replay, and a trainee's skips (docs/activity_logs.md)."""
    b = LogBuilder(path, "E01", T0)
    b.context = {"recording": "r1", "window_no": 1}
    b.event(0.0, "correction_started", annotator_id="A01", recording_id="r1", attempt=1, n_annotations=3)
    b.event(1.0, "annotations_snapshot", part=1, n_parts=1, annotations=[])
    b.event(5.0, "key", key="Delete")
    b.event(9.0, "correction_submitted", added=1, removed=1, changed=2, elapsed_s=9.0, already=False)
    b.event(10.0, "correction_submitted", added=1, removed=1, changed=2, elapsed_s=9.0, already=True)
    b.context = {"recording": "r2", "window_no": 2}
    b.event(20.0, "recording_opened", segment="adjudication", unit_id="r-1", duration_s=60.0)
    b.event(20.0, "adjudication_opened", unit_id="r-1", n_conflicts=3, decided=0, mode="decide", letters=2)
    b.event(30.0, "adjudication_decision", conflict_id="c-1", kinds=["type"], choice="A", seconds=10.0)
    b.event(50.0, "adjudication_decision", conflict_id="c-2", kinds=["presence"], choice="none", seconds=20.0)
    b.event(51.0, "adjudication_decision", conflict_id="c-2", kinds=["presence"], choice="none", seconds=1.0,
            already=True)
    b.event(52.0, "adjudication_finished", unit_id="r-1", n_conflicts=2, by_choice={"one": 1, "none": 1})
    b.context = {"recording": "r1", "window_no": 3}
    b.event(60.0, "replay_opened", annotator_id="A01", recording_id="r1", n_segments=1, n_events=40)
    b.event(90.0, "replay_closed", watched_s=27.5, ended="closed", same=True)
    b.context = {}
    return b.write()


def test_expert_work_and_skipped_stages_are_summarised(tmp_path):
    t = rows_for(expert_log(tmp_path / "e.jsonl"))
    correction, adjudication, replay = t.recordings
    assert [r["segment"] for r in t.recordings] == ["correction", "adjudication", "replay"]
    assert correction["outcome"] == "finished" and correction["corrections_submitted"] == 1
    assert correction["correction_changes"] == 4 and correction["final_annotations"] == ""
    assert adjudication["adjudication_decisions"] == 2 and adjudication["adjudication_mean_s"] == pytest.approx(15)
    assert adjudication["outcome"] == "finished"
    assert replay["replays_watched"] == 1 and replay["replay_watched_s"] == pytest.approx(27.5)
    (visit,) = t.visits
    assert visit["recordings_opened"] == 0  # none of these is annotation of one's own
    # a trainee skips two stages of the training path
    b = LogBuilder(tmp_path / "t.jsonl", "T01", T0)
    b.event(1.0, "training_path_opened", stages={})
    b.event(2.0, "stage_skipped", set_id="s", stage="tour", policy=["tour", "snippets"])
    b.event(3.0, "stage_skip_cancelled", set_id="s", stage="snippets")
    b.event(4.0, "stage_skipped", set_id="s", stage="snippets", policy=["tour", "snippets"])
    b.event(5.0, "snippet_viewed", snippet_id="s01", label="Eye-blink-artifact")
    b.context = {"recording": "tour", "window_no": 1}
    b.event(6.0, "recording_opened", segment="tour", duration_s=30.0)
    b.event(9.0, "tour_left", step="mark")
    b.context = {}
    b.write()
    trainee = rows_for(b.path).recordings
    training = next(r for r in trainee if r["segment"] == "training")
    assert training["stages_skipped"] == 2 and training["stages_skipped_names"] == "tour, snippets"
    assert [r["segment"] for r in trainee] == ["training", "snippets", "tour"]
    assert next(r for r in trainee if r["segment"] == "tour")["outcome"] == "closed_without_saving"


def test_the_report_has_the_expert_work_and_the_stages_skipped(tmp_path):
    expert_log(tmp_path / "logs" / "e.jsonl")
    b = LogBuilder(tmp_path / "logs" / "t.jsonl", "T01", T0 + timedelta(hours=1))
    b.event(2.0, "stage_skipped", set_id="s", stage="guided", policy=["guided"])
    b.write()
    tables, paths = write_activity([tmp_path / "logs"], tmp_path / "out")
    header = paths["recordings"].read_text(encoding="utf-8").splitlines()[0].split("\t")
    for column in ("corrections_submitted", "correction_changes", "adjudication_decisions", "adjudication_mean_s",
                   "replays_watched", "replay_watched_s", "stages_skipped", "stages_skipped_names"):
        assert column in header
    page = paths["report"].read_text(encoding="utf-8")
    start = page.index('data-section="expert-work"')
    row = page[page.index("<td>E01</td>", start):page.index("</tr>", page.index("<td>E01</td>", start))]
    cells = [c.split(">", 1)[1] for c in row.split("</td>") if ">" in c]
    assert cells == ["E01", "1", "4", "2", "15.0", "1", "0.5"]
    skips = page[page.index('data-section="stages-skipped"'):]
    assert "<td>T01</td>" in skips and "guided" in skips.split("</table>")[0]
    plain = demo_logs(tmp_path / "plain")
    _, paths = write_activity([plain], tmp_path / "out2")
    page = paths["report"].read_text(encoding="utf-8")
    assert 'data-section="expert-work"' not in page and 'data-section="stages-skipped"' not in page
