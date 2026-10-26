"""Export formats and round trips (tests 9, 10, 11, 12, 19, 20)."""

from __future__ import annotations

import json

from electroclean.app.annotations.model import AnnotationDocument
from electroclean.app.eeg.events import OriginalEvents, check_event_codes, events_from_raw_annotations
from electroclean.app.io.canonical import document_from_dict, document_to_dict, read_annotations_json
from electroclean.app.io.export import (
    annotations_from_events_tsv,
    build_events_sidecar,
    build_events_table,
    events_tsv_bytes,
    original_rows_from_events_tsv,
)
from electroclean.app.io.tsv import parse_tsv_text
from tests.conftest import make_session


def _doc(loaded, store, annotator="A01"):
    return AnnotationDocument(
        recording=loaded.info,
        annotator_id=annotator,
        annotations=store.annotations(),
        catalogue=store.catalogue,
        session_id="test",
    )


def test_all_sixteen_labels_export_with_fixed_codes(layout, settings, catalogue, loaded):
    s = make_session(layout, settings, catalogue, loaded)
    for i, label in enumerate(catalogue.label_names):
        s.store.add_interval(label, 1.0 + 2 * i, 1.5 + 2 * i)
    data = events_tsv_bytes(loaded.original_events, _doc(loaded, s.store))
    cols, rows = parse_tsv_text(data.decode())
    idx = {c: i for i, c in enumerate(cols)}
    art = [r for r in rows if r[idx["event_source"]] == "electroclean_artifact"]
    assert {(r[idx["trial_type"]], int(r[idx["value"]])) for r in art} == {
        (lab.label, lab.value) for lab in catalogue.labels
    }


def test_events_tsv_columns_and_original_rows_preserved(layout, settings, catalogue, loaded):
    s = make_session(layout, settings, catalogue, loaded)
    s.store.add_interval("Eye-blink-artifact", 3.0, 3.4, ["Fp1", "Fp2"])
    s.store.add_interval("Movement-artifact", 24.0, 26.0)
    doc = _doc(loaded, s.store)
    cols, rows = build_events_table(loaded.original_events, doc)
    for c in ("onset", "duration", "trial_type", "value", "sample", "channels"):
        assert c in cols
    assert cols[:5] == loaded.original_events.columns
    text = events_tsv_bytes(loaded.original_events, doc).decode()
    _, originals = original_rows_from_events_tsv(text)
    assert [r[:5] for r in originals] == loaded.original_events.rows
    # Byte-level check: every original line appears verbatim at the start of an output line.
    src_lines = loaded.files.events_tsv.read_text().splitlines()[1:]
    out_lines = text.splitlines()
    for line in src_lines:
        assert any(o.startswith(line + "\t") for o in out_lines)
    # Rows are in onset order.
    onsets = [float(r[0]) for r in rows]
    assert onsets == sorted(onsets)


def test_round_trip_tsv_and_json(layout, settings, catalogue, loaded):
    s = make_session(layout, settings, catalogue, loaded)
    s.store.add_interval("Eye-blink-artifact", 3.0, 3.4, ["Fp1", "Fp2"])
    s.store.add_interval("EMG-artifact", 9.2, 10.8)
    s.store.add_interval("EMG-artifact", 9.2, 10.8, ["T7"])  # same label, same interval, different channels
    s.store.add_interval("Electrode-pops-artifact", 14.0, 14.004, ["C3"])  # single sample
    s.store.add_interval("Salt-bridge-artifact", 59.9, 60.0, ["O1", "O2"])  # to the very end
    doc = _doc(loaded, s.store)
    key = lambda a: (a.annotation_id, a.label, a.onset_sample, a.duration_samples, a.channels)  # noqa: E731
    back = annotations_from_events_tsv(events_tsv_bytes(loaded.original_events, doc), loaded.info, catalogue)
    assert sorted(map(key, back)) == sorted(map(key, doc.annotations))
    parsed = document_from_dict(json.loads(json.dumps(document_to_dict(doc))))
    assert sorted(map(key, parsed.annotations)) == sorted(map(key, doc.annotations))
    assert parsed.recording.timing == loaded.info.timing
    assert parsed.recording.ch_names == loaded.info.ch_names


