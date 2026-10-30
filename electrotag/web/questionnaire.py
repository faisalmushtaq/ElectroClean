"""The sign-up questionnaire and contact details on the server (docs/web/api.md, "The sign-up questionnaire").

Annotators and experts answer a short questionnaire about their experience of EEG, their career
stage and field and (where the study's ethics approval covers it) a few demographic questions,
together with their full name and contact details, once, at their first sign-in. Until they have
answered, the study refuses their recordings, training and expert work with 403
``questionnaire_required`` (:data:`GATED_OPERATIONS`, checked in ``StudyService.call``); an
administrator who does not annotate is never asked. People can change their answers later from
their home page: every change is kept with its date, as a history, so that the analyses can use the
answers current at the time of each piece of work (:func:`answers_at`).

Two records are kept for each person (``Store.update_record``), so that a pseudonymised export never
touches the identifying one:

* ``questionnaires`` (record ID: the annotator ID): the answers, by annotator ID, as research data,
  with their history and the wording of each version of the questionnaire answered;
* ``contacts`` (record ID: the annotator ID): the full name and contact details, for the study team
  only. They go into a results file only as ``contacts.csv``, when an administrator asks for it,
  and that is written to the audit log.

The interaction log records only that the questionnaire was answered and how many questions were
(the browser's ``questionnaire_answered``); nothing a person answers or types reaches it, nor the
audit log, which notes only that someone's details changed.
"""

from __future__ import annotations

import csv
import io
import json
import re
from typing import TYPE_CHECKING, Any

from electrotag.app.common import now_local_iso
from electrotag.config.questionnaire import (
    CONTACT_FIELDS,
    CONTACT_TITLES,
    DEMOGRAPHICS_NOTE,
    EXPERIENCE_QUESTION,
    GROUP_TITLES,
    GROUPS,
    MAX_ANSWER,
    PREFER_NOT,
    PREFER_NOT_LABEL,
    version_of,
)
from electrotag.web import audit
from electrotag.web.errors import ApiError
from electrotag.web.store import User

if TYPE_CHECKING:
    from electrotag.web.service import StudyService

#: The record kinds (electrotag/web/store.py RECORD_KINDS).
ANSWERS_KIND = "questionnaires"
CONTACTS_KIND = "contacts"
#: The operations of docs/web/api.md that wait for the questionnaire: opening, drafting and saving recordings,
#: the training programme, the quiz and the expert area.
GATED_OPERATIONS = ("match", "put_draft", "submit", "training", "guided_get", "guided_check", "guided_continue",
                    "guided_show_me", "training_stage", "training_snippets", "quiz", "expert")
REQUIRED_TEXT = ("Please answer the short sign-up questionnaire first. Your recordings, training and expert work open "
                 "once it is answered; you can change your answers later from your home page.")
#: The warning the admin area and the results zip give with names and contact details.
CONTACTS_WARNING = ("This file names people and gives their contact details. Keep it apart from the research data, "
                    "share it only with the study team, and delete it when it is no longer needed.")
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,63}$")
PHONE_RE = re.compile(r"^[0-9+()./ -]{3,40}$")
CONTACT_LIMITS = {"full_name": 200, "email": 254, "phone": 40, "institution": 200}
#: The columns that start answers.tsv and the tables of the analyses.
ANSWER_COLUMNS = ("annotator_id", "questionnaire_version", "answered_at", "current")
CONTACT_COLUMNS = ("annotator_id", "full_name", "email", "phone", "institution", "updated_at", "account")


def _roles(acc: dict[str, Any]) -> tuple[str, ...]:
    from electrotag.web.store import parse_roles

    return parse_roles(acc.get("roles") or acc.get("role"))


def _bad(message: str, code: str = "invalid_answers", status: int = 422) -> ApiError:
    return ApiError(status, code, message)


def _line(value: Any, what: str, limit: int) -> str:
    if not isinstance(value, str):
        raise _bad(f"{what} must be text")
    if "\n" in value or "\r" in value:
        raise _bad(f"{what} must be on one line")
    text = " ".join(value.split())
    if len(text) > limit:
        raise _bad(f"{what} must be at most {limit} characters")
    return text


