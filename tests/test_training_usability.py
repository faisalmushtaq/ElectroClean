"""Training and assessment: what annotators and administrators are shown (review findings).

The reference set's options, the administrator's competency report (provenance, reproducibility,
plain wording) and the annotator's summary. The browser application, which shows them now, is
tested in web_tests/.
"""

from __future__ import annotations

import json

import pytest

from electroclean.app.annotations.labels import default_catalogue
from electroclean.app.annotations.model import AnnotationDocument
from electroclean.app.io.canonical import write_annotations_json
from electroclean.app.io.naming import OutputLayout
from electroclean.config.settings import load_settings
from electroclean.training.assessment import (
    METRICS,
    competency_html,
    competency_report,
    competency_summary_html,
    matching_in_words,
    verify_competency_report,
)
from electroclean.training.reference import QuizItem, ReferenceSet, reference_sets_dir
from tests.conftest import SUB1, SUB2

CAT = default_catalogue()


def _doc(truth, annotator="E1", anns=None):
    return AnnotationDocument(truth.recording, annotator, list(truth.annotations if anns is None else anns), CAT,
                              session_id="e")


@pytest.fixture
def ref_set(dataset):
    root, truths = dataset
    _, study = load_settings(root)
    rs = ReferenceSet.create(reference_sets_dir(root, study), "pilot", name="Pilot", method="single_expert",
                             experts=["E1", "E2"])
    rs.add_reference(_doc(truths[SUB1]), use="practice", method="single_expert", experts=["E1"])
    rs.add_reference(_doc(truths[SUB2]), use="assessment", method="consensus", experts=["E1", "E2", "E3"],
                     details={"consensus_rule": {"min_agreement": 2, "experts": ["E1", "E2", "E3"]}})
    rs.set_criteria({"criteria": [{"metric": "event_f1", "threshold": 0.5}]})
    rs.add_quiz_item(QuizItem("q1", SUB2, 3.0, 3.4, "Eye-blink-artifact", ["Eye-artifact"], "Frontal"), CAT.label_names)
    return root, truths, rs


# ------------------------------------------------------------ item 3: blinding
def test_reference_set_report_setting_defaults_off_and_reads_the_old_key(ref_set):
    _, _, rs = ref_set
    assert rs.show_full_report_to_annotator is False
    data = json.loads(rs.path.read_text(encoding="utf-8"))
    data.pop("show_full_report_to_annotator")
    data["quiz"]["show_report_to_annotator"] = True  # a set written before version 1.1
    rs.path.write_text(json.dumps(data), encoding="utf-8")
    old = ReferenceSet.load(rs.directory)
    assert old.show_full_report_to_annotator is True
    old.show_full_report_to_annotator = False
    old.save()
    assert ReferenceSet.load(rs.directory).show_full_report_to_annotator is False  # the new key wins


# ---------------------------------------------------- items 4 and 12: the report
def test_report_gives_each_assessment_references_provenance_and_stays_reproducible(ref_set):
    root, truths, rs = ref_set
    layout = OutputLayout(root / "Annotated_Events")
    write_annotations_json(layout.annotator_dir("CAM", "assessment", "pilot") / "x_annotations.json",
                           AnnotationDocument(truths[SUB2].recording, "CAM", list(truths[SUB2].annotations), CAT,
                                              session_id="s", mode="assessment"))
    rep = competency_report(layout, rs, "CAM")
    prov = rep["reference_provenance"][SUB2]
    assert prov["method"] == "consensus" and prov["experts"] == ["E1", "E2", "E3"] and prov["min_agreement"] == 2
    assert "declared" in rep["reference_set"]["provenance_note"]
    again = competency_report(layout, rs, "CAM")
    assert again["results_sha256"] == rep["results_sha256"]
    assert verify_competency_report(rep["paths"]["json"])
    import html as html_module

    page = html_module.unescape(competency_html(rep))
    assert "consensus of several experts: E1, E2, E3 (2 needed to agree)" in page
    assert "Declared when the reference set was created: one expert's annotations: E1, E2" in page
    assert "Glossary" in page and METRICS["time_kappa"]["description"] in page
    assert "match_criterion" not in page and "reference_events" not in page  # no raw names
    assert "at least 20% (intersection over union)" in page
    assert "Kappa over time" in page and "<td class='cat'>Eye-blink-artifact</td>" in page


def test_summary_and_matching_texts():
    rep = {"reference_set": {"set_id": "s", "name": "Set"}, "status": "not_met",
           "status_text": "Does not yet meet the competency criteria.",
           "checks": [{"criterion": "F1 ≥ 0.8 (overall)", "where": "overall", "value": 0.5, "passed": False}]}
    html = competency_summary_html(rep)
    assert "talk to your study administrator" in html and "not met" in html
    assert matching_in_words({"match_criterion": "tolerance", "onset_tolerance_s": 0.5, "offset_tolerance_s": 1,
                              "allow_many_to_one": True}).startswith(
        "An annotation matched a reference artifact when they had starts within 0.5 s and ends within 1 s")
