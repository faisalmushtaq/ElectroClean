"""The permitted label catalogue (specification section 5.1)."""

from __future__ import annotations

import json

import pytest

from electrotag.app.annotations.labels import LabelCatalogue, LabelError, default_catalogue
from electrotag.config.settings import CONFIG_DIR

# The 16 labels and codes of the original specification: never renumbered.
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
# Every further artifact term of HED SCORE 2.2.0 (added at the research team's request).
FURTHER_SPECIFIC = {
    116: "Line-noise-artifact",
    117: "Nystagmus-artifact",
    118: "Artificial-ventilation-artifact",
    119: "Dialysis-artifact",
    120: "Rocking-patting-artifact",
    121: "Sucking-artifact",
}
GROUPS = {
    130: "Data-artifact",
    131: "Biological-artifact",
    132: "Eye-artifact",
    133: "Eye-movement-artifact",
    134: "Nonbiological-artifact",
    135: "Electrical-artifact",
    136: "Localized-channel-artifact",
}


def test_catalogue_contains_every_hed_score_artifact_term_with_fixed_codes():
    cat = default_catalogue()
    table = dict(zip(cat.values, cat.label_names))
    assert table == {**SPEC_TABLE, **FURTHER_SPECIFIC, **GROUPS}
    assert len(cat.labels) == 29
    assert set(cat.group_labels) == set(GROUPS.values())
    assert set(cat.specific_labels) == set(SPEC_TABLE.values()) | set(FURTHER_SPECIFIC.values())


def test_hierarchy_follows_the_schema():
    cat = default_catalogue()
    assert cat.ancestors("Horizontal-eye-movement-artifact") == (
        "Eye-movement-artifact", "Eye-artifact", "Biological-artifact", "Data-artifact")
    assert cat.ancestors("Electrode-pops-artifact") == ("Localized-channel-artifact", "Nonbiological-artifact", "Data-artifact")
    assert cat.ancestors("Data-artifact") == ()
    assert set(cat.descendants("Electrical-artifact")) == {"Induction-artifact", "Line-noise-artifact"}
    assert len(cat.descendants("Data-artifact")) == 28
    # Every group term is listed after its members (the order annotators see).
    names = list(cat.label_names)
    for g in cat.group_labels:
        assert all(names.index(m) < names.index(g) for m in cat.descendants(g))


def test_labels_exist_in_hed_score_2_2_0_snapshot():
    snap = json.loads((CONFIG_DIR / "hed_score_2.2.0_validation.json").read_text(encoding="utf-8"))
    assert snap["schema_library"] == "score"
    assert snap["schema_version"] == "2.2.0"
    assert snap["all_labels_found_exactly"] is True
    assert {e["label"] for e in snap["labels"] if e["found"]} == set(default_catalogue().label_names)
    assert snap["discrepancies"] == []
    assert snap["schema_artifact_terms_not_in_catalogue"] == []
    kinds = {e["label"]: e["kind"] for e in snap["labels"]}
    assert all(kinds[item.label] == item.kind for item in default_catalogue().labels)


def test_unknown_or_miscased_labels_rejected():
    cat = default_catalogue()
    with pytest.raises(LabelError):
        cat.get("eye-blink-artifact")
    with pytest.raises(LabelError):
        cat.get("BAD_blink")
    assert cat.is_permitted("Line-noise-artifact")


def test_catalogue_versions_are_compatible_when_codes_agree():
    cat = default_catalogue()
    data = json.loads((CONFIG_DIR / "artifact_labels.json").read_text(encoding="utf-8"))
    old = dict(data, catalogue_version="1.0.0",
               labels=[e for e in data["labels"] if e["value"] <= 115])
    v1 = LabelCatalogue.from_dict(old)
    assert len(v1.labels) == 16 and v1.sha256 != cat.sha256
    assert cat.compatible_with(v1) and cat.covers(v1) and not v1.covers(cat)
    clash = dict(old, labels=[dict(e, value=999) if e["value"] == 100 else e for e in old["labels"]])
    assert not cat.compatible_with(LabelCatalogue.from_dict(clash))


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
