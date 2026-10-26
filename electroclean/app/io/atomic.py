"""Crash-safe file writing helpers.

Every output file is written to a temporary file in the destination folder,
flushed and fsync'ed, then moved into place with :func:`os.replace`, which is
atomic on the same file system on Windows, macOS and Linux. A reader therefore
sees either the old file or the complete new file, never a partial one.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import uuid
from pathlib import Path
from typing import Any


class OutputWriteError(OSError):
    """Raised when an output file cannot be written safely."""


class DiskSpaceError(OutputWriteError):
    """Raised when there is not enough free disk space for the outputs."""


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path | str, chunk_size: int = 4 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            block = fh.read(chunk_size)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def fsync_directory(path: Path | str) -> None:
    """Flush directory metadata so that a rename survives power loss (POSIX only)."""
    if os.name != "posix":
        return
    try:
        fd = os.open(str(path), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def move_no_clobber(src: Path | str, dst: Path | str) -> None:
    """Move ``src`` to ``dst`` atomically, raising :class:`FileExistsError` if ``dst`` exists.

    :func:`os.replace` would silently overwrite a file that appeared in the
    meantime. On Windows :func:`os.rename` refuses to overwrite; elsewhere a
    hard link is created (which fails if the target exists) and the source
    removed. File systems without hard links fall back to checking first.
    """
    src, dst = Path(src), Path(dst)
    if os.name == "nt":
        os.rename(src, dst)
        return
    try:
        os.link(src, dst)
    except FileExistsError:
        raise
    except OSError:
        if dst.exists():
            raise FileExistsError(f"{dst} already exists") from None
        os.replace(src, dst)
        return
    os.unlink(src)


def check_free_space(directory: Path | str, required_bytes: int, margin_bytes: int = 10 * 1024 * 1024) -> None:
    """Raise :class:`DiskSpaceError` if ``directory`` lacks space for ``required_bytes``."""
    probe = Path(directory)
    while not probe.exists() and probe.parent != probe:
        probe = probe.parent
    try:
        free = shutil.disk_usage(probe).free
    except OSError as exc:  # pragma: no cover - platform dependent
        raise OutputWriteError(f"Cannot determine free disk space in {directory}: {exc}") from exc
    if free < required_bytes + margin_bytes:
        raise DiskSpaceError(
            f"Insufficient disk space in {directory}: {free / 1e6:.1f} MB free, "
            f"{(required_bytes + margin_bytes) / 1e6:.1f} MB needed"
        )


def atomic_write_bytes(path: Path | str, data: bytes, *, overwrite: bool = True) -> str:
    """Write ``data`` to ``path`` atomically and return its SHA-256 digest."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    if not overwrite and target.exists():
        raise OutputWriteError(f"Refusing to overwrite existing file {target}")
    tmp = target.with_name(f".{target.name}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        with open(tmp, "xb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        if overwrite:
            os.replace(tmp, target)
        else:
            try:
                move_no_clobber(tmp, target)
            except FileExistsError:
                raise OutputWriteError(f"Refusing to overwrite existing file {target}") from None
        fsync_directory(target.parent)
    except OutputWriteError:
        _silent_unlink(tmp)
        raise
    except OSError as exc:
        _silent_unlink(tmp)
        raise OutputWriteError(f"Could not write {target}: {exc}") from exc
    return sha256_bytes(data)


def atomic_write_text(path: Path | str, text: str, *, overwrite: bool = True) -> str:
    return atomic_write_bytes(path, text.encode("utf-8"), overwrite=overwrite)


def json_bytes(obj: Any) -> bytes:
    """Deterministic, human-readable JSON encoding used for all JSON outputs."""
    return (json.dumps(obj, indent=2, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")


def atomic_write_json(path: Path | str, obj: Any, *, overwrite: bool = True) -> str:
    return atomic_write_bytes(path, json_bytes(obj), overwrite=overwrite)


def append_line(path: Path | str, line: str) -> None:
    """Append one line and fsync (used for logs; not atomic across lines)."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    text = line if line.endswith("\n") else line + "\n"
    try:
        with open(target, "a", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
    except OSError as exc:
        raise OutputWriteError(f"Could not append to {target}: {exc}") from exc


def _silent_unlink(path: Path) -> None:
    try:
        path.unlink()
    except OSError:
        pass
