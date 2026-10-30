"""Which versions of the annotations the agreement analysis compares (electrotag/reliability/versions.py).

The originals by default, exactly as before derived versions existed (also in the command line); the corrected
versions, with one expert's correction in place of the work it corrects, the adjudication of several experts'
corrections, a correction pending adjudication left out and a stale correction named; the adjudicated versions as
the reference annotator; windows cropped; and what the corrections and the adjudication changed."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pandas as pd
import pytest

from electrotag.app.annotations.labels import default_catalogue
from electrotag.app.annotations.model import AnnotationDocument, ArtifactAnnotation, RecordingInfo
from electrotag.app.annotations.timing import RecordingTiming
from electrotag.app.io.canonical import write_annotations_json
from electrotag.reliability.analysis import run_analysis
from electrotag.reliability.cli import main as agreement_main
from electrotag.reliability.config import ADJUDICATED, AnalysisConfig
from electrotag.reliability.data import build_dataset, load_dataset
from electrotag.reliability.report import build_html_report
from electrotag.reliability.versions import (
    StudyRecords,
    adjudication_effect,
    crop_to_window,
    survival_by_annotator,
)

CAT = default_catalogue()
CH = ("C1", "C2", "C3", "C4")
SF = 100.0
BLINK, MOVE, EMG = "Eye-blink-artifact", "Eye-movement-artifact", "EMG-artifact"
RID = "sub-01/eeg/rec.vhdr"


def ann(i: str, label: str, a: float, b: float, ch: tuple[str, ...] = ()) -> ArtifactAnnotation:
    return ArtifactAnnotation(i, label, int(round(a * SF)), int(round((b - a) * SF)), ch)


def doc(aid: str, anns: list[ArtifactAnnotation], *, rid: str = RID, n: int = 1000,
        created: str = "2026-10-01T10:00:00",
        derived: dict | None = None, session: str = "") -> AnnotationDocument:
    return AnnotationDocument(RecordingInfo(rid, RecordingTiming(SF, n), CH), aid, list(anns), CAT,
                              created_at=created, session_id=session or aid,
                              context={"derived": derived} if derived else {})


def correction(aid: str, by: str, anns: list[ArtifactAnnotation], *, attempt: int = 1, cid: str = "", rid: str = RID,
               changes: list | None = None) -> AnnotationDocument:
    cid = cid or f"{by.lower()}{'0' * 29}"
    return doc(aid, anns, rid=rid, created="2026-10-02T10:00:00", session=cid,
               derived={"kind": "correction", "correction_id": cid, "corrector_id": by,
                        "corrected_from": {"annotator_id": aid, "attempt": attempt}, "changes": changes or []})


def adjudicated(anns: list[ArtifactAnnotation], inputs: dict, *, uid: str = "r-000000000001", kind: str = "recording",
                window: dict | None = None, corrected: dict | None = None, rid: str = RID) -> AnnotationDocument:
    return doc(ADJUDICATED, anns, rid=rid, created="2026-10-03T10:00:00", session=uid,
               derived={"kind": "adjudication", "task_id": uid, "unit_kind": kind, "adjudicator_id": "E09",
                        "inputs": inputs, "rules": {"iou_threshold": 0.2}, "window": window, "corrected": corrected,
                        "n_conflicts": 0})


A01 = [ann("a1", BLINK, 1.0, 1.5), ann("a2", EMG, 4.0, 6.0), ann("a3", BLINK, 8.0, 8.4)]
A02 = [ann("b1", MOVE, 1.0, 1.5), ann("b2", EMG, 4.0, 6.0)]


def items(*docs: AnnotationDocument) -> list[tuple[str, AnnotationDocument]]:
    out = []
    for i, d in enumerate(docs):
        tree = "derived/" if d.context.get("derived") else ""
        out.append((f"{tree}annotator-{d.annotator_id}/{i:02d}_annotations.json", d))
    return out


def analyse(docs: list[tuple[str, AnnotationDocument]], records: StudyRecords | None = None, **cfg):
    config = AnalysisConfig(**{"resolutions_s": (1.0,), **cfg})
    return run_analysis(build_dataset(docs, config, records=records), config)


def key_f1(result) -> dict[tuple[str, str], float]:
    ev = result.table("events_summary")
    sel = ev[(ev.category == "ALL categories (micro-average)") & (ev.channel_mode == "time_only")
             & (ev.threshold == 0.2)]
    return {(r.reference, r.compared): float(r.f1) for _, r in sel.iterrows()}


# ------------------------------------------------------------------ original
def test_the_originals_by_default_leave_every_derived_version_out() -> None:
    plain = analyse(items(doc("A01", A01), doc("A02", A02)))
    fixed = correction("A01", "E01", [A01[1]])
    with_derived = analyse(items(doc("A01", A01), doc("A02", A02), fixed,
                                 adjudicated([A01[1]], {"A01": {"letter": "A", "attempt": 1},
                                                        "A02": {"letter": "B", "attempt": 1}})))
    assert AnalysisConfig().versions == "original" and AnalysisConfig().unit == "recording"
    for name, df in plain.tables.items():
        pd.testing.assert_frame_equal(df, with_derived.tables[name], check_dtype=False)
    assert set(with_derived.tables) == set(plain.tables)  # no versions tables for the originals
    assert with_derived.dataset.annotators == ["A01", "A02"]
    assert with_derived.settings_record["versions"]["used"] == "original"
    assert "Versions analysed" not in build_html_report(with_derived)


def write(folder: Path, *docs_: AnnotationDocument) -> None:
    for i, d in enumerate(docs_):
        sub = "derived/x/" if d.context.get("derived") else ""
        write_annotations_json(folder / f"{sub}annotator-{d.annotator_id}" / f"r{i:02d}_annotations.json", d)


def test_the_command_line_analyses_the_originals_unless_told(tmp_path: Path) -> None:
    root = tmp_path / "Annotated_Events"
    write(root, doc("A01", A01), doc("A02", A02), correction("A01", "E01", A01[:2] + [ann("a4", EMG, 7, 7.5)]))
    out = tmp_path / "plain"
    assert agreement_main([str(root), "--out", str(out), "--no-html"]) == 0
    settings = json.loads((out / "analysis_settings.json").read_text())
    assert settings["config"]["versions"] == "original" and settings["annotators"] == ["A01", "A02"]
    assert not (out / "versions.tsv").exists()
    plain_events = (out / "events_summary.tsv").read_text()
    # --versions corrected uses E01's correction of A01's work, and the settings repeat it
    out2 = tmp_path / "corrected"
    assert agreement_main([str(root), "--versions", "corrected", "--out", str(out2), "--no-html"]) == 0
    rows = (out2 / "versions.tsv").read_text().splitlines()
    assert rows[0].split("\t")[:3] == ["recording", "annotator", "version"]
    assert any("\tA01\tcorrected\t" in r and "E01" in r for r in rows)
    assert (out2 / "events_summary.tsv").read_text() != plain_events
    effect = (out2 / "corrections_effect.tsv").read_text().splitlines()
    assert len(effect) == 2 and "\tE01\tcorrection\t3\t3\t1\t1\t0\t0\t" in effect[1]
    out3 = tmp_path / "again"
    assert agreement_main([str(root), "--config", str(out2 / "analysis_settings.json"), "--out", str(out3),
                           "--no-html"]) == 0
    assert (out3 / "events_summary.tsv").read_text() == (out2 / "events_summary.tsv").read_text()
    # and a settings file of the corrected versions with --versions original gives the originals again
    out4 = tmp_path / "back"
    assert agreement_main([str(root), "--config", str(out2 / "analysis_settings.json"), "--versions", "original",
                           "--out", str(out4), "--no-html"]) == 0
    assert (out4 / "events_summary.tsv").read_text() == plain_events


# ------------------------------------------------------------------ corrected
def test_one_correction_takes_the_place_of_the_work_it_corrects() -> None:
    fixed = correction("A01", "E01", [ann("a1", MOVE, 1.0, 1.5), A01[1]],
                       changes=[{"annotation_id": "a1", "change": "changed", "reason": "wrong_type"},
                                {"annotation_id": "a3", "change": "removed", "reason": "not_artifact"}])
    r = analyse(items(doc("A01", A01), doc("A02", A02), fixed), versions="corrected")
    assert key_f1(r)[("A01", "A02")] == pytest.approx(1.0)  # the correction agrees with A02 entirely
    assert key_f1(analyse(items(doc("A01", A01), doc("A02", A02))))[("A01", "A02")] == pytest.approx(0.4)
    v = r.table("versions")
    assert list(v.version) == ["corrected", "original"] and v.iloc[0].corrected_by == "E01"
    assert r.settings_record["versions"] == {"used": "corrected", "replaced": 1, "by": {"E01": 1}, "left_out": [],
                                             "pending": []}
    eff = r.table("corrections_effect").iloc[0]
    assert (eff.added, eff.removed, eff.changed, eff.relabelled, eff.n_original, eff.n_corrected) == (0, 1, 1, 1, 3, 2)
    assert json.loads(eff.reasons) == {"not_artifact": 1, "wrong_type": 1}
    assert eff.f1_with_original == pytest.approx(0.4) and eff.via == "correction"
    html = build_html_report(r)
    assert "Versions analysed." in html and "Corrections and adjudication" in html and "wrong type" in html


def test_a_correction_of_an_earlier_version_is_named_and_not_used() -> None:
    second = doc("A01", A01[:2], created="2026-10-05T10:00:00")
    docs = [("annotator-A01/x_attempt-01_annotations.json", doc("A01", A01)),
            ("annotator-A01/x_attempt-02_annotations.json", second), *items(doc("A02", A02)),
            ("derived/annotator-A01/x_annotations.json", correction("A01", "E01", A02, attempt=1))]
    r = analyse(docs, versions="corrected")
    assert r.settings_record["versions"]["replaced"] == 0
    assert any("corrects version 1" in w and "later version (2)" in w for w in r.settings_record["warnings"])
    assert r.dataset.groups[RID].docs["A01"] is second


def test_several_experts_corrections_need_their_adjudication() -> None:
    e1 = correction("A01", "E01", [ann("a1", MOVE, 1.0, 1.5), A01[1], A01[2]], cid="1" * 32)
    e2 = correction("A01", "E02", A01[:2], cid="2" * 32)
    base = items(doc("A01", A01), doc("A02", A02), e1, e2, doc("A03", A02, rid="other.vhdr"),
                 doc("A04", A02, rid="other.vhdr"))
    r = analyse(base, versions="corrected")
    # pending: the whole recording is left out, with a warning naming it; the other recording stays
    assert list(r.dataset.groups) == ["other.vhdr"]
    assert any(w.startswith(f"{RID}: correction pending adjudication") and "E01, E02" in w
               for w in r.settings_record["warnings"])
    v = r.table("versions")
    assert set(v[v.recording == RID].version) == {"pending", "left_out"}
    assert r.settings_record["versions"]["pending"] == [RID]
    assert "Correction pending adjudication" in build_html_report(r)
    # finished: the adjudication of the two corrections stands for A01's corrected version
    adj = adjudicated([ann("a1", MOVE, 1.0, 1.5), A01[1]], {"E01": {"letter": "A", "source": "correction",
                                                                    "correction_id": "1" * 32},
                                                            "E02": {"letter": "B", "source": "correction",
                                                                    "correction_id": "2" * 32}},
                      uid="k-000000000001", kind="corrections", corrected={"annotator_id": "A01", "attempt": 1})
    r = analyse(base + items(adj), versions="corrected")
    assert sorted(r.dataset.groups) == ["other.vhdr", RID]
    used = r.dataset.groups[RID].docs["A01"]
    assert [a.label for a in used.annotations] == [MOVE, EMG] and used.annotator_id == "A01"
    row = r.table("versions").set_index("annotator").loc["A01"]
    assert row.version == "corrected" and row.corrected_by == "E01, E02" and row.unit_id == "k-000000000001"
    assert r.settings_record["versions"]["by"] == {"E01": 1, "E02": 1}
    assert r.table("corrections_effect").iloc[0].via == "adjudication"
    # the adjudication of the corrections is never a reference of its own, and never A01's work in the originals
    assert analyse(base + items(adj)).dataset.annotators == ["A01", "A02", "A03", "A04"]


# ------------------------------------------------------------------ adjudicated
def test_the_adjudicated_versions_are_the_reference() -> None:
    adj = adjudicated([ann("x1", MOVE, 1.0, 1.5), A01[1], A01[2]],
                      {"A01": {"letter": "A", "attempt": 1}, "A02": {"letter": "B", "attempt": 1}})
    cfg = AnalysisConfig(versions="adjudicated")
    assert cfg.reference_annotator == ADJUDICATED
    with pytest.raises(ValueError, match="must be ADJUDICATED"):
        AnalysisConfig.from_dict({"versions": "adjudicated", "reference_annotator": "A01"})
    docs = items(doc("A01", A01), doc("A02", A02), adj, doc("A01", A02, rid="lonely.vhdr"),
                 doc("A02", A02, rid="lonely.vhdr"))
    r = analyse(docs, versions="adjudicated")
    assert list(r.dataset.groups) == [RID] and r.dataset.annotators == ["A01", "A02", ADJUDICATED]
    f1 = key_f1(r)
    assert set(f1) == {(ADJUDICATED, "A01"), (ADJUDICATED, "A02")}  # everyone against the adjudicated version only
    assert f1[(ADJUDICATED, "A01")] == pytest.approx(2 * 2 / 6)
    assert any("no finished adjudication" in w and "lonely.vhdr" in w for w in r.settings_record["warnings"])
    # a known-answer recording is never adjudicated: it is left out without a warning that asks for one
    gold = StudyRecords.of([], [{"task_id": "t-000000000009", "recording_id": "lonely.vhdr",
                                 "gold": {"set_id": "known"}, "annotators": ["A01", "A02"], "state": "open"},
                                {"task_id": "t-00000000000a", "recording_id": "mixed.vhdr", "gold": {"set_id": "known"},
                                 "state": "open"},
                                {"task_id": "t-00000000000b", "recording_id": "mixed.vhdr", "gold": None,
                                 "state": "open"}])
    assert gold.known_answer_recordings() == {"lonely.vhdr"}
    r2 = analyse(docs, gold, versions="adjudicated")
    assert not any("no finished adjudication" in w for w in r2.settings_record["warnings"])
    assert "lonely.vhdr" in r2.settings_record["versions"]["left_out"]
    eff = r.table("adjudication").iloc[0]
    assert (eff.n_conflicts, eff.type, eff.presence) == (2, 1, 1)
    assert eff.f1_before == pytest.approx(0.4) and eff.f1_after == pytest.approx((2 * 2 / 6 + 2 * 2 / 5) / 2)
    assert pd.isna(eff.kept_one)  # no records: the decisions are not known
    pairs = r.table("adjudication_pairs")
    assert list(zip(pairs.label_1, pairs.label_2, pairs.n_conflicts, strict=True)) == [(BLINK, MOVE, 1)]
    surv = {row["annotator"]: row for row in survival_by_annotator(r.table("adjudication_survival").to_dict("records"))}
    assert (surv["A01"]["n_marks"], surv["A01"]["n_kept"]) == (3, 2)
    assert (surv["A02"]["n_marks"], surv["A02"]["n_kept"]) == (2, 2)
    html = build_html_report(r)
    assert "Before and after adjudication." in html and "Confused with" in html
    with pytest.raises(ValueError):
        AnalysisConfig(versions="newest").validate()


def test_the_decisions_come_from_the_study_records(tmp_path: Path) -> None:
    from electrotag.reliability.conflicts import ConflictRules, find_clusters

    adj = adjudicated([ann("x1", MOVE, 1.0, 1.5), A01[1], A01[2]],
                      {"A01": {"letter": "A", "attempt": 1}, "A02": {"letter": "B", "attempt": 1}})
    clusters = [c for c in find_clusters({"A": doc("A01", A01), "B": doc("A02", A02)}, ch_names=CH, sfreq=SF,
                                         unit_id="r-000000000001", rules=ConflictRules(iou_threshold=0.2),
                                         who={"A": "A01", "B": "A02"}) if c.is_conflict]
    decisions = {clusters[0].cluster_id: {"choice": "B", "decided_at": "2026-10-03T10:00:30"},
                 clusters[1].cluster_id: {"choice": "A", "decided_at": "2026-10-03T10:01:00"}}
    rec = {"schema": "electrotag.adjudication", "unit_id": "r-000000000001", "started_at": "2026-10-03T10:00:00",
           "decisions": decisions, "state": "finished"}
    root = tmp_path / "Annotated_Events"
    write(root, doc("A01", A01), doc("A02", A02), adj)
    (root / "adjudications").mkdir()
    (root / "adjudications" / "r-000000000001.json").write_text(json.dumps(rec))
    cfg = AnalysisConfig(versions="adjudicated", resolutions_s=(1.0,))
    r = run_analysis(load_dataset([root], cfg), cfg)
    eff = r.table("adjudication").iloc[0]
    assert (eff.kept_one, eff.kept_all, eff.kept_none, eff.edited, eff.n_decided) == (2, 0, 0, 0, 2)
    assert eff.mean_decision_s == pytest.approx(30.0)
    pair = r.table("adjudication_pairs").iloc[0]
    assert (pair.kept_label_1, pair.kept_label_2) == (0, 1)  # decided for the eye movement
    surv = r.table("adjudication_survival").set_index("annotator")
    assert surv.loc["A01"].n_decided_for == 1 and surv.loc["A02"].n_decided_for == 1
    assert surv.loc["A01"].n_conflict_marks == 2


# ------------------------------------------------------------------ windows
def test_crop_to_window_arithmetic() -> None:
    d = doc("A01", [ann("w1", BLINK, 1.0, 2.0), ann("w2", EMG, 2.5, 3.5, ("C1",)), ann("w3", EMG, 6.0, 7.0)])
    c = crop_to_window(d, 200, 600, f"{RID}#t-1")
    assert c.recording.recording_id == f"{RID}#t-1" and c.recording.timing.n_samples == 400
    assert c.recording.timing.first_samp == 200 and c.recording.ch_names == CH
    assert [(a.annotation_id, a.onset_sample, a.duration_samples, a.channels) for a in c.annotations] == [
        ("w2", 50, 100, ("C1",))]  # w1 ends at the window's start; w3 starts after it
    c2 = crop_to_window(d, 150, 300, "g")
    assert [(a.annotation_id, a.onset_sample, a.duration_samples) for a in c2.annotations] == [("w1", 0, 50),
                                                                                              ("w2", 100, 50)]
    assert d.recording.timing.n_samples == 1000 and len(d.annotations) == 3  # the original is unchanged
    with pytest.raises(ValueError):
        crop_to_window(d, 900, 900, "g")


def test_window_adjudications_and_tasks_are_compared_on_their_part() -> None:
    window = {"start_sample": 300, "end_sample": 700}
    a = [ann("a2", EMG, 4.0, 6.0)]
    b = [ann("b2", EMG, 4.0, 6.0)]
    adj = adjudicated([ann("x", EMG, 4.0, 6.0)], {"A01": {"letter": "A", "attempt": 1},
                                                   "A02": {"letter": "B", "attempt": 1}},
                      uid="t-aaaaaaaaaaaa", kind="task", window=window)
    r = analyse(items(doc("A01", a), doc("A02", b), adj), versions="adjudicated")
    group = f"{RID}#t-aaaaaaaaaaaa"
    assert list(r.dataset.groups) == [group] and r.dataset.groups[group].timing.n_samples == 400
    assert r.table("adjudication").iloc[0].window_start_s == pytest.approx(3.0)
    # by task: each task's part on its own, so the clean rest of the recording does not count
    task = {"task_id": "t-aaaaaaaaaaaa", "recording_id": RID, "window": window, "annotators": ["A01", "A02"],
            "state": "open"}
    whole = analyse(items(doc("A01", a), doc("A02", b)))
    parts = analyse(items(doc("A01", a), doc("A02", b)), StudyRecords.of(tasks=[task]), unit="task")
    assert list(parts.dataset.groups) == [group] and list(whole.dataset.groups) == [RID]
    neg = {name: res.table("timeresolved_pairwise") for name, res in (("whole", whole), ("parts", parts))}
    sel = {k: v[(v.category == "ANY-artifact") & (v.representation == "exact") & (v.channel_mode == "time_only")
                & (v.recording == "ALL (pooled)")].iloc[0] for k, v in neg.items()}
    assert sel["whole"].n == pytest.approx(10.0) and sel["parts"].n == pytest.approx(4.0)  # seconds compared
    assert parts.table("versions").iloc[0].recording == group
    # without the tasks, the analysis by task says so and compares whole recordings
    alone = analyse(items(doc("A01", a), doc("A02", b)), unit="task")
    assert list(alone.dataset.groups) == [RID]
    assert any("needs the study's tasks" in w for w in alone.settings_record["warnings"])


def test_adjudication_effect_without_units_is_empty() -> None:
    assert adjudication_effect([], AnalysisConfig()) == {"adjudication": [], "adjudication_pairs": [],
                                                         "adjudication_survival": []}
    assert math.isnan(survival_by_annotator([{"annotator": "A", "n_marks": 0, "n_kept": 0}])[0]["share_kept"])
