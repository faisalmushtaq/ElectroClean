"""``python -m electrotag``: the same as the ``electrotag`` command (:mod:`electrotag.cli`).

On its own it lists ElectroTag's tools and how to start the demonstration;
``python -m electrotag web demo`` starts the demonstration as ``electrotag web demo`` does.
"""

from __future__ import annotations

import sys

from electrotag.cli import main

if __name__ == "__main__":
    sys.exit(main())
