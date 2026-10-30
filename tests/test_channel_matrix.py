"""Recordings of every channel count from 1 to 257 through the Python pipeline (scripts/make_channel_matrix.py).

Each case of the matrix (EDF, EDF+, BDF and BrainVision at 128 to 2048 Hz, with the naming schemes of the
common systems and the edge cases that have broken readers before) is registered as ``electrotag web
register`` registers it. The readable ones must give a manifest with every channel and sample, and the
broken ones a refusal in plain words. Then a study with two annotators saves channel-specific annotations on
a 256-channel recording, checks the five result files, runs the agreement analysis with channel-level
matching, and adjudicates the conflicts on 256 channels through the experts' operations. The browser's side
of the same recordings is checked by web_tests/unit/data_readers.test.mjs and data_register.test.mjs.
"""

from __future__ import annotations

import json
import shutil
import sys
import time
import warnings
from pathlib import Path
from typing import Any

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import make_channel_matrix as matrix  # noqa: E402

#: What the Python registration says about each broken case (the browser says the same; see the parity tests).
REFUSED = {
    "r_empty": "is too short to hold an EDF header (0 bytes)",
    "r_header_only": "the file contains a header but no data",
    "r_no_signals": "header size 256 does not match 0 signal(s)",
    "r_bad_field": "has an unreadable header field: invalid literal for int() with base 10: 'abc'",
    "r_bad_size": "header size 1024 does not match 2 signal(s)",
    "r_bv_empty": "does not name a data file (DataFile=)",
    "r_bv_no_channels": "could not be read as a BrainVision recording: No section: 'Channel Infos'",
    "e_dup_bv": "its header gives the name 'Cz' to channels 1 and 2 and 'Pz' to channels 3, 4 and 5. MNE-Python, "
                "which ElectroTag uses to read recordings, cannot read a BrainVision recording whose channels share "
                "a name",
}


@pytest.fixture(scope="module")
def dataset(tmp_path_factory: pytest.TempPathFactory) -> Path:
    root = tmp_path_factory.mktemp("matrix")
    for case in matrix.CASES:
        matrix.write_case(case, root / case.id)
    return root


@pytest.fixture(scope="module")
def registered(dataset: Path) -> Any:
    from electrotag.app.annotations.labels import default_catalogue
    from electrotag.web.registration import collect
    from electrotag.web.store import settings_from_overrides

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")  # the filters' own warnings on the very short recordings
        return collect(dataset, settings_from_overrides({}), default_catalogue(), include_sets=False,
                       say=lambda _m: None)


def test_the_matrix_covers_every_count_format_rate_and_scheme() -> None:
    cases = [c for c in matrix.CASES if not c.broken]
    assert {c.n_eeg for c in cases} >= {1, 2, 4, 8, 16, 19, 21, 32, 64, 128, 160, 256}
    assert {c.n_channels for c in cases} >= {23, 129, 257}
    assert {(c.fmt, c.binary if c.fmt == "bv" else "", c.orientation if c.fmt == "bv" else "") for c in cases} >= {
        ("edf", "", ""), ("bdf", "", ""), ("bv", "INT_16", "MULTIPLEXED"), ("bv", "INT_16", "VECTORIZED"),
        ("bv", "IEEE_FLOAT_32", "MULTIPLEXED"), ("bv", "IEEE_FLOAT_32", "VECTORIZED")}
    assert {c.sfreq for c in cases} >= {128.0, 250.0, 256.0, 500.0, 512.0, 1000.0, 2048.0}
    names = [n for c in cases for n in c.names]
    for wanted in ("Fp1", "AF7", "AFF1h", "H32", "E256", "VREF", "1", "EEG Fpz-Cz", "fp1", "FP1-F7", "Fp2µ"):
        assert wanted in names, wanted
    assert any(len(n) > 40 and not n.isascii() for n in names)  # long names in other scripts
    assert any(c.slow for c in cases) and any(c.annotations for c in cases if c.fmt == "edf")
    assert any(c.flat_physical for c in cases) and any(c.zero for c in cases) and any(c.triggers for c in cases)


