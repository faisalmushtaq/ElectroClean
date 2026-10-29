"""A study on the web server: one folder that holds everything the server keeps.

::

    STUDY_DIR/
        electrotag_study.json          the study's settings (the desktop application's study file)
        server.sqlite                    accounts, sign-in tokens, assignments, visits, guided and quiz
                                         progress, the audit log (see accounts.py)
        manifests/<key>.json             one per registered recording (see manifest.py)
        drafts/annotator-<ID>/<key>.json unfinished work sent by the browser
        derivatives/electrotag_reference_sets/<set>/   training reference sets (never sent out)
        Annotated_Events/                the results, laid out exactly as by the desktop application

Settings are read with the desktop application's own machinery (defaults, then the study file),
so a study folder can be opened by ``electrotag-agreement``, ``electrotag-activity`` and
``electrotag-admin`` as it is.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from electrotag.app.io.atomic import atomic_write_json
from electrotag.app.io.naming import OutputLayout
from electrotag.config.settings import STUDY_CONFIG_FILENAME, Settings, StudyConfig, load_settings
from electrotag.training.reference import ReferenceSet, find_reference_sets, reference_sets_dir
from electrotag.web.manifest import ManifestStore

STUDY_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


class StudyError(ValueError):
    """A problem with the study folder, reported to the administrator without a traceback."""


@dataclass
class WebStudy:
    """The study folder of a server (see the module docstring)."""

    root: Path

    def __post_init__(self) -> None:
        self.root = Path(self.root).resolve()
        self.manifests = ManifestStore(self.root / "manifests")
        self._settings_key: tuple[float, int] | None = None
        self._settings: Settings | None = None
        self._config: StudyConfig | None = None

    # ------------------------------------------------------------ creation
    @classmethod
    def init(cls, root: Path | str, *, study_id: str, name: str = "", settings: dict[str, Any] | None = None,
             exist_ok: bool = False) -> WebStudy:
        """Create a study folder (``electrotag-web init``)."""
        root = Path(root)
        if not STUDY_ID_RE.match(study_id or ""):
            raise StudyError("The study ID must be 1 to 64 letters, digits, dots, hyphens or underscores")
        path = root / STUDY_CONFIG_FILENAME
        if path.exists() and not exist_ok:
            raise StudyError(f"{root} already holds a study ({STUDY_CONFIG_FILENAME}); choose another folder")
        root.mkdir(parents=True, exist_ok=True)
        data: dict[str, Any] = {"study_id": study_id, "name": name or study_id, "settings": dict(settings or {})}
        if path.exists():
            old = json.loads(path.read_text(encoding="utf-8-sig"))
            data = {**old, **{k: v for k, v in data.items() if v}}
        atomic_write_json(path, data)
        study = cls(root)
        _ = study.settings  # validate now, so a mistake shows at once
        for sub in ("manifests", "drafts"):
            (study.root / sub).mkdir(exist_ok=True)
        study.layout.root.mkdir(parents=True, exist_ok=True)
        return study

    @classmethod
    def open(cls, root: Path | str) -> WebStudy:
        root = Path(root)
        if not (root / STUDY_CONFIG_FILENAME).is_file():
            raise StudyError(f"{root} is not a study folder (no {STUDY_CONFIG_FILENAME}); "
                             "create one with 'electrotag-web init'")
        study = cls(root)
        _ = study.settings  # a mistake in the settings shows at once
        return study

    # ------------------------------------------------------------ settings
    @property
    def config_path(self) -> Path:
        return self.root / STUDY_CONFIG_FILENAME

    def _load(self) -> None:
        try:
            st = self.config_path.stat()
            key = (st.st_mtime, st.st_size)
        except OSError:
            key = (0.0, 0)
        if self._settings is None or key != self._settings_key:
            try:
                self._settings, self._config = load_settings(self.root)
            except (ValueError, OSError) as exc:
                raise StudyError(f"The study settings in {self.config_path} are not valid: {exc}") from exc
            self._settings_key = key

    @property
    def settings(self) -> Settings:
        self._load()
        assert self._settings is not None
        return self._settings

    @property
    def config(self) -> StudyConfig | None:
        self._load()
        return self._config

    @property
    def raw_config(self) -> dict[str, Any]:
        try:
            return json.loads(self.config_path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError):
            return {}

    @property
    def study_id(self) -> str:
        return (self.config.study_id if self.config else "") or self.root.name

    @property
    def name(self) -> str:
        return str(self.raw_config.get("name") or self.study_id)

    def update(self, *, name: str | None = None, overrides: dict[str, Any] | None = None,
               logging_notice: str | None = None) -> None:
        """Change the study's name, its settings (the ``settings`` block) or its logging notice.

        The new study file is read with the desktop application's own machinery before it replaces the
        old one, so settings it would refuse are never saved (:class:`StudyError` with the reason)."""
        import tempfile

        data = self.raw_config
        if name is not None:
            data["name"] = name
        if overrides is not None:
            data["settings"] = overrides
        if logging_notice is not None:
            data["logging_notice"] = logging_notice
        with tempfile.TemporaryDirectory(prefix="electrotag-study-") as tmp:
            atomic_write_json(Path(tmp) / STUDY_CONFIG_FILENAME, data)
            try:
                load_settings(Path(tmp))
            except (ValueError, TypeError, KeyError, AttributeError) as exc:
                raise StudyError(str(exc)) from exc
        atomic_write_json(self.config_path, data)
        self._settings = None

    # --------------------------------------------------------------- paths
    @property
    def db_path(self) -> Path:
        return self.root / "server.sqlite"

    @property
    def drafts_dir(self) -> Path:
        return self.root / "drafts"

    @property
    def layout(self) -> OutputLayout:
        """Where results go: the study's ``output.directory`` if set, else ``<study>/Annotated_Events``."""
        s = self.settings
        if s.output_directory:
            p = Path(s.output_directory)
            return OutputLayout(p if p.is_absolute() else self.root / p)
        return OutputLayout(self.root / s.output_directory_name)

    @property
    def reference_sets_dir(self) -> Path:
        return reference_sets_dir(self.root, self.config)

    # -------------------------------------------------------- reference sets
    def reference_sets(self) -> list[ReferenceSet]:
        return find_reference_sets(self.reference_sets_dir)
