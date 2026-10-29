"""ElectroTag: manual EEG artifact annotation and reliability assessment.

Annotators work in a web browser (``electrotag.web.static``); this package holds everything
else, in plain Python, so that annotations can be processed without any interface:

``electrotag.app``
    The annotation core: the annotation model and store, EEG loading with MNE-Python, file IO and
    export, validation, and the journalled session save that writes and verifies the outputs.
``electrotag.reliability``
    Inter-rater agreement analysis (``electrotag agreement``).
``electrotag.training``
    Annotator training and competency assessment (``electrotag admin``).
``electrotag.activity``
    Tables and learning curves from the interaction logs (``electrotag activity``).
``electrotag.web``
    The browser application, the ElectroTag server and the Firebase functions, all built on the
    packages above (``electrotag web``).
``electrotag.config``
    Version-controlled configuration (artifact label catalogue and defaults).
``electrotag.cli``
    The ``electrotag`` command, which lists the tools and runs each of them.
"""

from __future__ import annotations

__all__ = ["__version__", "APP_NAME"]

__version__ = "1.1.0"
APP_NAME = "ElectroTag"
