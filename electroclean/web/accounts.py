"""The files store's database: accounts, sign-in tokens, assignments, visits and guided progress.

One SQLite file in the study folder (``server.sqlite``), used by the ElectroClean server
(:mod:`electroclean.web.store_files`); on Firebase, accounts are Firebase Authentication users and
the rest are Firestore documents.

Passwords are kept only as scrypt hashes (``hashlib.scrypt``, a random salt per password) and
sign-in tokens only as SHA-256 hashes, so a copy of the database gives nobody a way in. A token
expires after 12 hours without use and when its owner signs out.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
import sqlite3
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from electroclean.app.common import now_local_iso
from electroclean.web.store import MODES, ROLES, Assignment, User

TOKEN_IDLE_S = 12 * 3600
ID_RE = re.compile(r"^[A-Z0-9][A-Z0-9_-]{0,31}$")
MIN_PASSWORD = 8
#: scrypt cost: 2^14 x 8 x 1 needs 16 MiB and about 50 ms, a sensible default for a small server.
SCRYPT_N, SCRYPT_R, SCRYPT_P = 2**14, 8, 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    annotator_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'annotator',
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen TEXT NOT NULL DEFAULT '',
    disabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tokens (
    token_hash TEXT PRIMARY KEY,
    annotator_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS assignments (
    annotator_id TEXT NOT NULL,
    recording_id TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'standard',
    context_id TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (annotator_id, recording_id, mode, context_id)
);
CREATE TABLE IF NOT EXISTS programmes (
    annotator_id TEXT PRIMARY KEY,
    set_id TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS visits (
    visit_id TEXT PRIMARY KEY,
    annotator_id TEXT NOT NULL,
    path TEXT NOT NULL,
    mode TEXT NOT NULL,
    context_id TEXT NOT NULL DEFAULT '',
    opened_at TEXT NOT NULL,
    opened_mono REAL NOT NULL,
    last_t REAL NOT NULL DEFAULT 0,
    seq INTEGER NOT NULL DEFAULT 0,
    closed_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS guided_state (
    annotator_id TEXT NOT NULL,
    set_id TEXT NOT NULL,
    recording_id TEXT NOT NULL,
    state TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (annotator_id, set_id, recording_id)
);
CREATE TABLE IF NOT EXISTS quiz_state (
    annotator_id TEXT NOT NULL,
    set_id TEXT NOT NULL,
    state TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (annotator_id, set_id)
);
CREATE TABLE IF NOT EXISTS audit (
    entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    by TEXT NOT NULL,
    op TEXT NOT NULL,
    summary TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '{}'
);
"""
#: Columns added to the users table after the first version of the server (added to older databases).
USER_COLUMNS = {"email": "TEXT NOT NULL DEFAULT ''", "notes": "TEXT NOT NULL DEFAULT ''"}


class AccountError(ValueError):
    """A mistake in an account command (shown to the administrator)."""


class AccountExists(AccountError):
    """The ID already has an account."""


# ------------------------------------------------------------------ passwords
def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=32)
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt, digest = stored.split("$")
        if algo != "scrypt":
            return False
        mine = hashlib.scrypt(password.encode("utf-8"), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p),
                              dklen=len(bytes.fromhex(digest)), maxmem=256 * 1024 * 1024)
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(mine.hex(), digest)


#: Checked against when an unknown ID signs in, so the answer takes as long as for a known one.
_DUMMY_HASH = hash_password(secrets.token_hex(8))


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def normalise_id(value: str) -> str:
    aid = str(value or "").strip().upper()
    if not ID_RE.match(aid):
        raise AccountError("An ID must be 1 to 32 letters, digits, hyphens or underscores, starting with a letter "
                           "or digit (for example A01)")
    return aid


