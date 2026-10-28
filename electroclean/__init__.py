"""ElectroClean: manual EEG artifact annotation and reliability assessment.

Annotators work in a web browser (``electroclean.web.static``); this package holds everything
else, in plain Python, so that annotations can be processed without any interface:

``electroclean.app``
    The annotation core: the annotation model and store, EEG loading with MNE-Python, file IO and
    export, validation, and the journalled session save that writes and verifies the outputs.
``electroclean.reliability``
    Inter-rater agreement analysis (``electroclean-agreement``).
``electroclean.training``
    Annotator training and competency assessment (``electroclean-admin``).
``electroclean.activity``
    Tables and learning curves from the interaction logs (``electroclean-activity``).
``electroclean.web``
    The browser application, the ElectroClean server and the Firebase functions, all built on the
    packages above (``electroclean-web``).
``electroclean.config``
    Version-controlled configuration (artifact label catalogue and defaults).
"""

from __future__ import annotations

__all__ = ["__version__", "APP_NAME"]

__version__ = "1.1.0"
APP_NAME = "ElectroClean"
