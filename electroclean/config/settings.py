"""Application settings and the optional study configuration file.

Defaults live in ``default_settings.json`` next to this module. A study
administrator can override them for a dataset by placing an
``electroclean_study.json`` file in the dataset root (see
``docs/file_formats.md``). Settings that the administrator marks as locked
(for example the viewing filters used in a reliability study) cannot be
changed by annotators in the GUI.
"""

from __future__ import annotations

import copy
import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

CONFIG_DIR = Path(__file__).resolve().parent
DEFAULT_SETTINGS_PATH = CONFIG_DIR / "default_settings.json"
STUDY_CONFIG_FILENAME = "electroclean_study.json"

COLLISION_POLICIES = ("require_explicit_policy", "preserve_and_flag")
SELECTION_STRATEGIES = ("random", "seeded", "manual")
FILTER_METHODS = ("fir", "iir")
NOTCH_FREQUENCIES = (50.0, 60.0)


class SettingsError(ValueError):
    """Raised when a settings or study configuration file is invalid."""


def deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    """Return a copy of ``base`` with ``override`` merged in recursively."""
    out = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


@dataclass(frozen=True)
class FilterSettings:
    """Viewing filters applied to the displayed copy of the EEG only.

    The source recording is never filtered or modified.
    """

    highpass_enabled: bool = True
    highpass_hz: float = 1.0
    notch_enabled: bool = True
    notch_hz: float = 60.0
    notch_harmonics: bool = False
    method: str = "fir"
    iir_order: int = 4
    locked: bool = False

    def validate(self) -> None:
        if self.method not in FILTER_METHODS:
            raise SettingsError(f"Filter method must be one of {FILTER_METHODS}, got {self.method!r}")
        if self.highpass_enabled and not (self.highpass_hz > 0):
            raise SettingsError("High-pass cut-off must be a positive frequency")
        if self.notch_enabled and float(self.notch_hz) not in NOTCH_FREQUENCIES:
            raise SettingsError(f"Notch frequency must be 50 or 60 Hz, got {self.notch_hz}")
        if self.method == "iir" and not (1 <= int(self.iir_order) <= 8):
            raise SettingsError("IIR order must be between 1 and 8")

    def describe(self) -> str:
        """Short human-readable summary shown in the viewer."""
        parts = []
        if self.highpass_enabled:
            parts.append(f"High-pass {self.highpass_hz:g} Hz")
        else:
            parts.append("No high-pass")
        if self.notch_enabled:
            harm = " + harmonics" if self.notch_harmonics else ""
            parts.append(f"Notch {self.notch_hz:g} Hz{harm}")
        else:
            parts.append("No notch")
        parts.append(self.method.upper())
        return ", ".join(parts)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> FilterSettings:
        d = cls()
        obj = cls(
            highpass_enabled=bool(data.get("highpass_enabled", d.highpass_enabled)),
            highpass_hz=float(data.get("highpass_hz", d.highpass_hz)),
            notch_enabled=bool(data.get("notch_enabled", d.notch_enabled)),
            notch_hz=float(data.get("notch_hz", d.notch_hz)),
            notch_harmonics=bool(data.get("notch_harmonics", d.notch_harmonics)),
            method=str(data.get("method", d.method)).lower(),
            iir_order=int(data.get("iir_order", d.iir_order)),
            locked=bool(data.get("locked", d.locked)),
        )
        obj.validate()
        return obj


@dataclass(frozen=True)
class DisplaySettings:
    duration_s: float = 10.0
    n_channels: int = 20
    scalings: dict[str, float] = field(default_factory=dict)
    theme: str = "light"
    overview_mode: str = "channels"


