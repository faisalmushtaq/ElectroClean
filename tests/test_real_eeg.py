"""Real recordings through the Python registration, when ELECTROTAG_REAL_EEG names a folder of datasets.

Each folder in ELECTROTAG_REAL_EEG is registered as ``electrotag web register`` registers a dataset. Every
recording must either give a manifest that agrees with MNE-Python's reading (channels and samples) and passes
the study server's checks, or be refused in words a person can act on. docs/testing_guide.md ("Real
recordings") lists the public recordings used and how to lay them out. Without the variable the test is
skipped; the recordings are only read, never written.
"""

from __future__ import annotations

import json
import os
import time
import warnings
from pathlib import Path

import pytest

REAL = os.environ.get("ELECTROTAG_REAL_EEG")
if not REAL:
    pytest.skip("set ELECTROTAG_REAL_EEG to a folder of datasets of real recordings", allow_module_level=True)

DATASETS = sorted(p for p in Path(REAL).iterdir() if p.is_dir() and not p.name.startswith("."))


@pytest.mark.parametrize("folder", DATASETS, ids=[p.name for p in DATASETS])
def test_real_dataset_registers_as_mne_reads_it(folder: Path) -> None:
    import mne

    from electrotag.app.annotations.labels import default_catalogue
    from electrotag.web.manifest_check import check_manifest
    from electrotag.web.registration import collect
    from electrotag.web.store import settings_from_overrides

    t0 = time.perf_counter()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        reg = collect(folder, settings_from_overrides({}), default_catalogue(), include_sets=False,
                      say=lambda _m: None)
    seconds = time.perf_counter() - t0
    assert reg.manifests or reg.failed, f"no recordings found in {folder}"
    for rid, why in reg.failed:
        assert why and "Traceback" not in why, (rid, why)
    for m in reg.manifests:
        path = folder / m["recording_id"]
        reader = {"edf": mne.io.read_raw_edf, "bdf": mne.io.read_raw_bdf}.get(m["format"], mne.io.read_raw_brainvision)
        kw = {"infer_types": False} if m["format"] in ("edf", "bdf") else {}
        raw = reader(path, preload=False, verbose="error", **kw)
        assert m["timing"]["n_samples"] == raw.n_times and m["timing"]["sfreq"] == raw.info["sfreq"]
        assert sorted(m["ch_names"] + m["hidden_channels"]) == sorted(raw.ch_names)
        assert check_manifest(json.loads(json.dumps(m)), scope="study",
                              suffixes=("_eeg.vhdr", "_eeg.edf", "_eeg.bdf")) == m
        print(f"{m['recording_id']}: {len(raw.ch_names)} channels, {raw.n_times / raw.info['sfreq']:.0f} s, "
              f"manifest {len(json.dumps(m)) / 1000:.0f} kB")
    print(f"{folder.name}: {len(reg.manifests)} registered, {len(reg.failed)} refused, in {seconds:.1f} s")
