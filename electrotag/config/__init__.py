"""Version-controlled configuration for ElectroTag."""

from __future__ import annotations

from electrotag.config.settings import (
    CONFIG_DIR,
    STUDY_CONFIG_FILENAME,
    FilterSettings,
    Settings,
    SettingsError,
    StudyConfig,
    load_settings,
)

__all__ = [
    "CONFIG_DIR",
    "STUDY_CONFIG_FILENAME",
    "FilterSettings",
    "Settings",
    "SettingsError",
    "StudyConfig",
    "load_settings",
]
