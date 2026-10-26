"""The permitted label catalogue (specification section 5.1)."""

from __future__ import annotations

import json

import pytest

from electroclean.app.annotations.labels import LabelCatalogue, LabelError, default_catalogue
from electroclean.config.settings import CONFIG_DIR

SPEC_TABLE = {
    100: "Chewing-artifact",
    101: "ECG-artifact",
    102: "EMG-artifact",
    103: "Eye-blink-artifact",
    104: "Horizontal-eye-movement-artifact",
    105: "Slow-eye-movement-artifact",
    106: "Vertical-eye-movement-artifact",
    107: "Movement-artifact",
    108: "Pulse-artifact",
    109: "Respiration-artifact",
    110: "Sweat-artifact",
    111: "Tongue-movement-artifact",
    112: "Induction-artifact",
    113: "Electrode-movement-artifact",
    114: "Electrode-pops-artifact",
    115: "Salt-bridge-artifact",
}


def test_catalogue_matches_specification_exactly():
    cat = default_catalogue()
    assert dict(zip(cat.values, cat.label_names)) == SPEC_TABLE
    assert len(cat.labels) == 16


def test_labels_exist_in_hed_score_2_2_0_snapshot():
    snap = json.loads((CONFIG_DIR / "hed_score_2.2.0_validation.json").read_text(encoding="utf-8"))
    assert snap["schema_library"] == "score"
    assert snap["schema_version"] == "2.2.0"
    assert snap["all_labels_found_exactly"] is True
    assert {e["label"] for e in snap["labels"] if e["found"]} == set(SPEC_TABLE.values())
    assert snap["discrepancies"] == []


def test_unknown_or_miscased_labels_rejected():
    cat = default_catalogue()
    with pytest.raises(LabelError):
        cat.get("eye-blink-artifact")
    with pytest.raises(LabelError):
        cat.get("BAD_blink")
    assert not cat.is_permitted("Line-noise-artifact")


def test_catalogue_digest_ignores_colours_but_not_codes():
    cat = default_catalogue()
    data = json.loads((CONFIG_DIR / "artifact_labels.json").read_text(encoding="utf-8"))
    data["labels"][0]["colour"] = "#000000"
    assert LabelCatalogue.from_dict(data).sha256 == cat.sha256
    data["labels"][0]["value"] = 999
    assert LabelCatalogue.from_dict(data).sha256 != cat.sha256


def test_duplicate_codes_rejected():
    data = json.loads((CONFIG_DIR / "artifact_labels.json").read_text(encoding="utf-8"))
    data["labels"][1]["value"] = data["labels"][0]["value"]
    with pytest.raises(LabelError):
        LabelCatalogue.from_dict(data)


def test_hed_tags_use_score_namespace():
    cat = default_catalogue()
    assert cat.hed_tag("Eye-blink-artifact") == "sc:Eye-blink-artifact"
