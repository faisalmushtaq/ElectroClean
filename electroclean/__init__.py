"""ElectroClean: manual EEG artifact annotation and reliability assessment.

The package is organised as follows:

``electroclean.app``
    Component A, the annotation application. The GUI lives in
    ``electroclean.app.gui``; everything else (annotation model, EEG loading,
    file IO, validation and session management) is GUI-independent and can be
    used from scripts.
``electroclean.reliability``
    Component B, inter-rater agreement analysis.
``electroclean.training``
    Component C, annotator training and competency assessment.
``electroclean.config``
    Version-controlled configuration (artifact label catalogue and defaults).
"""

from __future__ import annotations

__all__ = ["__version__", "APP_NAME"]

__version__ = "1.1.0"
APP_NAME = "ElectroClean"
