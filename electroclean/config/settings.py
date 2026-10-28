"""Application settings and the optional study configuration file.

Defaults live in ``default_settings.json`` next to this module. A study
administrator can override them for a dataset by placing an
``electroclean_study.json`` file in the dataset root (see
``docs/file_formats.md``). Settings that the administrator marks as locked
(for example the viewing filters used in a reliability study) cannot be
changed by annotators. A study run in the browser keeps the same settings with
its records (``electroclean-web init-study``).
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

SELECTION_STRATEGIES = ("random", "seeded", "manual")
RECORDING_EXTENSIONS = (".vhdr", ".edf", ".bdf")
# Channel types that the channels.types setting may assign (MNE-Python's names).
CHANNEL_TYPES = ("eeg", "eog", "ecg", "emg", "misc", "stim", "resp", "bio", "gsr", "temperature")
FILTER_METHODS = ("fir", "iir")
NOTCH_FREQUENCIES = (50.0, 60.0)
COVERAGE_CHECKS = ("warn", "off")


class SettingsError(ValueError):
    """Raised when a settings or study configuration file is invalid."""


def _minutes(value: Any, name: str) -> float:
    """A number of minutes from a settings file, or a plain-words error."""
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise SettingsError(f"{name} must be a number of minutes")
    try:
        out = float(value)
    except ValueError as exc:
        raise SettingsError(f"{name} must be a number of minutes, not {value!r}") from exc
    if out != out or out in (float("inf"), float("-inf")):
        raise SettingsError(f"{name} must be a number of minutes")
    return out


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
    notch_hz: float = 50.0  # UK/European mains; 60 Hz can be chosen
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


#: The artifact types on keys 1 to 9 unless a study chooses others (annotation.quick_labels).
DEFAULT_QUICK_LABELS: tuple[str, ...] = (
    "Eye-blink-artifact",
    "Horizontal-eye-movement-artifact",
    "EMG-artifact",
    "Movement-artifact",
    "Electrode-pops-artifact",
    "Chewing-artifact",
    "ECG-artifact",
    "Line-noise-artifact",
    "Data-artifact",  # the group term for an artifact whose type is unclear
)


@dataclass(frozen=True)
class DisplaySettings:
    duration_s: float = 10.0
    n_channels: int = 32
    scalings: dict[str, float] = field(default_factory=dict)
    theme: str = "light"
    overview_mode: str = "empty"


@dataclass(frozen=True)
class Settings:
    """All application settings after merging defaults and study overrides."""

    output_directory_name: str
    output_directory: str | None
    discovery_suffixes: tuple[str, ...]
    discovery_exclude_dir_names: tuple[str, ...]
    discovery_follow_symlinks: bool
    filters: FilterSettings
    display: DisplaySettings
    preload_memory_limit_mb: float
    hash_source_files: bool
    apply_channel_types_from_bids: bool
    show_bids_bad_channels: bool
    hidden_channel_patterns: tuple[str, ...]
    selection_strategy: str
    selection_seed: int | None
    recording_lock_stale_hours: float
    register_lock_timeout_s: float
    min_duration_samples: int
    # The artifact types on the number keys 1 to 9 (and the toolbar's quick buttons), in key order.
    quick_labels: tuple[str, ...] = DEFAULT_QUICK_LABELS
    # channels.types: (name pattern, MNE channel type) pairs, applied in order when a recording is loaded.
    channel_type_patterns: tuple[tuple[str, str], ...] = ()
    # logging: the interaction log of each visit (research data; see docs/activity_logs.md).
    logging_interactions: bool = True
    logging_pointer_hz: float = 5.0  # pointer samples per second over the EEG (0: none)
    logging_idle_after_s: float = 30.0  # seconds without input after which the annotator counts as idle
    # annotation: comfort for long sessions in the browser (docs/web/using.md, "Pausing and breaks").
    break_reminder_minutes: float = 50.0  # minutes of work since the last break before a reminder (0: none)
    idle_pause_minutes: float = 3.0  # minutes without input after which the clock pauses itself (0: never)
    coverage_check: str = "warn"  # "warn": Save and Finish lists the parts never on screen; "off"
    raw: dict[str, Any] = field(repr=False, default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Settings:
        try:
            out = data["output"]
            disc = data["discovery"]
            disp = data["display"]
            load = data["loading"]
            sel = data["selection"]
            locks = data["locks"]
            ann = data["annotation"]
            chans = data.get("channels", {}) or {}
            logs = data.get("logging", {}) or {}
            types = chans.get("types", {}) or {}
            if not isinstance(types, dict):
                raise SettingsError(
                    'channels.types must map channel-name patterns to channel types, for example {"EXG*": "misc"}'
                )
            # Study files written before EDF support give a single "suffix".
            suffixes = [disc["suffix"]] if disc.get("suffix") else list(disc.get("suffixes", []))
            settings = cls(
                output_directory_name=str(out["directory_name"]),
                output_directory=out.get("directory"),
                discovery_suffixes=tuple(str(x) for x in suffixes),
                discovery_exclude_dir_names=tuple(disc.get("exclude_dir_names", [])),
                discovery_follow_symlinks=bool(disc.get("follow_symlinks", False)),
                filters=FilterSettings.from_dict(data["filters"]),
                display=DisplaySettings(
                    duration_s=float(disp["duration_s"]),
                    n_channels=int(disp["n_channels"]),
                    scalings={k: float(v) for k, v in disp.get("scalings", {}).items()},
                    theme=str(disp.get("theme", "light")),
                    overview_mode=str(disp.get("overview_mode", "empty")),
                ),
                preload_memory_limit_mb=float(load["preload_memory_limit_mb"]),
                hash_source_files=bool(load["hash_source_files"]),
                apply_channel_types_from_bids=bool(load.get("apply_channel_types_from_bids", True)),
                show_bids_bad_channels=bool(load.get("show_bids_bad_channels", True)),
                hidden_channel_patterns=tuple(str(x) for x in chans.get("hide", [])),
                selection_strategy=str(sel["strategy"]),
                selection_seed=None if sel.get("seed") is None else int(sel["seed"]),
                recording_lock_stale_hours=float(locks["recording_lock_stale_hours"]),
                register_lock_timeout_s=float(locks["register_lock_timeout_s"]),
                min_duration_samples=int(ann["min_duration_samples"]),
                quick_labels=tuple(str(x) for x in ann.get("quick_labels", DEFAULT_QUICK_LABELS)),
                break_reminder_minutes=_minutes(ann.get("break_reminder_minutes", 50.0),
                                                "annotation.break_reminder_minutes"),
                idle_pause_minutes=_minutes(ann.get("idle_pause_minutes", 3.0), "annotation.idle_pause_minutes"),
                coverage_check=str(ann.get("coverage_check", "warn")),
                channel_type_patterns=tuple((str(k), str(v).strip().lower()) for k, v in types.items()),
                logging_interactions=bool(logs.get("interactions", True)),
                logging_pointer_hz=float(logs.get("pointer_hz", 5.0)),
                logging_idle_after_s=float(logs.get("idle_after_s", 30.0)),
                raw=copy.deepcopy(data),
            )
        except KeyError as exc:  # pragma: no cover - defaults always complete
            raise SettingsError(f"Missing setting: {exc}") from exc
        settings.validate()
        return settings

    def validate(self) -> None:
        if self.selection_strategy not in SELECTION_STRATEGIES:
            raise SettingsError(
                f"selection.strategy must be one of {SELECTION_STRATEGIES}, got {self.selection_strategy!r}"
            )
        if self.selection_strategy == "seeded" and self.selection_seed is None:
            raise SettingsError("selection.seed is required when selection.strategy is 'seeded'")
        if not self.discovery_suffixes:
            raise SettingsError("discovery.suffixes must name at least one kind of recording file")
        for sfx in self.discovery_suffixes:
            if not sfx.lower().endswith(RECORDING_EXTENSIONS):
                raise SettingsError(
                    f"discovery.suffixes: {sfx!r} must end with one of {', '.join(RECORDING_EXTENSIONS)}"
                )
        if any(not p.strip() for p in self.hidden_channel_patterns):
            raise SettingsError("channels.hide must not contain empty patterns")
        for pattern, ch_type in self.channel_type_patterns:
            if not pattern.strip():
                raise SettingsError("channels.types must not contain empty patterns")
            if ch_type not in CHANNEL_TYPES:
                raise SettingsError(
                    f"channels.types: {pattern!r} is given the type {ch_type!r}; use one of {', '.join(CHANNEL_TYPES)}"
                )
        if self.min_duration_samples < 1:
            raise SettingsError("annotation.min_duration_samples must be at least 1")
        if len(self.quick_labels) > 9:
            raise SettingsError("annotation.quick_labels can name at most 9 artifact types (keys 1 to 9)")
        if len(set(self.quick_labels)) != len(self.quick_labels):
            raise SettingsError("annotation.quick_labels must not name an artifact type twice")
        if not 0 <= self.break_reminder_minutes <= 240:
            raise SettingsError("annotation.break_reminder_minutes must be between 0 (no reminders) and 240 minutes")
        if not 0 <= self.idle_pause_minutes <= 60:
            raise SettingsError("annotation.idle_pause_minutes must be between 0 (never pause by itself) and 60 "
                                "minutes")
        if self.coverage_check not in COVERAGE_CHECKS:
            raise SettingsError('annotation.coverage_check must be "warn" (list the parts not yet viewed before '
                                'Save and Finish) or "off"')
        if not 0 <= self.logging_pointer_hz <= 60:
            raise SettingsError("logging.pointer_hz must be between 0 (no pointer samples) and 60")
        if not 5 <= self.logging_idle_after_s <= 3600:
            raise SettingsError("logging.idle_after_s must be between 5 and 3600 seconds")
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
