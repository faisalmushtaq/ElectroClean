"""Inter-process lock files.

Locks prevent two ElectroTag sessions (on one computer or on several
computers sharing a network drive) from annotating the same recording as the
same annotator at the same time, and serialise updates to shared registers.

A lock is a small JSON file created with ``O_CREAT | O_EXCL``, which fails if
the file already exists. The file records who holds the lock, with a random
token, so that a lock left behind by a crashed session can be recognised as
stale: either the owning process no longer exists on this computer, or the
lock has not been refreshed for a configurable time. Ages are measured with
the clock of the folder that holds the lock (the modification time of a probe
file written next to it), so computers whose clocks disagree do not misjudge
each other's locks. Long-held locks are refreshed with :meth:`FileLock.refresh`.

Breaking a stale lock is serialised by a short-lived ``<lock>.breaking`` file,
and the breaker re-reads the lock under it and only removes the very lock it
judged stale, so two sessions never both end up holding the lock.
"""

from __future__ import annotations

import json
import os
import socket
import sys
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from electrotag.app.io.atomic import move_no_clobber


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

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
            handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
            if not handle:
                # ERROR_ACCESS_DENIED: the process exists but belongs to another user.
                return ctypes.get_last_error() == 5
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


def filesystem_now(directory: Path) -> float:
    """The current time according to the file system holding ``directory``.

    A probe file is created and its modification time read, so that ages of
    lock files are judged with the same clock that stamped them. Falls back to
    the local clock if the probe cannot be written.
    """
    probe = Path(directory) / f".clock-{os.getpid()}-{uuid.uuid4().hex[:12]}"
    try:
        fd = os.open(str(probe), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        os.close(fd)
        try:
            return probe.stat().st_mtime
        finally:
            probe.unlink()
    except OSError:
        return time.time()


@dataclass
class FileLock:
    """A lock file at ``path``. Use as a context manager or call acquire/release."""

    path: Path
    info: dict[str, Any] = field(default_factory=dict)
    stale_after_s: float | None = None
    _held: bool = field(default=False, init=False)
    _token: str = field(default="", init=False)

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
            "token": self._token,
            **self.info,
        }

    @staticmethod
    def read_owner(path: Path) -> dict[str, Any]:
        try:
            return json.loads(Path(path).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _age_s(self) -> float | None:
        """Seconds since the lock file was created or last refreshed (file-system clock)."""
        try:
            mtime = self.path.stat().st_mtime
        except OSError:
            return None
        return filesystem_now(self.path.parent) - mtime

    def is_stale(self, owner: dict[str, Any]) -> bool:
        if not owner:
            # Unreadable lock (for example still being written): stale only once it is old enough.
            age = self._age_s()
            if age is None:
                return True
            return self.stale_after_s is not None and age > self.stale_after_s
        if owner.get("host") == socket.gethostname() and not _pid_alive(int(owner.get("pid", -1))):
            return True
        if self.stale_after_s is None:
            return False
        age = self._age_s()
        return age is not None and age > self.stale_after_s

    def _try_create(self) -> bool:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            return False
        self._token = uuid.uuid4().hex
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(self._owner_record(), fh)
            fh.flush()
            os.fsync(fh.fileno())
        return True

    @staticmethod
    def _same_owner(a: dict[str, Any], b: dict[str, Any]) -> bool:
        if a.get("token") or b.get("token"):
            return a.get("token") == b.get("token")
        return a == b

    def _break_stale(self, judged: dict[str, Any]) -> None:
        """Remove the stale lock ``judged``, and nothing else.

        Only one session at a time may break a lock (``<lock>.breaking``). Under
        it the lock is read again: if it is no longer the one judged stale (for
        example another session has just broken it and taken a new lock), it is
        left alone.
        """
        breaker = self.path.with_name(self.path.name + ".breaking")
        try:
            fd = os.open(str(breaker), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
            os.close(fd)
        except FileExistsError:
            # Another session is breaking it. Remove a breaker left by a crash after a minute.
            try:
                if filesystem_now(breaker.parent) - breaker.stat().st_mtime > 60:
                    breaker.unlink()
            except OSError:
                pass
            return
        except OSError:
            return
        try:
            current = self.read_owner(self.path)
            if not self._same_owner(current, judged):
                return
            aside = self.path.with_name(self.path.name + f".stale-{uuid.uuid4().hex[:12]}")
            try:
                os.replace(self.path, aside)
            except OSError:
                return
            moved = self.read_owner(aside)
            if not self._same_owner(moved, judged):
                # The lock changed between reading and moving it: put the new one back.
                try:
                    move_no_clobber(aside, self.path)
                except OSError:
                    pass
                return
            try:
                aside.unlink()
            except OSError:
                pass
        finally:
            try:
                breaker.unlink()
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
                self._break_stale(owner)
                if self._try_create():
                    self._held = True
                    return self
                owner = self.read_owner(self.path)  # whoever holds it now
            if time.monotonic() >= deadline:
                who = owner.get("annotator_id") or owner.get("host") or "another session"
                since = owner.get("created_utc", "unknown time")
                raise LockError(
                    f"{self.path.name} is locked by {who} (since {since}, host "
                    f"{owner.get('host', '?')}, process {owner.get('pid', '?')})",
                    owner,
                )
            time.sleep(poll_s)

    def owns(self) -> bool:
        """True while the lock file on disk is still this lock's."""
        return self._held and self.read_owner(self.path).get("token") == self._token

    def refresh(self) -> bool:
        """Show that the holder is alive (updates the lock's modification time).

        Returns False if the lock is no longer this session's (it was judged
        stale and broken, for example after the computer slept for a long time).
        """
        if not self.owns():
            return False
        try:
            os.utime(self.path, None)
        except OSError:
            return False
        return True

    def release(self) -> None:
        if not self._held:
            return
        try:
            if self.read_owner(self.path).get("token") == self._token:
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
