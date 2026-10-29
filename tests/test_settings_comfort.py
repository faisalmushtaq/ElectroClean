"""The annotation settings for long sessions: break reminders, the pause after a while without
input, and the check of the parts of a recording not yet viewed before Save and Finish."""

from __future__ import annotations

from typing import Any

import pytest

from electrotag.config.settings import Settings, SettingsError, load_default_settings_dict


def _with(**annotation: Any) -> Settings:
    data = load_default_settings_dict()
    data["annotation"].update(annotation)
    return Settings.from_dict(data)


def test_the_defaults() -> None:
    s = Settings.from_dict(load_default_settings_dict())
    assert s.break_reminder_minutes == 50.0
    assert s.idle_pause_minutes == 3.0
    assert s.coverage_check == "warn"


def test_a_study_file_written_before_these_settings_takes_the_defaults() -> None:
    data = load_default_settings_dict()
    for k in ("break_reminder_minutes", "idle_pause_minutes", "coverage_check"):
        del data["annotation"][k]
    s = Settings.from_dict(data)
    assert (s.break_reminder_minutes, s.idle_pause_minutes, s.coverage_check) == (50.0, 3.0, "warn")


def test_zero_turns_reminders_and_pauses_off_and_the_check_can_be_off() -> None:
    s = _with(break_reminder_minutes=0, idle_pause_minutes=0, coverage_check="off")
    assert (s.break_reminder_minutes, s.idle_pause_minutes, s.coverage_check) == (0.0, 0.0, "off")
    s = _with(break_reminder_minutes=240, idle_pause_minutes=60, coverage_check="warn")
    assert (s.break_reminder_minutes, s.idle_pause_minutes) == (240.0, 60.0)
    assert _with(idle_pause_minutes=1.5).idle_pause_minutes == 1.5


@pytest.mark.parametrize("annotation, words", [
    ({"break_reminder_minutes": 241}, "break_reminder_minutes must be between 0 (no reminders) and 240"),
    ({"break_reminder_minutes": -1}, "between 0"),
    ({"break_reminder_minutes": "often"}, "must be a number of minutes, not 'often'"),
    ({"break_reminder_minutes": True}, "must be a number of minutes"),
    ({"break_reminder_minutes": None}, "must be a number of minutes"),
    ({"idle_pause_minutes": 61}, "idle_pause_minutes must be between 0 (never pause by itself) and 60"),
    ({"idle_pause_minutes": float("nan")}, "must be a number of minutes"),
    ({"coverage_check": "block"}, 'coverage_check must be "warn"'),
    ({"coverage_check": False}, 'coverage_check must be "warn"'),
])
def test_the_settings_are_checked_in_plain_words(annotation: dict[str, Any], words: str) -> None:
    with pytest.raises(SettingsError) as exc:
        _with(**annotation)
    assert words in str(exc.value)
