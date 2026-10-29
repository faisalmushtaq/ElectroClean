"""Export formats and round trips (tests 9, 10, 11, 12, 19, 20)."""

from __future__ import annotations

import json

from electrotag.app.annotations.model import AnnotationDocument
from electrotag.app.eeg.events import OriginalEvents, check_event_codes, events_from_raw_annotations
from electrotag.app.io.canonical import document_from_dict, document_to_dict, read_annotations_json
from electrotag.app.io.export import (
    annotations_from_events_tsv,
    build_events_sidecar,
    build_events_table,
    events_tsv_bytes,
    original_rows_from_events_tsv,
)
from electrotag.app.io.tsv import parse_tsv_text
from tests.conftest import make_session


def _doc(loaded, store, annotator="A01"):
    return AnnotationDocument(
        recording=loaded.info,
        annotator_id=annotator,
        annotations=store.annotations(),
        catalogue=store.catalogue,
        session_id="test",
    )


def test_all_labels_export_with_fixed_codes(layout, settings, catalogue, loaded):
    s = make_session(layout, settings, catalogue, loaded)
    for i, label in enumerate(catalogue.label_names):
        s.store.add_interval(label, 1.0 + 2 * i, 1.5 + 2 * i)
    data = events_tsv_bytes(loaded.original_events, _doc(loaded, s.store))
    cols, rows = parse_tsv_text(data.decode())
    idx = {c: i for i, c in enumerate(cols)}
    art = [r for r in rows if r[idx["event_source"]] == "electrotag_artifact"]
    assert {(r[idx["trial_type"]], int(r[idx["artifact_code"]])) for r in art} == {
        (lab.label, lab.value) for lab in catalogue.labels
    }
    assert {r[idx["value"]] for r in art} == {"n/a"}  # value is left to the dataset's own markers


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
    src_lines = loaded.files.events_tsv.read_text(encoding="utf-8").splitlines()[1:]
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
    chans = {r[idx["trial_type"]]: r[idx["channels"]] for r in rows if r[idx["event_source"]] == "electrotag_artifact"}
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
    for key in ("channels", "artifact_code", "event_source", "annotation_id", "annotator_id", "original_row"):
        assert key in sidecar
    assert sidecar["trial_type"]["Levels"]["stimulus/1"] == "Standard stimulus"  # original kept
    assert sidecar["trial_type"]["HED"]["Eye-blink-artifact"] == "sc:Eye-blink-artifact"
    assert sidecar["trial_type"]["HED"]["Eye-artifact"] == "sc:Eye-artifact"
    assert sidecar["artifact_code"]["Levels"]["103"] == "Eye-blink-artifact"
    assert sidecar["artifact_code"]["Levels"]["132"] == "Eye-artifact"
    assert sidecar["value"] == loaded.events_sidecar.get("value", sidecar["value"])  # original description untouched
    assert sidecar["ElectroTagMetadata"]["label_catalogue"]["sha256"] == catalogue.sha256


def test_sidecar_never_describes_added_columns_with_the_datasets_text(layout, settings, catalogue, loaded):
    """A dataset-wide events.json may describe columns that this recording's events.tsv lacks."""
    s = make_session(layout, settings, catalogue, loaded)
    doc = _doc(loaded, s.store)
    ev = loaded.original_events
    keep = [ev.columns.index(c) for c in ("onset", "duration", "trial_type")]
    narrow = OriginalEvents(source="events_tsv", path=None, columns=["onset", "duration", "trial_type"],
                            rows=[[r[i] for i in keep] for r in ev.rows], onset_s=ev.onset_s, sample=ev.sample,
                            sample_computed=True)
    original = {"sample": {"Description": "Original PsychoPy timestamp."}, "value": {"Description": "Trigger"}}
    sidecar, notes = build_events_sidecar(original, narrow, doc)
    assert sidecar["sample"]["Description"].startswith("Onset as a 0-based sample index")
    assert "computed it from onset" in sidecar["sample"]["Description"]
    assert sidecar["value"]["Description"].startswith("Added by ElectroTag")
    assert sum("does not have" in n or "do not have" in n for n in notes) == 2