def test_whole_montage_and_channel_encodings(layout, settings, catalogue, loaded):
    s = make_session(layout, settings, catalogue, loaded)
    s.store.add_interval("Movement-artifact", 24.0, 26.0)
    s.store.add_interval("EMG-artifact", 9.0, 10.0, ["T7", "T8"])
    cols, rows = build_events_table(loaded.original_events, _doc(loaded, s.store))
    idx = {c: i for i, c in enumerate(cols)}
    chans = {r[idx["trial_type"]]: r[idx["channels"]] for r in rows if r[idx["event_source"]] == "electroclean_artifact"}
    assert chans == {"Movement-artifact": "[]", "EMG-artifact": '["T7","T8"]'}
    assert all(r[idx["channels"]] == "n/a" for r in rows if r[idx["event_source"]].startswith("original"))
    payload = document_to_dict(_doc(loaded, s.store))
    assert "whole recording montage" in payload["channel_convention"]["empty_list_means"]


def test_empty_annotation_set_exports_cleanly(layout, settings, catalogue, loaded):
    s = make_session(layout, settings, catalogue, loaded)
    doc = _doc(loaded, s.store)
    cols, rows = build_events_table(loaded.original_events, doc)
    assert len(rows) == len(loaded.original_events)
    assert annotations_from_events_tsv(events_tsv_bytes(loaded.original_events, doc), loaded.info, catalogue) == []


def test_sidecar_describes_new_columns_and_codes(layout, settings, catalogue, loaded):
    s = make_session(layout, settings, catalogue, loaded)
    doc = _doc(loaded, s.store)
    sidecar, notes = build_events_sidecar(loaded.events_sidecar, loaded.original_events, doc)
    for key in ("channels", "event_source", "annotation_id", "annotator_id", "original_row"):
        assert key in sidecar
    assert sidecar["trial_type"]["Levels"]["stimulus/1"] == "Standard stimulus"  # original kept
    assert sidecar["trial_type"]["HED"]["Eye-blink-artifact"] == "sc:Eye-blink-artifact"
    assert sidecar["value"]["Levels"]["103"] == "Eye-blink-artifact"
    assert sidecar["ElectroCleanMetadata"]["label_catalogue"]["sha256"] == catalogue.sha256


def test_vmrk_events_used_without_events_tsv(rich_dataset, catalogue):
    from electroclean.app.eeg.loading import load_recording
    from electroclean.app.io.discovery import discover_recordings
    from electroclean.config.settings import load_settings

    root, _ = rich_dataset
    settings, _ = load_settings(root)
    rec = {r.recording_id: r for r in discover_recordings(root)}["sourcedata_copies/siteA/recording_eeg.vhdr"]
    lr = load_recording(rec, settings, settings.filters, catalogue)
    ev = lr.original_events
    assert ev.source == "brainvision_vmrk"
    assert ev.trial_types[0] == "Stimulus/S  1"
    assert ev.values[0] == "1"
    assert ev.sample[0] == 500
    lr.close()


def _events(rows):
    return OriginalEvents(
        source="events_tsv", path=None, columns=["onset", "duration", "trial_type", "value"], rows=rows,
        onset_s=[float(r[0]) for r in rows], sample=[int(float(r[0]) * 100) for r in rows],
    )


