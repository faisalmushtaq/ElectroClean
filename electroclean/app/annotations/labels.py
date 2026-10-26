"""The permitted artifact label catalogue.

The catalogue is loaded from ``electroclean/config/artifact_labels.json`` and is
the single source of truth for label strings and their numerical codes. Every
output file records the catalogue identifier, version and a SHA-256 digest of
its labels and codes so that analyses can confirm that all annotators used the
same categories.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from electroclean.config.settings import CONFIG_DIR

DEFAULT_CATALOGUE_PATH = CONFIG_DIR / "artifact_labels.json"


class LabelError(ValueError):
    """Raised for labels that are not part of the permitted catalogue."""


@dataclass(frozen=True)
class ArtifactLabel:
    value: int
    label: str
    short_code: str
    colour: str


@dataclass(frozen=True)
class LabelCatalogue:
    catalogue_id: str
    catalogue_version: str
    hed_library: str
    hed_library_version: str
    hed_standard_version: str
    hed_namespace_prefix: str
    labels: tuple[ArtifactLabel, ...]
    source_path: str = ""

    # ------------------------------------------------------------------ lookups
    @property
    def label_names(self) -> tuple[str, ...]:
        return tuple(item.label for item in self.labels)

    @property
    def values(self) -> tuple[int, ...]:
        return tuple(item.value for item in self.labels)

    def get(self, label: str) -> ArtifactLabel:
        for item in self.labels:
            if item.label == label:
                return item
        raise LabelError(
            f"{label!r} is not a permitted artifact label. Only the {len(self.labels)} "
            f"labels of catalogue {self.catalogue_id} {self.catalogue_version} may be used."
        )

    def is_permitted(self, label: str) -> bool:
        return any(item.label == label for item in self.labels)

    def value_for(self, label: str) -> int:
        return self.get(label).value

    def label_for(self, value: int) -> str:
        for item in self.labels:
            if item.value == int(value):
                return item.label
        raise LabelError(f"{value!r} is not a permitted artifact code")

    def colour_for(self, label: str) -> str:
        return self.get(label).colour

    # --------------------------------------------------------------- integrity
    @property
    def sha256(self) -> str:
        """Digest of the identity, version and (value, label) pairs.

        Colours and short codes are presentation only and are excluded, so a
        colour change does not make annotation files incompatible.
        """
        payload = {
            "catalogue_id": self.catalogue_id,
            "catalogue_version": self.catalogue_version,
            "labels": [[item.value, item.label] for item in self.labels],
        }
        blob = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()

    def to_metadata(self) -> dict[str, Any]:
        """Description embedded in every output file."""
        return {
            "catalogue_id": self.catalogue_id,
            "catalogue_version": self.catalogue_version,
            "sha256": self.sha256,
            "hed_library": self.hed_library,
            "hed_library_version": self.hed_library_version,
            "hed_standard_version": self.hed_standard_version,
            "labels": [{"value": item.value, "label": item.label} for item in self.labels],
        }

    def hed_tag(self, label: str) -> str:
        """HED string for a label, e.g. ``sc:Eye-blink-artifact``."""
        self.get(label)
        return f"{self.hed_namespace_prefix}{label}"

    def validate(self) -> None:
        names = [item.label for item in self.labels]
        values = [item.value for item in self.labels]
        if len(set(names)) != len(names):
            raise LabelError("Duplicate label strings in the catalogue")
        if len(set(values)) != len(values):
            raise LabelError("Duplicate numerical codes in the catalogue")
        for item in self.labels:
            if not item.label or item.label != item.label.strip():
                raise LabelError(f"Invalid label string {item.label!r}")
            if any(ch in item.label for ch in "\t\n\r,|\"'"):
                raise LabelError(f"Label {item.label!r} contains a reserved character")
            if not isinstance(item.value, int) or isinstance(item.value, bool):
                raise LabelError(f"Code for {item.label!r} must be an integer")

    @classmethod
    def from_dict(cls, data: dict[str, Any], source_path: str = "") -> LabelCatalogue:
        labels = tuple(
            ArtifactLabel(
                value=int(entry["value"]),
                label=str(entry["label"]),
                short_code=str(entry.get("short_code", "")),
                colour=str(entry.get("colour", "#808080")),
            )
            for entry in data["labels"]
        )
        cat = cls(
            catalogue_id=str(data["catalogue_id"]),
            catalogue_version=str(data["catalogue_version"]),
            hed_library=str(data.get("hed_library", "")),
            hed_library_version=str(data.get("hed_library_version", "")),
            hed_standard_version=str(data.get("hed_standard_version", "")),
            hed_namespace_prefix=str(data.get("hed_namespace_prefix", "sc:")),
            labels=labels,
            source_path=source_path,
        )
        cat.validate()
        return cat

    @classmethod
    def load(cls, path: Path | str | None = None) -> LabelCatalogue:
        p = Path(path) if path is not None else DEFAULT_CATALOGUE_PATH
        data = json.loads(p.read_text(encoding="utf-8"))
        return cls.from_dict(data, source_path=str(p))


@lru_cache(maxsize=1)
def default_catalogue() -> LabelCatalogue:
    """The catalogue shipped with the application (cached)."""
    return LabelCatalogue.load(DEFAULT_CATALOGUE_PATH)
