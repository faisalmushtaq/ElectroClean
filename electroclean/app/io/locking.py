"""Inter-process lock files.

Locks prevent two ElectroClean sessions (on one computer or on several
computers sharing a network drive) from annotating the same recording as the
same annotator at the same time, and serialise updates to shared registers.

A lock is a small JSON file created with ``O_CREAT | O_EXCL``, which fails if
the file already exists. The file records who holds the lock so that a lock
left behind by a crashed session can be recognised as stale: either the owning
process no longer exists on this computer, or the lock is older than a
configurable age.
"""

from __future__ import annotations

import json
import os
import socket
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class LockError(RuntimeError):
    """Raised when a lock is held by another session."""

    def __init__(self, message: str, owner: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.owner = owner or {}


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if sys.platform.startswith("win"):
        try:
            import ctypes

            kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
            handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
            if not handle:
                return False
            code = ctypes.c_ulong()
            ok = kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
            kernel32.CloseHandle(handle)
            return bool(ok) and code.value == 259  # STILL_ACTIVE
        except Exception:  # pragma: no cover - Windows only
            return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return True
    return True


@dataclass
class FileLock:
    """A lock file at ``path``. Use as a context manager or call acquire/release."""

    path: Path
    info: dict[str, Any] = field(default_factory=dict)
    stale_after_s: float | None = None
    _held: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        self.path = Path(self.path)

    @property
    def held(self) -> bool:
        return self._held

    def _owner_record(self) -> dict[str, Any]:
        return {
            "pid": os.getpid(),
            "host": socket.gethostname(),
            "created_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "created_epoch": time.time(),
            **self.info,
        }

    @staticmethod
    def read_owner(path: Path) -> dict[str, Any]:
        try:
            return json.loads(Path(path).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def is_stale(self, owner: dict[str, Any]) -> bool:
        if not owner:
            # Unreadable lock: treat as stale only once it is old enough.
            try:
                age = time.time() - self.path.stat().st_mtime
            except OSError:
                return True
            return self.stale_after_s is not None and age > self.stale_after_s
        if owner.get("host") == socket.gethostname() and not _pid_alive(int(owner.get("pid", -1))):
            return True
        created = owner.get("created_epoch")
        if self.stale_after_s is not None and isinstance(created, (int, float)):
            return (time.time() - float(created)) > self.stale_after_s
        return False

    def _try_create(self) -> bool:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            return False
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(self._owner_record(), fh)
            fh.flush()
            os.fsync(fh.fileno())
        return True

    def _break_stale(self) -> None:
        """Move a stale lock aside (rename is atomic, so only one breaker wins)."""
        aside = self.path.with_name(self.path.name + f".stale-{int(time.time() * 1000)}")
        try:
            os.replace(self.path, aside)
        except OSError:
            return
        try:
            aside.unlink()
        except OSError:
            pass

    def acquire(self, timeout_s: float = 0.0, poll_s: float = 0.1) -> FileLock:
        deadline = time.monotonic() + max(0.0, timeout_s)
        while True:
            if self._try_create():
                self._held = True
                return self
            owner = self.read_owner(self.path)
            if self.is_stale(owner):
                self._break_stale()
                continue
            if time.monotonic() >= deadline:
                who = owner.get("annotator_id") or owner.get("host") or "another session"
                since = owner.get("created_utc", "unknown time")
                raise LockError(
                    f"{self.path.name} is locked by {who} (since {since}, host "
                    f"{owner.get('host', '?')}, process {owner.get('pid', '?')})",
                    owner,
                )
            time.sleep(poll_s)

    def release(self) -> None:
        if not self._held:
            return
        try:
            owner = self.read_owner(self.path)
            if owner.get("pid") == os.getpid() and owner.get("host") == socket.gethostname():
                self.path.unlink()
        except OSError:
            pass
        finally:
            self._held = False

    def __enter__(self) -> FileLock:
        if not self._held:
            self.acquire()
        return self

    def __exit__(self, *exc: object) -> None:
        self.release()
