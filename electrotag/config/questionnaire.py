"""The sign-up questionnaire's definition: the default questions, and the checks of a study's own.

A study's settings block ``questionnaire`` (docs/administrator_guide.md, "The sign-up questionnaire")
holds whether annotators and experts are asked at all (``enabled``), whether the demographic
questions are included (``demographics``, which a study switches on only when its ethics approval
covers them), the questions (``questions``: null for the default questionnaire below, or the study's
own list; default_settings.json holds the default questionnaire) and which contact details are
asked (``contacts``). Every question offers "Prefer not to
say", which ElectroTag adds itself, so a definition never lists it.

This module is plain Python (no web code), so that the settings can be read and checked anywhere;
the answers are kept and checked by :mod:`electrotag.web.questionnaire`.
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
from typing import Any

#: The answer "Prefer not to say", offered by every question, as it is kept and as people read it.
PREFER_NOT = "prefer_not_to_say"
PREFER_NOT_LABEL = "Prefer not to say"
#: The groups of questions, in the order they are asked, with their headings.
GROUPS = ("experience", "career", "demographics")
GROUP_TITLES = {"experience": "Your experience of EEG", "career": "Your career stage and field",
                "demographics": "About you"}
#: What the admin area says about the demographic questions.
DEMOGRAPHICS_NOTE = ("Age, gender and first language are personal data of a more sensitive kind. Include them only if "
                     "the study's ethics approval covers collecting them.")
#: choice: one option; multi: any number of options; text: a short answer on one line.
QUESTION_TYPES = ("choice", "multi", "text")
#: The contact details a study may ask for, and how each is asked.
CONTACT_FIELDS = ("full_name", "email", "phone", "institution")
CONTACT_TITLES = {"full_name": "Full name", "email": "Email", "phone": "Phone", "institution": "Institution"}
CONTACT_LEVELS = ("required", "optional", "off")
DEFAULT_CONTACTS = {"full_name": "required", "email": "required", "phone": "optional", "institution": "optional"}
QUESTION_ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
MAX_QUESTIONS = 60
MAX_OPTIONS = 30
MAX_TEXT = 300
MAX_HELP = 500
MAX_OPTION = 120
#: The longest typed answer (a text question, or the words given with "Other").
MAX_ANSWER = 200
#: The question whose bands the agreement analysis breaks agreement down by.
EXPERIENCE_QUESTION = "datasets_analysed"


def _default_questions() -> list[dict[str, Any]]:
    from pathlib import Path

    path = Path(__file__).resolve().parent / "default_settings.json"
    return json.loads(path.read_text(encoding="utf-8"))["questionnaire"]["questions"]


#: The default questionnaire (the project lead's decisions of 30 October 2026), kept in default_settings.json so
#: that the study team edits it there and the sandbox's copy of the settings carries it.
DEFAULT_QUESTIONS: list[dict[str, Any]] = _default_questions()


class QuestionnaireError(ValueError):
    """A questionnaire definition that cannot be used, in words for the study team."""


def _plain(value: Any, what: str, limit: int, *, required: bool = True) -> str:
    if value is None and not required:
        return ""
    if not isinstance(value, str) or "\n" in value or "\r" in value:
        raise QuestionnaireError(f"{what} must be text on one line")
    text = " ".join(value.split())
    if required and not text:
        raise QuestionnaireError(f"{what} is missing")
    if len(text) > limit:
        raise QuestionnaireError(f"{what} must be at most {limit} characters")
    return text


def check_question(q: Any, n: int) -> dict[str, Any]:
    """One question of a definition, checked and tidied (spaces collapsed, keys in a fixed order)."""
    where = f"Question {n}"
    if not isinstance(q, dict):
        raise QuestionnaireError(f"{where} must be an object with id, group, text and type")
    unknown = sorted(set(q) - {"id", "group", "text", "type", "options", "other_option", "required", "help"})
    if unknown:
        raise QuestionnaireError(f"{where} has a field {unknown[0]!r} that questions do not have")
    qid = q.get("id")
    if not isinstance(qid, str) or not QUESTION_ID_RE.match(qid):
        raise QuestionnaireError(f"{where}: id must be a short name of lower-case letters, digits and _ that starts "
                                 "with a letter, such as eeg_years")
    where = f"Question {qid}"
    if q.get("group") not in GROUPS:
        raise QuestionnaireError(f"{where}: group must be one of {', '.join(GROUPS)}")
    if q.get("type") not in QUESTION_TYPES:
        raise QuestionnaireError(f"{where}: type must be choice (one answer), multi (several) or text")
    out: dict[str, Any] = {"id": qid, "group": q["group"], "text": _plain(q.get("text"), f"{where}: the question",
                                                                            MAX_TEXT),
                           "type": q["type"]}
    required = q.get("required", True)
    if not isinstance(required, bool):
        raise QuestionnaireError(f"{where}: required must be true or false")
    out["required"] = required
    if q["type"] == "text":
        if q.get("options") or q.get("other_option"):
            raise QuestionnaireError(f"{where}: a text question has no options")
    else:
        opts = q.get("options")
        if not isinstance(opts, list) or not 2 <= len(opts) <= MAX_OPTIONS:
            raise QuestionnaireError(f"{where}: give from 2 to {MAX_OPTIONS} options")
        clean = [_plain(o, f"{where}: an option", MAX_OPTION) for o in opts]
        if len({c.lower() for c in clean}) != len(clean):
            raise QuestionnaireError(f"{where}: an option is given twice")
        if any(c.lower() in (PREFER_NOT_LABEL.lower(), PREFER_NOT) for c in clean):
            raise QuestionnaireError(f"{where}: leave out \"{PREFER_NOT_LABEL}\"; ElectroTag offers it with every "
                                     "question")
        out["options"] = clean
        other = q.get("other_option")
        if other not in (None, ""):
            other = _plain(other, f"{where}: other_option", MAX_OPTION)
            if other not in clean:
                raise QuestionnaireError(f"{where}: other_option must be one of its options (the one that asks the "
                                         "person to describe it in their own words)")
            out["other_option"] = other
    help_text = _plain(q.get("help"), f"{where}: help", MAX_HELP, required=False)
    if help_text:
        out["help"] = help_text
    return out


def check_questions(value: Any) -> list[dict[str, Any]] | None:
    """``questionnaire.questions``: None (the default questionnaire) or a list of questions, checked."""
    if value is None:
        return None
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_QUESTIONS:
        raise QuestionnaireError(f"questionnaire.questions must be null (the default questionnaire) or a list of 1 to "
                                 f"{MAX_QUESTIONS} questions")
    out = [check_question(q, i) for i, q in enumerate(value, start=1)]
    ids = [q["id"] for q in out]
    dup = next((x for x in ids if ids.count(x) > 1), None)
    if dup:
        raise QuestionnaireError(f"The question id {dup} is used twice; each question needs its own")
    return out


def check_contacts(value: Any) -> dict[str, str]:
    """``questionnaire.contacts``: for each contact detail, required, optional or off."""
    if value is None:
        return dict(DEFAULT_CONTACTS)
    if not isinstance(value, dict):
        raise QuestionnaireError("questionnaire.contacts must give each contact detail (full_name, email, phone, "
                                 "institution) as required, optional or off")
    unknown = sorted(set(value) - set(CONTACT_FIELDS))
    if unknown:
        raise QuestionnaireError(f"questionnaire.contacts has no detail {unknown[0]!r}; it has "
                                 f"{', '.join(CONTACT_FIELDS)}")
    out = dict(DEFAULT_CONTACTS)
    for k, v in value.items():
        if v not in CONTACT_LEVELS:
            raise QuestionnaireError(f"questionnaire.contacts.{k} must be required, optional or off")
        out[k] = v
    return out


def effective_questions(questions: list[dict[str, Any]] | None, demographics: bool) -> list[dict[str, Any]]:
    """The questions people are asked: the study's own or the default ones, without the demographic group when it
    is switched off, grouped in the order of :data:`GROUPS` (the order within a group is kept)."""
    chosen = copy.deepcopy(questions if questions is not None else DEFAULT_QUESTIONS)
    chosen = [q for q in chosen if demographics or q["group"] != "demographics"]
    return sorted(chosen, key=lambda q: GROUPS.index(q["group"]))


def version_of(questions: list[dict[str, Any]]) -> str:
    """A short name of a questionnaire's wording and options ("q-" and 10 hexadecimal digits): answers given to
    different wordings carry different versions, so that an analysis can tell them apart."""
    text = json.dumps(questions, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return "q-" + hashlib.sha256(text.encode("utf-8")).hexdigest()[:10]


__all__ = ["CONTACT_FIELDS", "CONTACT_LEVELS", "DEFAULT_CONTACTS", "DEFAULT_QUESTIONS", "DEMOGRAPHICS_NOTE",
           "EXPERIENCE_QUESTION", "GROUPS", "GROUP_TITLES", "PREFER_NOT", "PREFER_NOT_LABEL", "QUESTION_TYPES",
           "QuestionnaireError", "check_contacts", "check_questions", "effective_questions", "version_of"]
