"""Settings of an agreement analysis (all recorded in the report)."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Any

CHANNEL_MODES = ("time_only", "time_and_channel")
MATCH_CRITERIA = ("iou", "tolerance", "iou_and_tolerance")
ANY_ARTIFACT = "ANY-artifact"
#: Which versions of the annotations an analysis uses (electrotag/reliability/versions.py).
VERSIONS = ("original", "corrected", "adjudicated")
#: What a recording group is: the whole recording, or each task's part of it (a task's window).
UNITS = ("recording", "task")
#: The annotator ID of every adjudicated version (a reserved ID, never an account).
ADJUDICATED = "ADJUDICATED"
#: Suffix of the roll-up category of a group term: the group term and every type below it.
ROLLUP_SUFFIX = " + subtypes"


def rollup_name(group: str) -> str:
    return f"{group}{ROLLUP_SUFFIX}"


def is_rollup(category: str) -> bool:
    return category.endswith(ROLLUP_SUFFIX)


@dataclass
class AnalysisConfig:
    """Parameters of the reliability analysis.

    Defaults are starting points for exploration, not recommendations: the
    research team should choose and report them for each study.
    """

    # Time-resolved agreement
    resolutions_s: tuple[float, ...] = (0.01, 0.05, 0.1)
    min_bin_coverage: float = 0.5  # 0 = any overlap marks the bin positive
    channel_modes: tuple[str, ...] = CHANNEL_MODES
    include_any_artifact: bool = True  # pseudo-category: any artifact versus none
    include_group_rollups: bool = True  # e.g. "Eye-artifact + subtypes": agreement on the artifact family

    # Event (interval) matching
    match_criterion: str = "iou"
    iou_thresholds: tuple[float, ...] = (0.0, 0.2, 0.5)  # 0 = any overlap
    primary_iou_threshold: float = 0.2  # used for timing statistics and plots
    onset_tolerance_s: float = 0.5
    offset_tolerance_s: float = 0.5
    allow_many_to_one: bool = False
    min_channel_jaccard: float = 0.0  # time_and_channel matching: 0 = at least one shared channel

    # Which annotations to analyse
    categories: tuple[str, ...] | None = None  # None = every label of the catalogue
    annotators: tuple[str, ...] | None = None  # None = all found
    modes: tuple[str, ...] = ("standard",)
    reference_annotator: str | None = None  # if set, compare everyone with this annotator only
    duplicate_policy: str = "latest"  # or "error"
    channel_exclude: tuple[str, ...] = ()
    # The originals (as annotated), the experts' corrections of them, or the adjudicated versions as the reference
    versions: str = "original"
    unit: str = "recording"  # or "task": each task's part of a recording is compared on its own

    # Report
    timeline_max_recordings: int = 12
    # Categories with fewer annotations than this (all annotators and recordings together) are listed in the
    # report's tables but left out of its figures, where they would look like real results.
    min_events_per_category: int = 5
    extra_measures: tuple[str, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        # The adjudicated versions are the reference: everyone is compared with them.
        if self.versions == "adjudicated" and not self.reference_annotator:
            self.reference_annotator = ADJUDICATED

    def validate(self) -> None:
        if self.versions not in VERSIONS:
            raise ValueError(f"versions must be one of {VERSIONS}")
        if self.unit not in UNITS:
            raise ValueError(f"unit must be one of {UNITS}")
        if self.versions == "adjudicated" and self.reference_annotator != ADJUDICATED:
            raise ValueError(f"The adjudicated versions are compared with everyone else, so the reference annotator "
                             f"must be {ADJUDICATED} (or none)")
        if not self.resolutions_s or any(r <= 0 for r in self.resolutions_s):
            raise ValueError("Resolutions must be positive numbers of seconds")
        if len(set(self.resolutions_s)) != len(self.resolutions_s):
            raise ValueError("Each resolution may be listed only once")
        if not 0 <= self.min_bin_coverage <= 1:
            raise ValueError("min_bin_coverage must be between 0 and 1")
        bad = [m for m in self.channel_modes if m not in CHANNEL_MODES]
        if bad or not self.channel_modes:
            raise ValueError(f"channel_modes must be drawn from {CHANNEL_MODES}")
        if self.match_criterion not in MATCH_CRITERIA:
            raise ValueError(f"match_criterion must be one of {MATCH_CRITERIA}")
        if any(not 0 <= t < 1 for t in self.iou_thresholds):
            raise ValueError("IoU thresholds must be in [0, 1)")
        if not 0 <= self.primary_iou_threshold < 1:
            raise ValueError("primary_iou_threshold must be in [0, 1)")
        if not 0 <= self.min_channel_jaccard <= 1:
            raise ValueError("min_channel_jaccard must be between 0 and 1")
        if self.duplicate_policy not in ("latest", "error"):
            raise ValueError("duplicate_policy must be 'latest' or 'error'")
        if self.onset_tolerance_s < 0 or self.offset_tolerance_s < 0:
            raise ValueError("Tolerances cannot be negative")
        if self.min_events_per_category < 0:
            raise ValueError("min_events_per_category cannot be negative")

    @property
    def matching_thresholds(self) -> tuple[float, ...]:
        """Thresholds evaluated (the primary one is always included)."""
        if self.match_criterion == "tolerance":
            return (self.primary_iou_threshold,)
        ts = set(self.iou_thresholds) | {self.primary_iou_threshold}
        return tuple(sorted(ts))

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        return {k: (list(v) if isinstance(v, tuple) else v) for k, v in d.items()}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> AnalysisConfig:
        known = {f.name for f in fields(cls)}
        kwargs = {}
        for k, v in data.items():
            if k not in known:
                raise ValueError(f"Unknown analysis setting {k!r}")
            kwargs[k] = tuple(v) if isinstance(v, list) else v
        cfg = cls(**kwargs)
        cfg.validate()
        return cfg

    @classmethod
    def load(cls, path: Path) -> AnalysisConfig:
        return cls.from_dict(json.loads(Path(path).read_text(encoding="utf-8-sig")))
