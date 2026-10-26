"""Create a synthetic BIDS/BrainVision dataset to try ElectroClean.

    python examples/make_synthetic_dataset.py OUTPUT_FOLDER [--subjects 3] [--duration 120] [--seed 0]
        [--line-frequency 50] [--with-problems]

``--with-problems`` adds a recording whose original event codes clash with the
artifact codes, a recording with a discontinuity, and two recordings with the
same file name in different folders, which exercise the corresponding checks.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("output", type=Path)
    ap.add_argument("--subjects", type=int, default=3)
    ap.add_argument("--duration", type=float, default=120.0)
    ap.add_argument("--sfreq", type=float, default=250.0)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--line-frequency", type=float, default=60.0)
    ap.add_argument("--with-problems", action="store_true")
    a = ap.parse_args(argv)
    from electroclean.synthetic import make_synthetic_dataset

    truths = make_synthetic_dataset(
        a.output, n_subjects=a.subjects, sfreq=a.sfreq, duration_s=a.duration, seed=a.seed, line_freq=a.line_frequency,
        with_collision_recording=a.with_problems, with_duplicate_names=a.with_problems, with_discontinuity=a.with_problems,
    )
    for rid, doc in truths.items():
        print(f"{rid}: {len(doc.annotations)} artifacts (ground truth in derivatives/ground_truth)")
    print(f"Dataset written to {a.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
