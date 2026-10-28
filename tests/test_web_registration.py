"""Checking the manifests a browser sends (electroclean/web/manifest_check.py), and the example set's kept ones."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from electroclean.web.manifest_check import MAX_MANIFEST_BYTES, ManifestProblem, check_manifest
from tests.web_helpers import build_manifests

SUFFIXES = ("_eeg.vhdr", "_eeg.edf", "_eeg.bdf")


@pytest.fixture(scope="module")
def manifests(tmp_path_factory: pytest.TempPathFactory) -> dict[str, dict[str, Any]]:
    """Real manifests (MNE-Python) of BrainVision, EDF+ and BDF recordings with what makes them hard."""
    from electroclean.synthetic import write_edf, write_edf_recording, write_recording

    root = tmp_path_factory.mktemp("reg-data")
    write_recording(root / "sub-001" / "eeg", "sub-001_task-rest", sfreq=250.0, duration_s=30.0, seed=1,
                    discontinuity_s=12.0)  # BrainVision with a second segment
    write_edf_recording(root / "sub-002" / "eeg", "sub-002_task-rest", sfreq=128.0, duration_s=20.5, seed=2)
    n = 256 * 20
    status = np.zeros(n, dtype=int)
    status[[300, 1800, 4000]] = [1, 2, 1]
    rng = np.random.default_rng(3)
    folder = root / "sub-003" / "eeg"
    folder.mkdir(parents=True)
    write_edf(folder / "sub-003_task-rest_eeg.bdf", rng.normal(0, 2e-5, (4, n)), 256.0, ["Fp1", "Fp2", "Cz", "Oz"],
              bdf=True, triggers={"Status": status})
    return {m["recording_id"]: m for m in build_manifests(root)}


def test_real_manifests_come_back_unchanged(manifests: dict[str, dict[str, Any]]) -> None:
    assert set(manifests) == {"sub-001/eeg/sub-001_task-rest_eeg.vhdr", "sub-002/eeg/sub-002_task-rest_eeg.edf",
                              "sub-003/eeg/sub-003_task-rest_eeg.bdf"}
    bv = manifests["sub-001/eeg/sub-001_task-rest_eeg.vhdr"]
    assert bv["discontinuity_samples"] == [3000]
    edf = manifests["sub-002/eeg/sub-002_task-rest_eeg.edf"]
    assert "COUNTER" in edf["hidden_channels"] and edf["original_events"]["rows"] and edf["acquisition_gaps"]
    bdf = manifests["sub-003/eeg/sub-003_task-rest_eeg.bdf"]
    assert bdf["trigger_channels"] == ["Status"] and bdf["original_events"]["source"] == "stim_channel"
    for m in manifests.values():
        assert check_manifest(json.loads(json.dumps(m)), scope="study", suffixes=SUFFIXES) == m


def test_unknown_fields_are_left_out(manifests: dict[str, dict[str, Any]]) -> None:
    m = copy.deepcopy(manifests["sub-002/eeg/sub-002_task-rest_eeg.edf"])
    m["registration"] = {"registered_by": "EVIL", "retired": True}
    m["script"] = "<script>alert(1)</script>"
    out = check_manifest(m, scope="study", suffixes=SUFFIXES)
    assert "registration" not in out and "script" not in out
    m["fingerprint"]["eeg"]["sha256"] = m["fingerprint"]["eeg"]["sha256"].upper()
    assert check_manifest(m, scope="study", suffixes=SUFFIXES)["fingerprint"]["eeg"]["sha256"].islower()


def _set(m: Any, path: str, value: Any) -> None:
    *head, last = path.split(".")
    for key in head:
        m = m[int(key)] if isinstance(m, list) else m[key]
    if value is DELETE:
        m.pop(last, None)
    elif isinstance(m, list):
        m[int(last)] = value
    else:
        m[last] = value


DELETE = object()
EDF = "sub-002/eeg/sub-002_task-rest_eeg.edf"
BV = "sub-001/eeg/sub-001_task-rest_eeg.vhdr"
BDF = "sub-003/eeg/sub-003_task-rest_eeg.bdf"


@pytest.mark.parametrize("rid, path, value, words", [
    (EDF, "schema", "something.else", "schema"),
    (EDF, "schema_version", "2.0.0", "not supported"),
    (EDF, "recording_id", "../../etc/passwd_eeg.edf", "relative path"),
    (EDF, "recording_id", "/data/sub-002_task-rest_eeg.edf", "relative path"),
    (EDF, "recording_id", "sub-002\\eeg\\sub-002_task-rest_eeg.edf", "relative path"),
    (EDF, "recording_id", "sub-002/./eeg/x_eeg.edf", "relative path"),
    (EDF, "recording_id", "sub-002//x_eeg.edf", "relative path"),
    (EDF, "recording_id", "sub-002/eeg/sub-002_task-rest.edf", "suffixes"),
    (EDF, "recording_id", 7, "recording_id"),
    (EDF, "format", "gdf", "format"),
    (EDF, "format", "bdf", "must end with .bdf"),
    (EDF, "file_name", "other_eeg.edf", "file_name"),
    (EDF, "scope", "set:example", "built for"),
    (EDF, "fingerprint.eeg.sha256", "xyz", "SHA-256"),
    (EDF, "fingerprint.eeg.sha256", "0" * 63, "SHA-256"),
    (EDF, "fingerprint.eeg.size", 0, "fingerprint.eeg.size"),
    (EDF, "fingerprint.eeg.size", -5, "fingerprint.eeg.size"),
    (EDF, "fingerprint.eeg", DELETE, "fingerprint.eeg"),
    (EDF, "fingerprint.eeg.path", "../secret", "relative path"),
    (EDF, "fingerprint.backdoor", {"sha256": "0" * 64, "size": 1}, "unknown file role"),
    (EDF, "timing.sfreq", 0, "sampling rate"),
    (EDF, "timing.sfreq", -128.0, "sampling rate"),
    (EDF, "timing.sfreq", "128", "sampling rate"),
    (EDF, "timing.sfreq", True, "sampling rate"),
    (EDF, "timing.n_samples", 12.5, "whole number"),
    (EDF, "timing.n_samples", -1, "whole number"),
    (EDF, "timing.duration_s", 99.0, "duration_s"),
    (EDF, "timing.first_samp", -3, "whole number"),
    (EDF, "ch_names", [], "at least one channel"),
    (EDF, "ch_names", ["Fp1", "Fp1"], "more than once"),
    (EDF, "ch_names", ["Fp1", "\u0000"], "not a channel name"),
    (EDF, "ch_names", "Fp1", "list"),
    (EDF, "hidden_channels", ["Fp1"], "both shown and hidden"),
    (BDF, "trigger_channels", ["Fp1"], "among hidden_channels"),
    (EDF, "channel_types.Fp1", DELETE, "every channel shown"),
    (EDF, "channel_types.Ghost", "eeg", "every channel shown"),
    (EDF, "channel_types.Fp1", "brainwave", "not a channel type"),
    (EDF, "bad_channels", ["Ghost"], "among the channels shown"),
    (EDF, "acquisition_gaps", [[100, 50]], "inside the recording"),
    (EDF, "acquisition_gaps", [[0, 10**9]], "inside the recording"),
    (EDF, "acquisition_gaps", [[10, 20, 30]], "pairs"),
    (BV, "discontinuity_samples", [10**9], "whole number"),
    (EDF, "original_events.source", "telepathy", "source"),
    (EDF, "original_events.rows", [["1"]], "one text value per column"),
    (EDF, "original_events.sample.0", 10**15, "whole number"),
    (EDF, "original_events.sample.0", 1.5, "whole number"),
    (EDF, "original_events.sample", [0], "one sample"),
    (EDF, "original_events.onset_s", [0.0], "one onset"),
    (EDF, "original_events.path", "/etc/x", "relative path"),
    (EDF, "amplitude.suggested_scalings", {"eeg": -1}, "positive scale"),
    (EDF, "amplitude.suggested_scalings", {"brain": 1e-5}, "positive scale"),
    (EDF, "warnings", "not a list", "list"),
    (EDF, "warnings", ["x" * 5000], "text"),
    (EDF, "files.path", "sub-002/eeg/other_eeg.edf", "files.path"),
    (EDF, "files.stem", "a/b", "file name"),
    (BV, "files.eeg", None, "files.eeg"),
    (EDF, "events_sidecar", ["not", "an", "object"], "object"),
    (EDF, "event_report", {"x": "y" * 500_000}, "too large"),
])
def test_hostile_manifests_are_refused(manifests: dict[str, dict[str, Any]], rid: str, path: str, value: Any,
                                       words: str) -> None:
    m = copy.deepcopy(manifests[rid])
    _set(m, path, value)
    with pytest.raises(ManifestProblem) as e:
        check_manifest(m, scope="study", suffixes=SUFFIXES)
    assert words.lower() in str(e.value).lower(), str(e.value)


def test_size_and_shape_limits(manifests: dict[str, dict[str, Any]]) -> None:
    for bad in (None, [], "manifest", 5):
        with pytest.raises(ManifestProblem):
            check_manifest(bad, scope="study", suffixes=SUFFIXES)
    m = copy.deepcopy(manifests[EDF])
    m["notes"] = ["n" * 3000] * 400
    m["warnings"] = ["w" * 3000] * 400
    assert len(json.dumps(m)) > MAX_MANIFEST_BYTES
    with pytest.raises(ManifestProblem, match="larger than"):
        check_manifest(m, scope="study", suffixes=SUFFIXES)
    m = copy.deepcopy(manifests[EDF])
    m["timing"]["sfreq"] = float("nan")
    with pytest.raises(ManifestProblem, match="plain JSON"):
        check_manifest(m, scope="study", suffixes=SUFFIXES)
    # the study's own suffixes decide which recordings it takes
    with pytest.raises(ManifestProblem, match="suffixes"):
        check_manifest(copy.deepcopy(manifests[EDF]), scope="study", suffixes=("_eeg.vhdr",))


# ------------------------------------------------------------- the example set
def test_the_kept_example_manifests_are_those_mne_makes() -> None:
    """If this fails, the example set, the simulation or the loader changed: run
    ``python -m electroclean.web.example`` and commit electroclean/config/example_set_manifests.json."""
    from electroclean.app.annotations.labels import default_catalogue
    from electroclean.config.settings import load_settings
    from electroclean.web.example import _stable, build_example, template_manifests

    settings, _ = load_settings(None)
    live = build_example(settings, default_catalogue(), use_mne=True)
    kept = build_example(settings, default_catalogue(), use_mne=False)
    assert (live.registered_with, kept.registered_with) == ("mne", "template")
    assert live.recordings_zip == kept.recordings_zip  # the same recordings, byte for byte
    by_id = {m["recording_id"]: _stable(m) for m in live.manifests}
    assert by_id == {m["recording_id"]: _stable(m) for m in template_manifests()}
    assert {m["recording_id"]: _stable(m) for m in kept.manifests} == by_id
    for m in kept.manifests:  # each would be accepted from a browser too
        assert check_manifest(copy.deepcopy(m), scope="set:example", suffixes=SUFFIXES)["recording_id"]


def test_the_example_set_is_refused_when_its_files_differ(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import electroclean.web.example as example
    from electroclean.app.annotations.labels import default_catalogue
    from electroclean.config.settings import load_settings

    data = json.loads(example.TEMPLATE_PATH.read_text(encoding="utf-8"))
    data["manifests"][0]["fingerprint"]["eeg"]["sha256"] = "0" * 64
    changed = tmp_path / "kept.json"
    changed.write_text(json.dumps(data), encoding="utf-8")
    monkeypatch.setattr(example, "TEMPLATE_PATH", changed)
    settings, _ = load_settings(None)
    with pytest.raises(example.ExampleUnavailable, match="byte for byte"):
        example.build_example(settings, default_catalogue(), use_mne=False)
    monkeypatch.setattr(example, "TEMPLATE_PATH", tmp_path / "missing.json")
    with pytest.raises(example.ExampleUnavailable, match="missing"):
        example.build_example(settings, default_catalogue(), use_mne=False)


def test_the_register_command_records_how_recordings_came(tmp_path: Path) -> None:
    from electroclean.synthetic import write_edf_recording
    from electroclean.web.cli import main as cli
    from electroclean.web.store_files import FilesStore

    write_edf_recording(tmp_path / "data" / "sub-001" / "eeg", "sub-001_task-rest", duration_s=10.0, seed=4)
    study = tmp_path / "study"
    assert cli(["init-study", "--study-dir", str(study), "--study", "s"]) == 0
    assert cli(["register", str(tmp_path / "data"), "--study-dir", str(study)]) == 0
    store = FilesStore(study)
    m = store.manifests()[0]
    assert m["registration"]["registered_via"] == "command" and m["registration"]["registered_by"] == "command"
    entries, _next = store.audit_page(None, 10)
    assert [(e["op"], e["by"]) for e in entries] == [("recordings_register", "command"), ("study_create", "command")]
    assert "electroclean-web" in entries[0]["summary"] and str(tmp_path) not in json.dumps(entries)
    store.close()
