"""Exact reading and writing of BIDS-style tab-separated files.

Values are kept as the original strings. Nothing is parsed to numbers and
re-formatted, so original event rows are reproduced byte-for-byte in exports
(apart from line endings, which are normalised to ``\\n``).
"""

from __future__ import annotations

from pathlib import Path


class TSVError(ValueError):
    """Raised for malformed TSV files or values that cannot be written safely."""


def parse_tsv_text(text: str, source: str = "<text>") -> tuple[list[str], list[list[str]]]:
    if text.startswith("﻿"):
        text = text[1:]
    # Split on line feeds only (str.splitlines would also split on form feeds,
    # Unicode separators etc. that may legitimately appear inside a value).
    lines = [ln[:-1] if ln.endswith("\r") else ln for ln in text.split("\n")]
    while lines and lines[-1].strip() == "":
        lines.pop()
    if not lines:
        raise TSVError(f"{source} is empty (no header row)")
    header = lines[0].split("\t")
    if any(h.strip() == "" for h in header):
        raise TSVError(f"{source} has an empty column name in its header")
    if len(set(header)) != len(header):
        raise TSVError(f"{source} has duplicate column names: {header}")
    rows = []
    for n, line in enumerate(lines[1:], start=2):
        cells = line.split("\t")
        if len(cells) != len(header):
            raise TSVError(
                f"{source} line {n} has {len(cells)} fields but the header has {len(header)}"
            )
        rows.append(cells)
    return header, rows


def read_tsv(path: Path | str) -> tuple[list[str], list[list[str]]]:
    p = Path(path)
    try:
        raw = p.read_bytes()
    except OSError as exc:
        raise TSVError(f"Cannot read {p}: {exc}") from exc
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")
    return parse_tsv_text(text, str(p))


def tsv_bytes(columns: list[str], rows: list[list[str]]) -> bytes:
    for name in columns:
        _check_cell(name)
    out = ["\t".join(columns)]
    for i, row in enumerate(rows):
        if len(row) != len(columns):
            raise TSVError(f"Row {i} has {len(row)} values for {len(columns)} columns")
        for cell in row:
            _check_cell(cell)
        out.append("\t".join(row))
    return ("\n".join(out) + "\n").encode("utf-8")


def _check_cell(value: str) -> None:
    if not isinstance(value, str):
        raise TSVError(f"TSV cells must be strings, got {type(value).__name__}")
    if any(ch in value for ch in "\t\n\r"):
        raise TSVError(f"TSV cell contains a tab or line break: {value!r}")


def rows_as_dicts(columns: list[str], rows: list[list[str]]) -> list[dict[str, str]]:
    return [dict(zip(columns, row)) for row in rows]