def test_code_collision_and_mapping_checks(catalogue):
    ev = _events(
        [
            ["1.0", "0", "go", "1"],
            ["2.0", "0", "go", "1"],  # repeated code, same meaning: fine
            ["3.0", "0", "stop", "2"],
            ["4.0", "0", "nogo", "2"],  # same code, different meaning: flagged
            ["5.0", "0", "stop", "3"],  # same meaning, different code: flagged
            ["6.0", "0", "probe", "102"],  # clashes with EMG-artifact code
            ["7.0", "0", "Eye-blink-artifact", "7"],  # uses an artifact label name
        ]
    )
    rep = check_event_codes(ev, catalogue, "require_explicit_policy")
    assert rep.blocked
    kinds = {(c["kind"], c["value"]) for c in rep.collisions}
    assert ("value", 102) in kinds and ("label", 7) in kinds
    assert rep.value_meaning_conflicts == {"2": ["nogo", "stop"]}
    assert rep.label_value_conflicts == {"stop": ["2", "3"]}
    assert rep.repeated_values["1"] == 2
    assert not check_event_codes(ev, catalogue, "preserve_and_flag").blocked
    ok = _events([["1.0", "0", "go", "1"], ["2.0", "0", "go", "1"]])
    rep = check_event_codes(ok, catalogue, "require_explicit_policy")
    assert not rep.has_collisions and not rep.value_meaning_conflicts


def test_collision_rows_distinguished_in_export(rich_dataset, catalogue, tmp_path):
    from electroclean.app.eeg.loading import load_recording
    from electroclean.app.io.discovery import discover_recordings
    from electroclean.app.io.naming import OutputLayout
    from electroclean.config.settings import load_settings

    root, _ = rich_dataset
    settings, _ = load_settings(root, {"events": {"collision_policy": "preserve_and_flag"}})
    rec = {r.recording_id: r for r in discover_recordings(root)}["sub-099/eeg/sub-099_task-oddball_eeg.vhdr"]
    lr = load_recording(rec, settings, settings.filters, catalogue)
    s = make_session(OutputLayout(root / "Annotated_Events"), settings, catalogue, lr)
    s.store.add_interval("ECG-artifact", 10, 12)
    s.start()
    s.start_timer()
    res = s.finish()
    text = res.commit.paths["events_tsv"].read_text()
    cols, rows = parse_tsv_text(text)
    idx = {c: i for i, c in enumerate(cols)}
    with101 = [r for r in rows if r[idx["value"]] == "101"]
    assert {r[idx["event_source"]] for r in with101} == {"original:events_tsv", "electroclean_artifact"}
    sidecar = json.loads(res.commit.paths["events_json"].read_text())
    assert any("101" in n and "event_source" in n for n in sidecar["ElectroCleanMetadata"]["notes"])
    assert sidecar["value"]["Levels"]["101"].startswith("AMBIGUOUS CODE")
    assert sidecar["value"]["Levels"]["103"] == "Eye-blink-artifact"
    assert sidecar["ElectroCleanMetadata"]["event_code_check"]["collisions"][0]["value"] == 101
    meta = json.loads(res.commit.paths["session_json"].read_text())
    assert meta["original_events"]["code_check"]["collisions"][0]["value"] == 101
    lr.close()


def test_vmrk_events_helper_matches_mne(loaded):
    import mne

    raw = mne.io.read_raw_brainvision(loaded.files.vhdr, verbose="error")
    ev = events_from_raw_annotations(raw, loaded.timing, loaded.files.vmrk)
    events, _ = mne.events_from_annotations(raw, regexp=None, verbose="error")
    assert sorted(s for s in ev.sample) == sorted((events[:, 0] - raw.first_samp).tolist())


def test_written_canonical_file_reads_back(layout, settings, catalogue, loaded):
    s = make_session(layout, settings, catalogue, loaded)
    s.store.add_interval("Pulse-artifact", 5, 6, ["Cz"])
    s.start()
    s.start_timer()
    res = s.finish()
    doc = read_annotations_json(res.commit.paths["annotations_json"])
    assert doc.annotator_id == "A01"
    assert doc.annotations[0].channels == ("Cz",)
    assert doc.catalogue.sha256 == catalogue.sha256