class Accounts:
    """The server's database (one file, safe to use from several threads)."""

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._db = sqlite3.connect(str(self.path), check_same_thread=False, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        with self._lock:
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.execute("PRAGMA busy_timeout=5000")
            self._db.executescript(SCHEMA)
            have = {r[1] for r in self._db.execute("PRAGMA table_info(users)").fetchall()}
            for name, decl in USER_COLUMNS.items():
                if name not in have:
                    self._db.execute(f"ALTER TABLE users ADD COLUMN {name} {decl}")

    def close(self) -> None:
        with self._lock:
            self._db.close()

    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                yield self._db
            except BaseException:
                self._db.execute("ROLLBACK")
                raise
            self._db.execute("COMMIT")

    def _all(self, sql: str, args: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
        with self._lock:
            return list(self._db.execute(sql, args).fetchall())

    def _one(self, sql: str, args: tuple[Any, ...] = ()) -> sqlite3.Row | None:
        with self._lock:
            return self._db.execute(sql, args).fetchone()

    # ---------------------------------------------------------------- users
    def add_user(self, annotator_id: str, password: str, *, display_name: str = "", role: str = "annotator",
                 replace: bool = False) -> User:
        aid = normalise_id(annotator_id)
        if role not in ROLES:
            raise AccountError(f"The role must be one of {', '.join(ROLES)}")
        if len(password) < MIN_PASSWORD:
            raise AccountError(f"The password must have at least {MIN_PASSWORD} characters")
        h = hash_password(password)
        with self._tx() as db:
            exists = db.execute("SELECT 1 FROM users WHERE annotator_id=?", (aid,)).fetchone()
            if exists and not replace:
                raise AccountExists(f"{aid} already has an account (use --replace to set a new password)")
            if exists:
                db.execute("UPDATE users SET display_name=?, role=?, password_hash=?, disabled=0 WHERE annotator_id=?",
                           (display_name, role, h, aid))
                db.execute("DELETE FROM tokens WHERE annotator_id=?", (aid,))
            else:
                db.execute("INSERT INTO users (annotator_id, display_name, role, password_hash, created_at) "
                           "VALUES (?, ?, ?, ?, ?)", (aid, display_name, role, h, now_local_iso()))
        return User(aid, display_name, role)

    def remove_user(self, annotator_id: str) -> None:
        aid = normalise_id(annotator_id)
        with self._tx() as db:
            db.execute("UPDATE users SET disabled=1 WHERE annotator_id=?", (aid,))
            db.execute("DELETE FROM tokens WHERE annotator_id=?", (aid,))

    def user(self, annotator_id: str) -> User | None:
        row = self._one("SELECT * FROM users WHERE annotator_id=? AND disabled=0", (str(annotator_id).upper(),))
        return User(row["annotator_id"], row["display_name"], row["role"]) if row else None

    def users(self) -> list[dict[str, Any]]:
        return [dict(annotator_id=r["annotator_id"], display_name=r["display_name"], role=r["role"],
                     created_at=r["created_at"], last_seen=r["last_seen"])
                for r in self._all("SELECT * FROM users WHERE disabled=0 ORDER BY annotator_id")]

    def user_records(self) -> list[dict[str, Any]]:
        """Every account, disabled ones too (without the password hash)."""
        return [{"annotator_id": r["annotator_id"], "display_name": r["display_name"], "email": r["email"] or None,
                 "role": r["role"], "status": "disabled" if r["disabled"] else "active", "created_at": r["created_at"],
                 "last_seen": r["last_seen"] or None, "notes": r["notes"]}
                for r in self._all("SELECT * FROM users ORDER BY annotator_id")]

    def update_user(self, annotator_id: str, *, display_name: str | None = None, role: str | None = None,
                    disabled: bool | None = None, notes: str | None = None, email: str | None = None) -> None:
        aid = normalise_id(annotator_id)
        if role is not None and role not in ROLES:
            raise AccountError(f"The role must be one of {', '.join(ROLES)}")
        changes: dict[str, Any] = {k: v for k, v in (("display_name", display_name), ("role", role),
                                                      ("notes", notes), ("email", email)) if v is not None}
        if disabled is not None:
            changes["disabled"] = 1 if disabled else 0
        with self._tx() as db:
            if not db.execute("SELECT 1 FROM users WHERE annotator_id=?", (aid,)).fetchone():
                raise AccountError(f"{aid} has no account")
            for key, value in changes.items():  # the keys are the fixed column names above
                db.execute(f"UPDATE users SET {key}=? WHERE annotator_id=?", (value, aid))
            if disabled:
                db.execute("DELETE FROM tokens WHERE annotator_id=?", (aid,))

    def set_password(self, annotator_id: str, password: str) -> None:
        """A new password; every sign-in of the account ends."""
        aid = normalise_id(annotator_id)
        if len(password) < MIN_PASSWORD:
            raise AccountError(f"The password must have at least {MIN_PASSWORD} characters")
        h = hash_password(password)
        with self._tx() as db:
            if not db.execute("UPDATE users SET password_hash=? WHERE annotator_id=?", (h, aid)).rowcount:
                raise AccountError(f"{aid} has no account")
            db.execute("DELETE FROM tokens WHERE annotator_id=?", (aid,))

    def delete_user(self, annotator_id: str) -> None:
        """The account, its sign-ins, assignments, programme, guided progress and quiz state."""
        aid = normalise_id(annotator_id)
        with self._tx() as db:
            for table in ("users", "tokens", "assignments", "programmes", "guided_state", "quiz_state"):
                db.execute(f"DELETE FROM {table} WHERE annotator_id=?", (aid,))

    def authenticate(self, annotator_id: str, password: str) -> User | None:
        aid = str(annotator_id or "").strip().upper()
        row = self._one("SELECT * FROM users WHERE annotator_id=? AND disabled=0", (aid,)) if ID_RE.match(aid) else None
        if row is None:
            verify_password(password, _DUMMY_HASH)
            return None
        if not verify_password(password, row["password_hash"]):
            return None
        return User(row["annotator_id"], row["display_name"], row["role"])

    # --------------------------------------------------------------- tokens
    def issue_token(self, user: User) -> str:
        token = secrets.token_urlsafe(32)
        now = time.time()
        with self._tx() as db:
            db.execute("DELETE FROM tokens WHERE last_used < ?", (now - TOKEN_IDLE_S,))
            db.execute("INSERT INTO tokens (token_hash, annotator_id, created_at, last_used) VALUES (?, ?, ?, ?)",
                       (token_hash(token), user.annotator_id, now_local_iso(), now))
            db.execute("UPDATE users SET last_seen=? WHERE annotator_id=?", (now_local_iso(), user.annotator_id))
        return token

    def user_for_token(self, token: str) -> User | None:
        """The token's owner, or None if the token is unknown or has expired (each use extends it)."""
        if not token or len(token) > 200:
            return None
        h = token_hash(token)
        now = time.time()
        row = self._one("SELECT t.last_used, u.* FROM tokens t JOIN users u ON u.annotator_id = t.annotator_id "
                        "WHERE t.token_hash=? AND u.disabled=0", (h,))
        if row is None:
            return None
        if now - float(row["last_used"]) > TOKEN_IDLE_S:
            self.revoke_token(token)
            return None
        if now - float(row["last_used"]) > 30:  # refresh at most every 30 s
            with self._tx() as db:
                db.execute("UPDATE tokens SET last_used=? WHERE token_hash=?", (now, h))
                db.execute("UPDATE users SET last_seen=? WHERE annotator_id=?", (now_local_iso(), row["annotator_id"]))
        return User(row["annotator_id"], row["display_name"], row["role"])

    def revoke_token(self, token: str) -> None:
        with self._tx() as db:
            db.execute("DELETE FROM tokens WHERE token_hash=?", (token_hash(token),))

    # ---------------------------------------------------------- assignments
    def assign(self, annotator_id: str, recording_ids: list[str], *, mode: str = "standard",
               context_id: str = "") -> int:
        aid = normalise_id(annotator_id)
        if mode not in MODES:
            raise AccountError(f"The mode must be one of {', '.join(MODES)}")
        if mode != "standard" and not context_id:
            raise AccountError("Training assignments need a reference set (--set)")
        with self._tx() as db:
            start = db.execute("SELECT COALESCE(MAX(position), 0) FROM assignments WHERE annotator_id=?",
                               (aid,)).fetchone()[0]
            n = 0
            for i, rid in enumerate(recording_ids, start=1):
                cur = db.execute("INSERT OR IGNORE INTO assignments (annotator_id, recording_id, mode, context_id, "
                                 "position, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                                 (aid, rid, mode, context_id if mode != "standard" else "", start + i, now_local_iso()))
                n += cur.rowcount
        return n

    def unassign(self, annotator_id: str, recording_ids: list[str] | None = None) -> int:
        aid = normalise_id(annotator_id)
        with self._tx() as db:
            if recording_ids is None:
                return db.execute("DELETE FROM assignments WHERE annotator_id=?", (aid,)).rowcount
            return sum(db.execute("DELETE FROM assignments WHERE annotator_id=? AND recording_id=?",
                                  (aid, rid)).rowcount for rid in recording_ids)

    def unassign_item(self, annotator_id: str, recording_id: str, mode: str, context_id: str) -> bool:
        with self._tx() as db:
            return bool(db.execute("DELETE FROM assignments WHERE annotator_id=? AND recording_id=? AND mode=? AND "
                                   "context_id=?", (str(annotator_id).upper(), recording_id, mode,
                                                    context_id if mode != "standard" else "")).rowcount)

    def remove_assignments(self, *, recording_id: str | None = None, context_id: str | None = None,
                           modes: tuple[str, ...] | None = None) -> int:
        """Remove the assignments of a recording or of a reference set (in the given modes)."""
        where: list[str] = []
        args: list[Any] = []
        if recording_id is not None:
            where.append("recording_id=?")
            args.append(recording_id)
        if context_id is not None:
            where.append("context_id=?")
            args.append(context_id)
        if modes is not None:
            where.append("mode IN (" + ",".join("?" * len(modes)) + ")")
            args.extend(modes)
        if not where:
            return 0
        with self._tx() as db:
            return db.execute("DELETE FROM assignments WHERE " + " AND ".join(where), tuple(args)).rowcount

    def assignments(self, annotator_id: str | None = None) -> list[Assignment]:
        if annotator_id is None:
            rows = self._all("SELECT * FROM assignments ORDER BY annotator_id, position")
        else:
            rows = self._all("SELECT * FROM assignments WHERE annotator_id=? ORDER BY position",
                             (str(annotator_id).upper(),))
        return [Assignment(r["annotator_id"], r["recording_id"], r["mode"], r["context_id"], r["position"])
                for r in rows]

    # ----------------------------------------------------------- programmes
    def enrol(self, annotator_id: str, set_id: str) -> None:
        aid = normalise_id(annotator_id)
        with self._tx() as db:
            db.execute("INSERT OR REPLACE INTO programmes (annotator_id, set_id, created_at) VALUES (?, ?, ?)",
                       (aid, set_id, now_local_iso()))

    def unenrol(self, annotator_id: str) -> None:
        with self._tx() as db:
            db.execute("DELETE FROM programmes WHERE annotator_id=?", (normalise_id(annotator_id),))

    def programme(self, annotator_id: str) -> str | None:
        row = self._one("SELECT set_id FROM programmes WHERE annotator_id=?", (str(annotator_id).upper(),))
        return row["set_id"] if row else None

    # --------------------------------------------------------------- visits
    def open_visit(self, visit_id: str, annotator_id: str, path: Path, mode: str, context_id: str) -> None:
        with self._tx() as db:
            db.execute("INSERT INTO visits (visit_id, annotator_id, path, mode, context_id, opened_at, opened_mono) "
                       "VALUES (?, ?, ?, ?, ?, ?, ?)",
                       (visit_id, annotator_id, str(path), mode, context_id, now_local_iso(), time.monotonic()))

    def visit(self, visit_id: str) -> dict[str, Any] | None:
        row = self._one("SELECT * FROM visits WHERE visit_id=?", (visit_id,))
        return dict(row) if row else None

    def advance_visit(self, visit_id: str, n_events: int, last_t: float) -> int:
        """Reserve ``n_events`` sequence numbers; returns the first."""
        with self._tx() as db:
            row = db.execute("SELECT seq, last_t FROM visits WHERE visit_id=?", (visit_id,)).fetchone()
            first = int(row["seq"]) + 1
            db.execute("UPDATE visits SET seq=?, last_t=? WHERE visit_id=?",
                       (int(row["seq"]) + n_events, max(float(row["last_t"]), last_t), visit_id))
        return first

    def close_visit(self, visit_id: str) -> None:
        with self._tx() as db:
            db.execute("UPDATE visits SET closed_at=? WHERE visit_id=?", (now_local_iso(), visit_id))

    def visit_rows(self, annotator_id: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        if annotator_id is None:
            rows = self._all("SELECT * FROM visits ORDER BY opened_at DESC, visit_id LIMIT ?", (int(limit),))
        else:
            rows = self._all("SELECT * FROM visits WHERE annotator_id=? ORDER BY opened_at DESC, visit_id LIMIT ?",
                             (str(annotator_id).upper(), int(limit)))
        return [dict(r) for r in rows]

    def open_visits(self, annotator_id: str) -> list[dict[str, Any]]:
        return [dict(r) for r in self._all("SELECT * FROM visits WHERE annotator_id=? AND closed_at='' "
                                           "ORDER BY opened_at", (annotator_id,))]

    def last_visit(self, annotator_id: str) -> dict[str, Any] | None:
        row = self._one("SELECT * FROM visits WHERE annotator_id=? ORDER BY opened_at DESC LIMIT 1", (annotator_id,))
        return dict(row) if row else None

    # --------------------------------------------------------- guided state
    def guided_state(self, annotator_id: str, set_id: str, recording_id: str) -> dict[str, Any] | None:
        row = self._one("SELECT state FROM guided_state WHERE annotator_id=? AND set_id=? AND recording_id=?",
                        (annotator_id, set_id, recording_id))
        return json.loads(row["state"]) if row else None

    def save_guided_state(self, annotator_id: str, set_id: str, recording_id: str, state: dict[str, Any]) -> None:
        with self._tx() as db:
            db.execute("INSERT OR REPLACE INTO guided_state (annotator_id, set_id, recording_id, state, updated_at) "
                       "VALUES (?, ?, ?, ?, ?)",
                       (annotator_id, set_id, recording_id, json.dumps(state), now_local_iso()))

    def clear_guided_state(self, annotator_id: str, set_id: str, recording_id: str) -> None:
        with self._tx() as db:
            db.execute("DELETE FROM guided_state WHERE annotator_id=? AND set_id=? AND recording_id=?",
                       (annotator_id, set_id, recording_id))

    # ----------------------------------------------------------- quiz state
    def quiz_state(self, annotator_id: str, set_id: str) -> dict[str, Any] | None:
        row = self._one("SELECT state FROM quiz_state WHERE annotator_id=? AND set_id=?", (annotator_id, set_id))
        return json.loads(row["state"]) if row else None

    def update_quiz_state(self, annotator_id: str, set_id: str,
                          change: Callable[[dict[str, Any] | None], dict[str, Any] | None]) -> dict[str, Any] | None:
        with self._tx() as db:
            row = db.execute("SELECT state FROM quiz_state WHERE annotator_id=? AND set_id=?",
                             (annotator_id, set_id)).fetchone()
            old = json.loads(row["state"]) if row else None
            new = change(old)
            if new is None:
                return old
            db.execute("INSERT OR REPLACE INTO quiz_state (annotator_id, set_id, state, updated_at) "
                       "VALUES (?, ?, ?, ?)", (annotator_id, set_id, json.dumps(new), now_local_iso()))
            return new

    def delete_quiz_states(self, set_id: str) -> None:
        with self._tx() as db:
            db.execute("DELETE FROM quiz_state WHERE set_id=?", (set_id,))

    def delete_guided_states(self, set_id: str) -> None:
        with self._tx() as db:
            db.execute("DELETE FROM guided_state WHERE set_id=?", (set_id,))

    # ----------------------------------------------------------------- audit
    def audit_append(self, entry: dict[str, Any]) -> None:
        with self._tx() as db:
            db.execute("INSERT INTO audit (at, by, op, summary, details) VALUES (?, ?, ?, ?, ?)",
                       (str(entry.get("at", "")), str(entry.get("by", "")), str(entry.get("op", "")),
                        str(entry.get("summary", "")), json.dumps(entry.get("details") or {}, default=str)))

    def audit_page(self, before: str | None, limit: int) -> tuple[list[dict[str, Any]], str | None]:
        """Entries newest first; the cursor is the number of the last entry of the page."""
        if before:
            if not before.isdigit():
                raise AccountError("The audit cursor is not valid")
            rows = self._all("SELECT * FROM audit WHERE entry_id < ? ORDER BY entry_id DESC LIMIT ?",
                             (int(before), int(limit) + 1))
        else:
            rows = self._all("SELECT * FROM audit ORDER BY entry_id DESC LIMIT ?", (int(limit) + 1,))
        more = len(rows) > limit
        rows = rows[:limit]
        entries = [{"at": r["at"], "by": r["by"], "op": r["op"], "summary": r["summary"],
                    "details": json.loads(r["details"] or "{}")} for r in rows]
        return entries, (str(rows[-1]["entry_id"]) if more and rows else None)