def check_answers(questions: list[dict[str, Any]], answers: Any, other: Any) -> tuple[dict[str, Any], dict[str, str]]:
    """The answers of a submission, checked against the questions: ``answers`` maps a question's id to its
    answer (an option, a list of options for ``multi``, text for ``text``, or :data:`PREFER_NOT`; missing or
    null when it is not answered), ``other`` to the words given with the option that asks for them."""
    if not isinstance(answers, dict):
        raise _bad("answers must map each question's id to its answer")
    if other is None:
        other = {}
    if not isinstance(other, dict):
        raise _bad("other must map a question's id to the words given with its \"Other\" option")
    by_id = {q["id"]: q for q in questions}
    unknown = sorted(set(answers) - set(by_id))
    if unknown:
        raise _bad(f"There is no question {unknown[0]!r} in this study's questionnaire; reload the page to see the "
                   "questions as they are now", "unknown_question")
    out: dict[str, Any] = {}
    words: dict[str, str] = {}
    for q in questions:
        qid, value = q["id"], answers.get(q["id"])
        title = f"“{q['text']}”"
        if value is None or value == "" or value == []:
            if q.get("required", True):
                raise _bad(f"Please answer {title}, or choose {PREFER_NOT_LABEL}.", "questionnaire_incomplete")
            continue
        if q["type"] == "choice":
            if value != PREFER_NOT and value not in q["options"]:
                raise _bad(f"{value!r} is not one of the answers to {title}")
        elif q["type"] == "multi":
            if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
                raise _bad(f"The answer to {title} must be a list of its options")
            if len(set(value)) != len(value):
                raise _bad(f"The answer to {title} names an option twice")
            if PREFER_NOT in value and len(value) > 1:
                raise _bad(f"{PREFER_NOT_LABEL} cannot be chosen together with other answers to {title}")
            bad = [v for v in value if v != PREFER_NOT and v not in q["options"]]
            if bad:
                raise _bad(f"{bad[0]!r} is not one of the answers to {title}")
            value = [o for o in q["options"] if o in value] or [PREFER_NOT]  # in the order of the options
        else:
            value = _line(value, f"The answer to {title}", MAX_ANSWER)
            if not value:
                if q.get("required", True):
                    raise _bad(f"Please answer {title}, or choose {PREFER_NOT_LABEL}.", "questionnaire_incomplete")
                continue
        out[qid] = value
        opt = q.get("other_option")
        chosen = value if isinstance(value, list) else [value]
        if opt and opt in chosen and other.get(qid) not in (None, ""):
            text = _line(other[qid], f"The words given with {opt}", MAX_ANSWER)
            if text:
                words[qid] = text
    stray = sorted(k for k in other if k not in words and other.get(k) not in (None, ""))
    for k in stray:
        if k not in by_id:
            raise _bad(f"There is no question {k!r} in this study's questionnaire", "unknown_question")
    return out, words


def answers_at(record: dict[str, Any] | None, when: str) -> tuple[dict[str, Any] | None, bool]:
    """The entry of a person's history current at ``when`` (an ISO time), and whether it was given only after
    (no answers existed yet then, so the earliest is used: a study that began before the questionnaire)."""
    history = (record or {}).get("history") or []
    if not history:
        return None, False
    before = [h for h in history if not when or _instant(h.get("at")) <= _instant(when)]
    if before:
        return before[-1], False
    return history[0], True


def _instant(stamp: Any) -> float:
    """An ISO time as seconds (local times with their offsets compare correctly); 0 when it cannot be read."""
    from datetime import datetime

    try:
        return datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return 0.0


def cell(value: Any) -> str:
    """An answer in a table: options joined by "; ", n/a when it was not answered."""
    if value is None or value == "" or value == []:
        return "n/a"
    if isinstance(value, list):
        return "; ".join(str(v) for v in value)
    return " ".join(str(value).split())


