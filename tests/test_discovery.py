"""Recording discovery and metadata pairing (tests 1 and 2)."""

from __future__ import annotations

import json

from electroclean.app.io.bids import parse_bids_name, resolve_sidecars
from electroclean.app.io.discovery import discover_recordings


def test_recursive_discovery_and_exclusions(rich_dataset):
    root, truths = rich_dataset
    # Put decoys where discovery must not look.
    (root / "derivatives" / "x").mkdir(parents=True)
    (root / "derivatives" / "x" / "sub-001_task-rest_eeg.vhdr").write_text("decoy", encoding="utf-8")
    (root / ".hidden").mkdir()
    (root / ".hidden" / "sub-005_task-rest_eeg.vhdr").write_text("decoy", encoding="utf-8")
    (root / "sub-001" / "eeg" / "notes_eeg.txt").write_text("not a recording", encoding="utf-8")
    recs = discover_recordings(root)
    assert [r.recording_id for r in recs] == sorted(truths)


def test_identical_file_names_get_distinct_ids(rich_dataset):
    root, _ = rich_dataset
    recs = [r for r in discover_recordings(root) if r.vhdr.name == "recording_eeg.vhdr"]
    assert len(recs) == 2
    assert len({r.recording_id for r in recs}) == 2
    assert {r.relative_dir for r in recs} == {"sourcedata_copies/siteA", "sourcedata_copies/siteB"}


def test_companions_and_sidecars_paired(dataset):
    root, _ = dataset
    rec = {r.recording_id: r for r in discover_recordings(root)}["sub-002/eeg/sub-002_task-rest_eeg.vhdr"]
    assert rec.problems == []
    assert rec.eeg.name == "sub-002_task-rest_eeg.eeg"
    assert rec.vmrk.name == "sub-002_task-rest_eeg.vmrk"
    assert rec.channels_tsv.name == "sub-002_task-rest_channels.tsv"
    assert rec.events_tsv.name == "sub-002_task-rest_events.tsv"
    assert rec.events_json.name == "sub-002_task-rest_events.json"
    assert rec.eeg_json.name == "sub-002_task-rest_eeg.json"
    assert rec.entities == {"sub": "002", "task": "rest"}


def test_bids_inheritance_and_specificity(dataset):
    root, _ = dataset
    # A top-level sidecar applies to every task-rest recording, but the
    # subject-level file is more specific and wins for overlapping keys.
    (root / "task-rest_events.json").write_text(json.dumps({"value": {"Description": "top"}, "extra": 1}),
                                               encoding="utf-8")
    (root / "task-oddball_events.json").write_text(json.dumps({"value": {"Description": "other task"}}),
                                                  encoding="utf-8")
    vhdr = root / "sub-001" / "eeg" / "sub-001_task-rest_eeg.vhdr"
    res = resolve_sidecars(vhdr, root)
    assert [p.name for p in res.events_json_chain] == ["task-rest_events.json", "sub-001_task-rest_events.json"]


def test_sidecars_not_cross_matched_between_runs(tmp_path):
    root = tmp_path
    d = root / "sub-01" / "eeg"
    d.mkdir(parents=True)
    for name in ("sub-01_task-a_run-1_eeg.vhdr", "sub-01_task-a_run-2_events.tsv", "rec1_events.tsv"):
        (d / name).write_text("x", encoding="utf-8")
    res = resolve_sidecars(d / "sub-01_task-a_run-1_eeg.vhdr", root)
    assert res.events_tsv is None
    (d / "rec2_eeg.vhdr").write_text("x", encoding="utf-8")
    res = resolve_sidecars(d / "rec2_eeg.vhdr", root)
    assert res.events_tsv is None  # non-BIDS rec1_events.tsv must not apply to rec2


def test_parse_bids_name():
    n = parse_bids_name("sub-01_ses-02_task-rest_run-03_eeg.vhdr")
    assert dict(n.entities) == {"sub": "01", "ses": "02", "task": "rest", "run": "03"}
    assert n.suffix == "eeg" and n.extension == ".vhdr"


def test_missing_companion_reported(dataset):
    root, _ = dataset
    (root / "sub-001" / "eeg" / "sub-001_task-rest_eeg.eeg").unlink()
    rec = {r.recording_id: r for r in discover_recordings(root)}["sub-001/eeg/sub-001_task-rest_eeg.vhdr"]
    assert any("Data file" in p for p in rec.problems)


def test_header_referencing_renamed_files(dataset):
    root, _ = dataset
    d = root / "sub-002" / "eeg"
    (d / "sub-002_task-rest_eeg.vmrk").rename(d / "renamed.vmrk")
    rec = {r.recording_id: r for r in discover_recordings(root)}["sub-002/eeg/sub-002_task-rest_eeg.vhdr"]
    assert any("Marker file" in p for p in rec.problems)
