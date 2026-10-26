"""Allow ``python -m electroclean`` to launch the desktop application."""

from __future__ import annotations

import sys

from electroclean.app.main import main

if __name__ == "__main__":
    sys.exit(main())
