"""Open the ElectroClean desktop application on a fresh synthetic dataset.

    python examples/launch_demo_gui.py [dataset_folder]

If the folder does not exist, a three-subject synthetic dataset is created
there first (default: ./demo_gui_data).
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main() -> int:
    folder = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("demo_gui_data")
    if not folder.exists():
        from electroclean.synthetic import make_synthetic_dataset

        make_synthetic_dataset(folder, n_subjects=3, duration_s=120.0, seed=1)
        print(f"Synthetic dataset created in {folder.resolve()}")
    from electroclean.app.main import main as app_main

    return app_main(["--dataset", str(folder.resolve()), "--annotator", "A01"])


if __name__ == "__main__":
    sys.exit(main())