@dataclass(frozen=True)
class Settings:
    """All application settings after merging defaults and study overrides."""

    output_directory_name: str
    output_directory: str | None
    discovery_suffix: str
    discovery_exclude_dir_names: tuple[str, ...]
    discovery_follow_symlinks: bool
    filters: FilterSettings
    display: DisplaySettings
    preload_memory_limit_mb: float
    hash_source_files: bool
    apply_channel_types_from_bids: bool
    show_bids_bad_channels: bool
    collision_policy: str
    selection_strategy: str
    selection_seed: int | None
    recording_lock_stale_hours: float
    register_lock_timeout_s: float
    min_duration_samples: int
    raw: dict[str, Any] = field(repr=False, default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Settings:
        try:
            out = data["output"]
            disc = data["discovery"]
            disp = data["display"]
            load = data["loading"]
            ev = data["events"]
            sel = data["selection"]
            locks = data["locks"]
            ann = data["annotation"]
            settings = cls(
                output_directory_name=str(out["directory_name"]),
                output_directory=out.get("directory"),
                discovery_suffix=str(disc["suffix"]),
                discovery_exclude_dir_names=tuple(disc.get("exclude_dir_names", [])),
                discovery_follow_symlinks=bool(disc.get("follow_symlinks", False)),
                filters=FilterSettings.from_dict(data["filters"]),
                display=DisplaySettings(
                    duration_s=float(disp["duration_s"]),
                    n_channels=int(disp["n_channels"]),
                    scalings={k: float(v) for k, v in disp.get("scalings", {}).items()},
                    theme=str(disp.get("theme", "light")),
                    overview_mode=str(disp.get("overview_mode", "channels")),
                ),
                preload_memory_limit_mb=float(load["preload_memory_limit_mb"]),
                hash_source_files=bool(load["hash_source_files"]),
                apply_channel_types_from_bids=bool(load.get("apply_channel_types_from_bids", True)),
                show_bids_bad_channels=bool(load.get("show_bids_bad_channels", True)),
                collision_policy=str(ev["collision_policy"]),
                selection_strategy=str(sel["strategy"]),
                selection_seed=None if sel.get("seed") is None else int(sel["seed"]),
                recording_lock_stale_hours=float(locks["recording_lock_stale_hours"]),
                register_lock_timeout_s=float(locks["register_lock_timeout_s"]),
                min_duration_samples=int(ann["min_duration_samples"]),
                raw=copy.deepcopy(data),
            )
        except KeyError as exc:  # pragma: no cover - defaults always complete
            raise SettingsError(f"Missing setting: {exc}") from exc
        settings.validate()
        return settings

    def validate(self) -> None:
        if self.collision_policy not in COLLISION_POLICIES:
            raise SettingsError(
                f"events.collision_policy must be one of {COLLISION_POLICIES}, got {self.collision_policy!r}"
            )
        if self.selection_strategy not in SELECTION_STRATEGIES:
            raise SettingsError(
                f"selection.strategy must be one of {SELECTION_STRATEGIES}, got {self.selection_strategy!r}"
            )
        if self.selection_strategy == "seeded" and self.selection_seed is None:
            raise SettingsError("selection.seed is required when selection.strategy is 'seeded'")
        if not self.discovery_suffix.endswith(".vhdr"):
            raise SettingsError("discovery.suffix must end with '.vhdr'")
        if self.min_duration_samples < 1:
            raise SettingsError("annotation.min_duration_samples must be at least 1")
        if not self.output_directory_name or any(c in self.output_directory_name for c in "/\\:"):
            raise SettingsError("output.directory_name must be a plain folder name")

    def with_filters(self, filters: FilterSettings) -> Settings:
        """Return a copy with different viewing filters (respecting locks)."""
        if self.filters.locked and filters != self.filters:
            raise SettingsError("Filter settings are fixed by the study administrator")
        filters.validate()
        data = copy.deepcopy(self.raw)
        data["filters"] = filters.to_dict()
        return Settings.from_dict(data)


def load_default_settings_dict() -> dict[str, Any]:
    return json.loads(DEFAULT_SETTINGS_PATH.read_text(encoding="utf-8"))


@dataclass(frozen=True)
class AnnotatorEntry:
    annotator_id: str
    display_name: str = ""


@dataclass(frozen=True)
class StudyConfig:
    """Optional per-dataset configuration written by a study administrator."""

    path: Path
    study_id: str
    settings_overrides: dict[str, Any]
    annotators: tuple[AnnotatorEntry, ...]
    allow_unlisted_annotators: bool
    manual_assignments: dict[str, tuple[str, ...]]
    admin_passphrase: dict[str, str] | None
    training: dict[str, Any]
    raw: dict[str, Any] = field(repr=False, default_factory=dict)

    @classmethod
    def load(cls, path: Path) -> StudyConfig:
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
        except json.JSONDecodeError as exc:
            raise SettingsError(f"Study configuration {path} is not valid JSON: {exc}") from exc
        if not isinstance(data, dict):
            raise SettingsError(f"Study configuration {path} must contain a JSON object")
        annotators = []
        for entry in data.get("annotators", []):
            if isinstance(entry, str):
                annotators.append(AnnotatorEntry(entry))
            else:
                annotators.append(
                    AnnotatorEntry(str(entry["annotator_id"]), str(entry.get("display_name", "")))
                )
        allocation = data.get("allocation", {}) or {}
        assignments = {
            str(k): tuple(str(x) for x in v) for k, v in (allocation.get("assignments") or {}).items()
        }
        overrides = copy.deepcopy(data.get("settings", {}) or {})
        # Allocation strategy and seed can be given in the allocation block for readability.
        if "strategy" in allocation or "seed" in allocation:
            sel = overrides.setdefault("selection", {})
            if "strategy" in allocation:
                sel["strategy"] = allocation["strategy"]
            if "seed" in allocation:
                sel["seed"] = allocation["seed"]
        return cls(
            path=path,
            study_id=str(data.get("study_id", "")),
            settings_overrides=overrides,
            annotators=tuple(annotators),
            allow_unlisted_annotators=bool(data.get("allow_unlisted_annotators", True)),
            manual_assignments=assignments,
            admin_passphrase=data.get("admin_passphrase"),
            training=dict(data.get("training", {}) or {}),
            raw=data,
        )


def find_study_config(dataset_root: Path) -> Path | None:
    candidate = Path(dataset_root) / STUDY_CONFIG_FILENAME
    return candidate if candidate.is_file() else None


def load_settings(
    dataset_root: Path | None = None,
    overrides: dict[str, Any] | None = None,
) -> tuple[Settings, StudyConfig | None]:
    """Load defaults, then the dataset's study config, then explicit overrides."""
    data = load_default_settings_dict()
    study = None
    if dataset_root is not None:
        path = find_study_config(Path(dataset_root))
        if path is not None:
            study = StudyConfig.load(path)
            data = deep_merge(data, study.settings_overrides)
    if overrides:
        data = deep_merge(data, overrides)
    return Settings.from_dict(data), study
