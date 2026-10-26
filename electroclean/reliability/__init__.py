"""Component B: inter-rater agreement for continuous EEG artifact annotations.

Typical use::

    from electroclean.reliability import AnalysisConfig, run_analysis, write_outputs
    result = run_analysis(["Annotated_Events"], AnalysisConfig())
    write_outputs(result, "agreement_results")

See ``docs/reliability_guide.md`` for the measures and their assumptions.
"""

from __future__ import annotations

from electroclean.reliability.analysis import MEASURES, AnalysisResult, register_measure, run_analysis, write_outputs
from electroclean.reliability.config import AnalysisConfig
from electroclean.reliability.data import build_dataset, load_dataset

__all__ = [
    "MEASURES",
    "AnalysisConfig",
    "AnalysisResult",
    "build_dataset",
    "load_dataset",
    "register_measure",
    "run_analysis",
    "write_outputs",
]