def test_vmrk_events_used_without_events_tsv(rich_dataset, catalogue):
    from electrotag.app.eeg.loading import load_recording
    from electrotag.app.io.discovery import discover_recordings
    from electrotag.config.settings import load_settings

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


def test_original_code_report_never_blocks(catalogue):
    ev = _events(
        [
            ["1.0", "0", "go", "1"],
            ["2.0", "0", "go", "1"],  # repeated code, same meaning: fine
            ["3.0", "0", "stop", "2"],
            ["4.0", "0", "nogo", "2"],  # same code, different meaning: flagged
            ["5.0", "0", "stop", "3"],  # same meaning, different code: flagged
            ["6.0", "0", "probe", "102"],  # also an artifact code: harmless, noted
            ["7.0", "0", "Eye-blink-artifact", "7"],  # uses an artifact label name: noted
        ]
    )
    rep = check_event_codes(ev, catalogue)
    assert rep.codes_also_used_for_artifacts == [102]
    assert [r["row"] for r in rep.artifact_label_rows] == [7]
    assert rep.value_meaning_conflicts == {"2": ["nogo", "stop"]}
    assert rep.label_value_conflicts == {"stop": ["2", "3"]}
    assert rep.repeated_values["1"] == 2
    ok = check_event_codes(_events([["1.0", "0", "go", "1"], ["2.0", "0", "go", "1"]]), catalogue)
    assert not ok.codes_also_used_for_artifacts and not ok.value_meaning_conflicts and not ok.summary_lines()


def test_original_codes_that_equal_artifact_codes_cannot_be_confused(rich_dataset, catalogue, tmp_path):
    """The dataset's events use 101; an ECG artifact is coded 101 in its own column."""
    from electrotag.app.eeg.loading import load_recording
    from electrotag.app.io.discovery import discover_recordings
    from electrotag.app.io.naming import OutputLayout
    from electrotag.config.settings import load_settings

    root, _ = rich_dataset
    settings, _ = load_settings(root)  # no policy needed
    rec = {r.recording_id: r for r in discover_recordings(root)}["sub-099/eeg/sub-099_task-oddball_eeg.vhdr"]
    lr = load_recording(rec, settings, settings.filters, catalogue)
    s = make_session(OutputLayout(root / "Annotated_Events"), settings, catalogue, lr)
    s.store.add_interval("ECG-artifact", 10, 12)
    s.start()
    s.start_timer()
    res = s.finish()
    text = res.commit.paths["events_tsv"].read_text(encoding="utf-8")
    cols, rows = parse_tsv_text(text)
    idx = {c: i for i, c in enumerate(cols)}
    assert {r[idx["event_source"]] for r in rows if r[idx["value"]] == "101"} == {"original:events_tsv"}
    (art,) = [r for r in rows if r[idx["event_source"]] == "electrotag_artifact"]
    assert (art[idx["value"]], art[idx["artifact_code"]], art[idx["trial_type"]]) == ("n/a", "101", "ECG-artifact")
    sidecar = json.loads(res.commit.paths["events_json"].read_text(encoding="utf-8"))
    assert sidecar["artifact_code"]["Levels"]["101"] == "ECG-artifact"
    assert "101" not in (sidecar["value"].get("Levels") or {}) or "ECG" not in sidecar["value"]["Levels"]["101"]
    meta = json.loads(res.commit.paths["session_json"].read_text(encoding="utf-8"))
    assert meta["original_events"]["code_check"]["codes_also_used_for_artifacts"] == [101]
    lr.close()


def test_exports_from_version_1_can_still_be_read(loaded, catalogue):
    """Before version 2, artifact codes were in the value column."""
    header = "onset\tduration\ttrial_type\tvalue\tsample\tchannels\tevent_source\tannotation_id\tannotator_id\toriginal_row"
    row = "1.0\t0.5\tEMG-artifact\t102\t250\t[]\telectrotag_artifact\tabc\tA01\tn/a"
    (ann,) = annotations_from_events_tsv(header + "\n" + row + "\n", loaded.info, catalogue)
    assert (ann.label, ann.onset_sample, ann.duration_samples) == ("EMG-artifact", 250, 125)


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