class Questionnaire:
    def __init__(self, service: StudyService) -> None:
        self.service = service
        self._answered: set[str] = set()  # people known to have answered (an answer is never taken away)

    @property
    def store(self) -> Any:
        return self.service.store

    @property
    def settings(self) -> Any:
        return self.service.settings.questionnaire

    def questions(self) -> list[dict[str, Any]]:
        return self.settings.effective()

    def version(self) -> str:
        return version_of(self.questions())

    # ------------------------------------------------------------ who is asked
    def asked(self, user: User) -> bool:
        """Annotators and experts are asked (participants too); an administrator who does not annotate is not."""
        return bool(self.settings.enabled) and any(user.has_role(r) for r in ("annotator", "expert", "participant"))

    def record(self, aid: str) -> dict[str, Any] | None:
        rows = self.store.records(ANSWERS_KIND, aid)
        return rows[0] if rows else None

    def contacts(self, aid: str) -> dict[str, Any] | None:
        rows = self.store.records(CONTACTS_KIND, aid)
        return rows[0] if rows else None

    def answered(self, user: User) -> bool:
        aid = user.annotator_id
        if aid in self._answered:
            return True
        rec = self.record(aid)
        if rec and rec.get("history"):
            self._answered.add(aid)
            return True
        return False

    def require_answered(self, user: User) -> None:
        """403 ``questionnaire_required`` while someone who is asked has not answered yet."""
        if self.asked(user) and not self.answered(user):
            raise ApiError(403, "questionnaire_required", REQUIRED_TEXT)

    def status(self, user: User) -> dict[str, Any]:
        """``questionnaire`` of ``GET /me``: whether the person is asked, whether they have answered, and when."""
        asked = self.asked(user)
        rec = self.record(user.annotator_id) if asked or self.settings.enabled else None
        latest = ((rec or {}).get("history") or [None])[-1]
        current = self.version()
        missing = 0
        if latest is not None:
            given = latest.get("answers") or {}
            missing = sum(1 for q in self.questions() if q.get("required", True) and q["id"] not in given)
        return {"enabled": bool(self.settings.enabled), "asked": asked, "answered": latest is not None,
                "answered_at": latest.get("at") if latest else None,
                "version": latest.get("version") if latest else None, "current_version": current,
                "missing": missing}

    # ------------------------------------------------------- the person's own
    def view(self, user: User) -> dict[str, Any]:
        """``GET /me/questionnaire``: the questions, the person's current answers and their contact details."""
        s = self.settings
        rec = self.record(user.annotator_id)
        latest = ((rec or {}).get("history") or [None])[-1]
        contacts = self.contacts(user.annotator_id)
        values = {k: str((contacts or {}).get(k) or "") for k in CONTACT_FIELDS}
        if not contacts:  # prefilled from the account
            acc = self.store.user_record(user.annotator_id) or {}
            values["email"] = str(acc.get("email") or "")
        return {
            "enabled": bool(s.enabled), "asked": self.asked(user),
            "groups": [{"key": g, "title": GROUP_TITLES[g]} for g in GROUPS
                       if any(q["group"] == g for q in self.questions())],
            "questions": self.questions(), "version": self.version(),
            "prefer_not": {"value": PREFER_NOT, "label": PREFER_NOT_LABEL},
            "answers": dict((latest or {}).get("answers") or {}), "other": dict((latest or {}).get("other") or {}),
            "answered_at": latest.get("at") if latest else None,
            "answered_version": latest.get("version") if latest else None,
            "n_versions": len((rec or {}).get("history") or []),
            "contacts": {"fields": [{"key": k, "title": CONTACT_TITLES[k], "level": s.contacts.get(k, "optional")}
                                    for k in CONTACT_FIELDS if s.contacts.get(k, "optional") != "off"],
                         "values": {k: v for k, v in values.items() if s.contacts.get(k, "optional") != "off"}},
        }

    def _contacts_in(self, given: Any) -> dict[str, str]:
        s = self.settings
        if given is None:
            given = {}
        if not isinstance(given, dict):
            raise _bad("contacts must be an object with full_name, email, phone and institution")
        unknown = sorted(set(given) - set(CONTACT_FIELDS))
        if unknown:
            raise _bad(f"There is no contact detail {unknown[0]!r}")
        out: dict[str, str] = {}
        for k in CONTACT_FIELDS:
            level = s.contacts.get(k, "optional")
            if level == "off":
                continue
            value = given.get(k)
            text = "" if value is None else _line(value, CONTACT_TITLES[k], CONTACT_LIMITS[k])
            if not text and level == "required":
                raise _bad(f"Please give your {CONTACT_TITLES[k].lower()}.", "questionnaire_incomplete")
            if text and k == "email" and not EMAIL_RE.match(text):
                raise _bad(f"{text} does not look like an email address")
            if text and k == "phone" and not PHONE_RE.match(text):
                raise _bad("A phone number may have digits, spaces, +, brackets and dashes")
            out[k] = text
        return out

    def save(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """``POST /me/questionnaire {answers, other, contacts}``: the answers become the current ones (a new entry of
        the history when they differ), the contact details are kept apart. The same answers sent again change
        nothing (the request may reach the study twice)."""
        if not self.settings.enabled:
            raise ApiError(409, "questionnaire_off", "This study does not ask the sign-up questionnaire.")
        questions = self.questions()
        version = version_of(questions)
        answers, other = check_answers(questions, body.get("answers"), body.get("other"))
        contacts = self._contacts_in(body.get("contacts"))
        aid = user.annotator_id
        now = now_local_iso()
        changed = {"answers": False}

        def change(rec: dict[str, Any] | None) -> dict[str, Any] | None:
            rec = dict(rec or {"annotator_id": aid, "history": [], "definitions": {}})
            history = list(rec.get("history") or [])
            last = history[-1] if history else None
            if last and last.get("version") == version and last.get("answers") == answers \
                    and (last.get("other") or {}) == other:
                return None
            history.append({"at": now, "version": version, "answers": answers, "other": other})
            defs = dict(rec.get("definitions") or {})
            defs.setdefault(version, questions)
            rec.update(annotator_id=aid, history=history, definitions=defs)
            changed["answers"] = True
            return rec

        self.store.update_record(ANSWERS_KIND, aid, aid, change)
        self._answered.add(aid)
        contacts_changed = {"v": False}

        def change_contacts(rec: dict[str, Any] | None) -> dict[str, Any] | None:
            old = {k: str((rec or {}).get(k) or "") for k in CONTACT_FIELDS}
            new = {**old, **contacts}
            if rec is not None and new == old:
                return None
            contacts_changed["v"] = True
            return {"annotator_id": aid, **new, "updated_at": now}

        self.store.update_record(CONTACTS_KIND, aid, aid, change_contacts)
        if contacts_changed["v"]:
            # names and contact details never enter the audit log: only that they changed
            audit.record(self.store, aid, "contacts_changed", f"{aid}'s contact details changed", {"annotator_id": aid})
        out = self.view(user)
        out["changed"] = changed["answers"] or contacts_changed["v"]
        out["n_answered"] = len(answers)
        return out

    def run(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """``GET /me/questionnaire`` (a body without ``answers``) and ``POST /me/questionnaire``."""
        if "answers" in body:
            return self.save(user, body)
        return self.view(user)

    # ------------------------------------------------------------ the study team
    def _person(self, body: dict[str, Any]) -> str:
        from electrotag.web.accounts import AccountError, normalise_id

        aid = body.get("annotator_id")
        if not isinstance(aid, str):
            raise ApiError(400, "bad_request", "annotator_id is missing")
        try:
            return normalise_id(aid)
        except AccountError as exc:
            raise ApiError(400, "bad_request", f"annotator_id: {exc}") from exc

    def admin_get(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """``questionnaire_get {annotator_id}``: a person's answers with their history, and their contact details."""
        aid = self._person(body)
        acc = self.store.user_record(aid)
        rec = self.record(aid) or {}
        person = User(aid, str(acc.get("display_name") or ""), roles=_roles(acc)) if acc else None
        contacts = self.contacts(aid)
        return {"annotator_id": aid, "asked": self.asked(person) if person else False,
                "answered": bool(rec.get("history")), "questions": self.questions(), "version": self.version(),
                "history": list(reversed(rec.get("history") or [])),  # newest first
                "definitions": rec.get("definitions") or {},
                "contacts": ({k: str(contacts.get(k) or "") for k in CONTACT_FIELDS}
                             | {"updated_at": contacts.get("updated_at")}) if contacts else None,
                "prefer_not": {"value": PREFER_NOT, "label": PREFER_NOT_LABEL}}

    def admin_summary(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """``questionnaire_summary``: everyone's current answers, by annotator ID, and how often each was given."""
        questions = self.questions()
        records = {r.get("annotator_id"): r for r in self.store.records(ANSWERS_KIND)}
        rows, waiting = [], []
        counts: dict[str, dict[str, int]] = {q["id"]: {} for q in questions}
        for acc in sorted(self.store.user_records(), key=lambda r: r["annotator_id"]):
            aid = acc["annotator_id"]
            person = User(aid, roles=_roles(acc))
            rec = records.pop(aid, None)
            latest = ((rec or {}).get("history") or [None])[-1]
            if latest is None:
                if self.asked(person) and acc.get("status", "active") == "active":
                    waiting.append(aid)
                continue
            rows.append({"annotator_id": aid, "answered_at": latest.get("at"), "version": latest.get("version"),
                         "n_changes": len(rec["history"]) - 1, "answers": latest.get("answers") or {},
                         "other": latest.get("other") or {}})
        for aid, rec in sorted(records.items()):  # people whose accounts were removed: their answers stay
            latest = ((rec or {}).get("history") or [None])[-1]
            if latest is not None and aid:
                rows.append({"annotator_id": aid, "answered_at": latest.get("at"), "version": latest.get("version"),
                             "n_changes": len(rec["history"]) - 1, "answers": latest.get("answers") or {},
                             "other": latest.get("other") or {}, "removed": True})
        for r in rows:
            for qid, value in r["answers"].items():
                if qid in counts:
                    for v in value if isinstance(value, list) else [value]:
                        key = PREFER_NOT_LABEL if v == PREFER_NOT else str(v)
                        if next(q for q in questions if q["id"] == qid)["type"] == "text" and v != PREFER_NOT:
                            key = "answered"
                        counts[qid][key] = counts[qid].get(key, 0) + 1
        return {"questions": questions, "version": self.version(), "rows": rows, "counts": counts,
                "not_answered": waiting, "enabled": bool(self.settings.enabled),
                "demographics": bool(self.settings.demographics), "demographics_note": DEMOGRAPHICS_NOTE,
                "prefer_not": {"value": PREFER_NOT, "label": PREFER_NOT_LABEL}}

    def contact_rows(self) -> list[dict[str, str]]:
        return self.rows_of(self.store)

    @staticmethod
    def rows_of(store: Any) -> list[dict[str, str]]:
        """Everyone's contact details, with whether their account is active, disabled or removed."""
        accounts = {r["annotator_id"]: r for r in store.user_records()}
        out = []
        for rec in sorted(store.records(CONTACTS_KIND), key=lambda r: str(r.get("annotator_id"))):
            aid = str(rec.get("annotator_id") or "")
            acc = accounts.get(aid)
            out.append({**{k: str(rec.get(k) or "") for k in CONTACT_FIELDS}, "annotator_id": aid,
                        "updated_at": str(rec.get("updated_at") or ""),
                        "account": "removed" if acc is None else str(acc.get("status") or "active")})
        return out

    def contact_names(self) -> dict[str, str]:
        """Each person's full name by annotator ID, for the admin area's lists (never for the research files)."""
        return {str(r.get("annotator_id")): str(r.get("full_name") or "") for r in self.store.records(CONTACTS_KIND)
                if r.get("full_name")}

    def add_to_users(self, users: list[dict[str, Any]]) -> None:
        """``users_list``: each account's full name (from the contact details) and whether they have answered."""
        names = self.contact_names()
        answered = {str(r.get("annotator_id")) for r in self.store.records(ANSWERS_KIND) if r.get("history")}
        for u in users:
            u["full_name"] = names.get(u["annotator_id"], "")
            u["questionnaire_answered"] = u["annotator_id"] in answered

    def contacts_list(self, user: User, body: dict[str, Any]) -> dict[str, Any]:
        """``contacts_download``: everyone's name and contact details, for the study team; written to the audit log."""
        rows = self.contact_rows()
        audit.record(self.store, user.annotator_id, "contacts_download",
                     f"Downloaded the contact details of {audit.count(len(rows), 'person', 'people')}",
                     {"n_people": len(rows)})
        return {"columns": list(CONTACT_COLUMNS), "rows": rows, "csv": contacts_csv(rows), "warning": CONTACTS_WARNING,
                "file_name": f"{self.store.study_id}_contacts.csv"}


# ------------------------------------------------------------------ files and analyses
def _all_records(store: Any) -> list[dict[str, Any]]:
    return sorted(store.records(ANSWERS_KIND), key=lambda r: str(r.get("annotator_id")))


def _columns(store: Any, records: list[dict[str, Any]]) -> list[tuple[str, dict[str, Any]]]:
    """Every question answered or asked now, current ones first: (id, question)."""
    current = store.settings.questionnaire.effective()
    out: dict[str, dict[str, Any]] = {q["id"]: q for q in current}
    for rec in records:
        for defs in (rec.get("definitions") or {}).values():
            for q in defs:
                out.setdefault(q["id"], q)
    return list(out.items())


def _answer_cells(columns: list[tuple[str, dict[str, Any]]], entry: dict[str, Any] | None) -> list[str]:
    answers = (entry or {}).get("answers") or {}
    other = (entry or {}).get("other") or {}
    cells = []
    for qid, q in columns:
        cells.append(cell(answers.get(qid)))
        if q.get("other_option"):
            cells.append(cell(other.get(qid)))
    return cells


def _answer_headers(columns: list[tuple[str, dict[str, Any]]]) -> list[str]:
    out = []
    for qid, q in columns:
        out.append(qid)
        if q.get("other_option"):
            out.append(f"{qid}_other")
    return out


def _tsv(header: list[str], rows: list[list[str]]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, delimiter="\t", lineterminator="\n")
    w.writerow(header)
    for r in rows:
        w.writerow([" ".join(str(c).split()) for c in r])
    return buf.getvalue()


def answers_tsv(store: Any, records: list[dict[str, Any]] | None = None) -> str:
    """questionnaire/answers.tsv: one row for each set of answers given (the history), by annotator ID."""
    records = _all_records(store) if records is None else records
    columns = _columns(store, records)
    rows = []
    for rec in records:
        history = rec.get("history") or []
        for i, e in enumerate(history):
            rows.append([str(rec.get("annotator_id")), str(e.get("version") or ""), str(e.get("at") or ""),
                         "true" if i == len(history) - 1 else "false", *_answer_cells(columns, e)])
    return _tsv([*ANSWER_COLUMNS, *_answer_headers(columns)], rows)


def answers_json(store: Any, records: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """questionnaire/answers.json: the answers with their history and the wording of each version answered."""
    records = _all_records(store) if records is None else records
    definitions: dict[str, Any] = {}
    for rec in records:
        definitions.update(rec.get("definitions") or {})
    current = store.settings.questionnaire.effective()
    definitions.setdefault(version_of(current), current)
    return {"schema": "electrotag.questionnaire_answers", "schema_version": 1, "generated_at": now_local_iso(),
            "current_version": version_of(current), "prefer_not_to_say": PREFER_NOT, "definitions": definitions,
            "people": [{"annotator_id": rec.get("annotator_id"), "history": rec.get("history") or []}
                       for rec in records]}


def questionnaire_files(store: Any) -> dict[str, bytes]:
    """The answers as result files (pseudonymised: by annotator ID, with no name or contact detail)."""
    records = _all_records(store)
    if not records:
        return {}
    return {"questionnaire/answers.tsv": answers_tsv(store, records).encode("utf-8"),
            "questionnaire/answers.json": (json.dumps(answers_json(store, records), ensure_ascii=False, indent=1)
                                           + "\n").encode("utf-8")}


def _safe_cell(value: Any) -> str:
    """A cell a spreadsheet will not take for a formula (a leading =, +, - or @ gets an apostrophe)."""
    text = str(value or "")
    return "'" + text if text[:1] in ("=", "+", "-", "@") else text


def contacts_csv(rows: list[dict[str, str]]) -> str:
    """contacts.csv: everyone's name and contact details by annotator ID (it identifies people)."""
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(CONTACT_COLUMNS)
    for r in rows:
        w.writerow([_safe_cell(r.get(c, "")) for c in CONTACT_COLUMNS])
    return buf.getvalue()


def answers_at_times(store: Any, rows: list[dict[str, str]], key_columns: tuple[str, ...], when_column: str) -> str:
    """A table of the answers current at the time of each row (``rows`` carry ``annotator_id`` and the time in
    ``when_column``), joinable to the analyses' tables by annotator ID and the key columns."""
    records = {str(r.get("annotator_id")): r for r in _all_records(store)}
    columns = _columns(store, list(records.values()))
    out = []
    for row in rows:
        aid = str(row.get("annotator_id") or "")
        entry, after = answers_at(records.get(aid), str(row.get(when_column) or ""))
        out.append([*(str(row.get(k) or "") for k in key_columns), str(row.get(when_column) or ""),
                    str((entry or {}).get("version") or "n/a"), str((entry or {}).get("at") or "n/a"),
                    "n/a" if entry is None else ("true" if after else "false"), *_answer_cells(columns, entry)])
    header = [*key_columns, when_column, "questionnaire_version", "answered_at", "answered_after",
              *_answer_headers(columns)]
    return _tsv(header, out)


def band_of(store: Any, records: dict[str, dict[str, Any]], aid: str, when: str) -> str:
    entry, _after = answers_at(records.get(aid), when)
    value = ((entry or {}).get("answers") or {}).get(EXPERIENCE_QUESTION)
    if value is None:
        return "n/a"
    return PREFER_NOT_LABEL if value == PREFER_NOT else str(value)


def agreement_tables(store: Any, result: Any) -> dict[str, str]:
    """The agreement analysis's questionnaire tables: ``questionnaire_at_annotation.tsv`` (the answers current when
    each recording was annotated) and ``agreement_by_experience.tsv`` (the time-resolved pairwise agreement of
    each recording, averaged by the two annotators' bands of datasets analysed at the time)."""
    from electrotag.reliability.report import POOLED

    records = {str(r.get("annotator_id")): r for r in _all_records(store)}
    if not records:
        return {}
    docs: dict[tuple[str, str], str] = {}
    rows = []
    for rid, group in sorted(result.dataset.groups.items()):
        for aid, doc in sorted(group.docs.items()):
            when = str(getattr(doc, "created_at", "") or "")
            docs[(rid, str(aid))] = when
            rows.append({"recording_id": rid, "annotator_id": str(getattr(doc, "annotator_id", aid) or aid),
                         "rater": str(aid), "mode": doc.mode, "annotated_at": when})
    out = {"questionnaire_at_annotation.tsv": answers_at_times(store, rows, ("recording_id", "rater", "mode"),
                                                               "annotated_at")}
    df = result.tables.get("timeresolved_pairwise")
    if df is None or df.empty:
        return out
    options = next((q.get("options") or [] for q in store.settings.questionnaire.effective()
                    if q["id"] == EXPERIENCE_QUESTION), [])
    order = {o: i for i, o in enumerate(options)}
    sums: dict[tuple[str, str], list[float]] = {}
    sel = df[(df.recording != POOLED) & (df.representation == "exact") & (df.channel_mode == "time_only")]
    for r in sel.itertuples(index=False):
        rid, r1, r2 = str(r.recording), str(r.rater_1), str(r.rater_2)
        b1 = band_of(store, records, r1, docs.get((rid, r1), ""))
        b2 = band_of(store, records, r2, docs.get((rid, r2), ""))
        pair = " & ".join(sorted((b1, b2), key=lambda b: (order.get(b, len(order)), b)))
        acc = sums.setdefault((pair, str(r.category)), [0.0, 0.0, 0.0, 0.0, 0.0])
        acc[0] += 1
        for i, name in ((1, "cohen_kappa"), (3, "positive_agreement")):
            v = getattr(r, name, None)
            try:
                v = float(v)
            except (TypeError, ValueError):
                continue
            if v == v:
                acc[i] += v
                acc[i + 1] += 1
    lines = []
    for (pair, category), acc in sorted(sums.items()):
        kappa = f"{acc[1] / acc[2]:.6g}" if acc[2] else "n/a"
        pos = f"{acc[3] / acc[4]:.6g}" if acc[4] else "n/a"
        lines.append([pair, category, str(int(acc[0])), kappa, pos])
    out["agreement_by_experience.tsv"] = _tsv(["datasets_analysed_bands", "category", "n_comparisons",
                                               "mean_cohen_kappa", "mean_positive_agreement"], lines)
    return out


def activity_table(store: Any, visits: list[dict[str, Any]]) -> dict[str, str]:
    """The activity analysis's ``questionnaire_at_visit.tsv``: the answers current when each visit started."""
    if not store.records(ANSWERS_KIND):
        return {}
    rows = [{"visit_id": str(v.get("visit_id") or ""), "annotator_id": str(v.get("annotator_id") or ""),
             "started_at": str(v.get("started_at") or "")} for v in visits]
    return {"questionnaire_at_visit.tsv": answers_at_times(store, rows, ("visit_id", "annotator_id"), "started_at")}


# ------------------------------------------------------------------ demonstrations
#: The answers the demonstration's accounts start with, so that visitors are not stopped by the questionnaire
#: (js/api/demo_questionnaire.js gives the sandbox's accounts the same).
EXAMPLE_ANSWERS = {
    "datasets_analysed": "3–10", "eeg_years": "3–5", "annotation_hours": "10–50",
    "artifact_training": "A course or workshop", "eeg_systems": ["Brain Products"], "eeg_setting": "Research",
    "confidence": "3", "career_stage": "PhD", "discipline": "Neuroscience", "country": "United Kingdom",
    "age_band": PREFER_NOT, "gender": PREFER_NOT, "first_language": PREFER_NOT,
}
#: When the demonstration's answers were given (fixed, so that the sandbox and the study agree).
EXAMPLE_AT = "2026-10-28T09:00:00.000+00:00"


def prefill_example(store: Any, aid: str, display_name: str = "", email: str = "") -> None:
    """Give a demonstration account the example answers and contact details, as if they had answered."""
    questions = store.settings.questionnaire.effective()
    answers = {q["id"]: EXAMPLE_ANSWERS[q["id"]] for q in questions if q["id"] in EXAMPLE_ANSWERS}
    version = version_of(questions)
    entry = {"at": EXAMPLE_AT, "version": version, "answers": answers, "other": {}}
    store.update_record(ANSWERS_KIND, aid, aid, lambda rec: None if rec and rec.get("history") else {
        "annotator_id": aid, "history": [entry], "definitions": {version: questions}})
    store.update_record(CONTACTS_KIND, aid, aid, lambda rec: None if rec else {
        "annotator_id": aid, "full_name": display_name or aid, "email": email or f"{aid.lower()}@example.org",
        "phone": "", "institution": "ElectroTag demonstration", "updated_at": EXAMPLE_AT})