def test_every_readable_case_is_registered_with_all_its_channels_and_samples(dataset: Path, registered: Any) -> None:
    by_id = {m["recording_id"].split("/")[0]: m for m in registered.manifests}
    for case in matrix.CASES:
        if case.broken:
            assert case.id not in by_id, case.id
            continue
        m = by_id[case.id]
        n = int(round(case.duration_s * case.sfreq))
        spr = int(round(case.sfreq * case.record_s))
        padded = -(-n // spr) * spr if case.fmt != "bv" else n  # EDF/BDF hold whole data records
        assert m["timing"]["sfreq"] == case.sfreq, case.id
        assert m["timing"]["n_samples"] == padded, case.id
        assert len(m["ch_names"]) + len(m["hidden_channels"]) == case.n_channels, case.id
        if case.triggers:
            assert m["trigger_channels"] == [case.triggers], case.id
            assert m["original_events"]["rows"], case.id
        if case.annotations and case.fmt != "bv":
            assert len(m["original_events"]["rows"]) == len(case.annotations), case.id
        assert m["fingerprint"]["eeg"]["sha256"], case.id
        # far below what a study keeps for one manifest
        assert len(json.dumps(m)) < (1_000_000 if case.id == "e_many_markers" else 100_000), case.id


def test_a_marker_on_every_sample_keeps_the_first_events_and_says_so(registered: Any) -> None:
    from electrotag.web.manifest import MAX_KEPT_EVENTS

    m = next(x for x in registered.manifests if x["recording_id"].startswith("e_many_markers/"))
    ev = m["original_events"]
    assert len(ev["rows"]) == len(ev["onset_s"]) == len(ev["sample"]) == MAX_KEPT_EVENTS
    assert ev["sample"][:3] == [2000, 2001, 2002]
    assert m["event_report"]  # counted over every marker, before the study keeps the first ones
    assert m["warnings"][-1].startswith(
        "The recording has 10,500 original events, more than a study keeps for one recording (at most 10,000 events "
        "with 1,000,000 characters of text), so the study keeps the first 10,000, up to 11.999 s into the recording: "
        "the viewer shows those and the saved files list them.")
    assert len(json.dumps(m)) < 1_000_000


def test_events_with_long_rows_are_kept_while_their_text_fits() -> None:
    from electrotag.web.manifest import MAX_KEPT_EVENT_TEXT, keep_events

    rows = [["1.0", "0", "x" * 500, str(k)] for k in range(3000)]
    events = {"rows": rows, "onset_s": [float(k) for k in range(3000)], "sample": list(range(3000))}
    kept, warning = keep_events(events)
    total, fits = 0, 0
    for r in rows:
        total += sum(len(c) for c in r)
        fits += total <= MAX_KEPT_EVENT_TEXT
    assert len(kept["rows"]) == fits == 1970 and kept["sample"] == list(range(fits))
    assert warning and "so the study keeps the first 1,970, up to 1969.000 s into the recording" in warning
    assert keep_events({"rows": rows[:10], "onset_s": [0.0] * 10, "sample": [0] * 10})[1] is None


def test_broken_recordings_are_refused_in_plain_words(registered: Any) -> None:
    reasons = {rid.split("/")[0]: why for rid, why in registered.failed}
    assert set(reasons) == set(REFUSED)
    for case_id, words in REFUSED.items():
        assert words in reasons[case_id], (case_id, reasons[case_id])


def test_the_registered_manifests_pass_the_study_servers_checks(registered: Any) -> None:
    from electrotag.web.manifest_check import check_manifest

    for m in registered.manifests:
        assert check_manifest(json.loads(json.dumps(m)), scope="study",
                              suffixes=("_eeg.vhdr", "_eeg.edf", "_eeg.bdf")) == m


# ------------------------------------------------------------------ a 256-channel study
def _annotations(ch: list[str], n: int, sfreq: float, rng: np.random.Generator, k: int) -> list[dict[str, Any]]:
    from tests.web_helpers import ann

    labels = ["Eye-blink-artifact", "EMG-artifact", "Electrode-pops-artifact", "Movement-artifact"]
    out = []
    for i in range(k):
        dur = int(rng.integers(int(0.1 * sfreq), int(0.8 * sfreq)))
        start = int(rng.integers(0, n - dur))
        size = int(rng.choice([0, 1, 3, len(ch) // 2, len(ch) - 1]))
        picks = sorted(rng.choice(len(ch), size=size, replace=False).tolist()) if size else []
        out.append(ann(f"{i:032x}", labels[i % len(labels)], start, dur, [ch[j] for j in picks]))
    return out


def test_a_256_channel_study_saves_compares_and_adjudicates(dataset: Path, tmp_path: Path) -> None:
    pytest.importorskip("fastapi")
    from electrotag.reliability.cli import main as agreement
    from electrotag.web.cli import main as cli
    from electrotag.web.service import StudyService
    from electrotag.web.store import User
    from electrotag.web.store_files import FilesStore
    from tests.web_helpers import submission

    data = tmp_path / "data"
    case = matrix.CASES_BY_ID["c256n"]  # EGI E1 to E256 with a trigger channel, EDF
    matrix.write_case(case, data / case.id)
    study = tmp_path / "study"
    assert cli(["init-study", "--study-dir", str(study), "--study", "s"]) == 0
    assert cli(["register", str(data), "--study-dir", str(study)]) == 0
    for who in ("A01", "A02"):
        assert cli(["add-user", who, "--password", "a-long-password", "--study-dir", str(study)]) == 0
        assert cli(["assign", who, "--all", "--study-dir", str(study)]) == 0
    service = StudyService(FilesStore(study))
    try:
        m = service.store.manifests()[0]
        rid, ch = m["recording_id"], list(m["ch_names"])
        n, sfreq = int(m["timing"]["n_samples"]), float(m["timing"]["sfreq"])
        assert len(ch) == 256
        rng = np.random.default_rng(256)
        mine = _annotations(ch, n, sfreq, rng, 40)
        theirs = [dict(a, annotation_id="f" + a["annotation_id"][1:],
                       onset_sample=min(n - a["duration_samples"], a["onset_sample"] + int(rng.integers(-5, 6)) + 5),
                       channels=a["channels"][:-1] if len(a["channels"]) > 1 and k % 3 == 0 else a["channels"],
                       label="EMG-artifact" if k % 7 == 0 else a["label"]) for k, a in enumerate(mine)]

        recordings = tmp_path / "recordings"  # where submission() finds the file to fingerprint
        (recordings / "study" / rid).parent.mkdir(parents=True)
        shutil.copyfile(data / rid, recordings / "study" / rid)
        t0 = time.perf_counter()
        for user, anns in ((User("A01", "One"), mine), (User("A02", "Two"), theirs)):
            body = submission(recordings, rid, anns)
            body["session"]["view"]["n_channels"] = 40
            saved = service.call("submit", user, body)
            assert saved["saved"] and len(saved["files"]) == 5
        assert time.perf_counter() - t0 < 30
        folder = study / "Annotated_Events" / "annotator-A01" / case.id
        doc = json.loads(next(folder.glob("*_annotations.json")).read_text(encoding="utf-8"))
        kept = {a["annotation_id"]: a["channels"] for a in doc["annotations"]}
        assert kept == {a["annotation_id"]: a["channels"] for a in mine}
        assert len(doc["recording"]["ch_names"]) == 256
        # the agreement analysis, by time and by channel
        out = tmp_path / "agreement"
        assert agreement([str(study / "Annotated_Events"), "--out", str(out), "--no-html",
                          "--channel-modes", "time_only", "time_and_channel"]) == 0
        assert any(out.glob("*.tsv"))
        # adjudication on 256 channels by an expert who annotated neither version
        expert = User("E01", "Expert", roles=("annotator", "expert"))

        def ex(op: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
            return service.call("expert", expert, {"op": op, **(body or {})})

        unit = next(u for u in ex("adjudication_list")["units"] if u.get("recording_id") == rid)
        got = ex("adjudication_get", {"unit_id": unit["unit_id"]})
        assert got["conflicts"] and len(got["manifest"]["ch_names"]) == 256
        ex("adjudication_start", {"unit_id": unit["unit_id"]})
        for c in got["conflicts"]:
            m0 = c["marks"][0]
            ex("adjudication_decide", {"unit_id": unit["unit_id"], "conflict_id": c["conflict_id"], "choice": "edited",
                                       "reason_code": "clear_artifact",
                                       "marks": [{"label": m0["label"], "onset_sample": m0["onset_sample"],
                                                  "duration_samples": m0["duration_samples"], "channels": ch[:-1]}]})
        fin = ex("adjudication_finish", {"unit_id": unit["unit_id"]})
        assert fin["version"]["n_annotations"] >= len(got["conflicts"])
    finally:
        service.store.close()
