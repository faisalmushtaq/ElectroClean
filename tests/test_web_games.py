"""The game elements (electroclean/web/games.py): counters, the team's progress and the anonymised
leaderboard, with pseudonyms that are stable and never reveal an annotator's ID."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from electroclean.web.errors import ApiError
from electroclean.web.games import ADJECTIVES, ANIMALS, MIN_PEOPLE, pseudonym, pseudonyms
from electroclean.web.service import StudyService
from electroclean.web.store import User
from electroclean.web.store_files import FilesStore
from tests.web_helpers import SUB1, SUB2, SUB3, ann, copy_demo, make_template, submission

BLINK = ann("b" * 32, "Eye-blink-artifact", 500, 100, ["Fp1", "Fp2"])
EMG = ann("c" * 32, "EMG-artifact", 3000, 250, [])
PEOPLE = ("A01", "A02", "A03", "A04")


@pytest.fixture(scope="module")
def template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_template(tmp_path_factory.mktemp("web-games"))


@pytest.fixture
def recordings(template: Path) -> Path:
    return template / "recordings"


@pytest.fixture
def study(template: Path, tmp_path: Path) -> Path:
    folder = copy_demo(template, tmp_path)
    store = FilesStore(folder)
    try:
        for aid in ("A03", "A04"):
            store.db.add_user(aid, "password-1234", display_name=f"Annotator {aid}")
            store.assign(aid, [SUB1, SUB2, SUB3])
    finally:
        store.close()
    return folder


@pytest.fixture
def service(study: Path):
    store = FilesStore(study)
    yield StudyService(store)
    store.close()


def save(service: StudyService, recordings: Path, aid: str, rid: str, anns=(BLINK,), viewed=None, revises=None):
    body = submission(recordings, rid, list(anns), elapsed=120.0)
    if viewed is not None:
        body["session"]["viewed_fraction"] = viewed
    if revises is not None:
        body["revises"] = revises
    return service.call("submit", User(aid), body)


def board(service: StudyService, aid: str, body: dict | None = None) -> dict:
    return service.call("achievements", User(aid), body or {})


def test_counters_goal_and_team_progress(service: StudyService, recordings: Path) -> None:
    save(service, recordings, "A01", SUB1, [BLINK, EMG], viewed=1.0)
    save(service, recordings, "A01", SUB2, [BLINK], viewed=0.5)
    save(service, recordings, "A01", SUB1, [EMG], revises=1)
    save(service, recordings, "A02", SUB1)
    me = board(service, "A01")
    assert me["enabled"] is True and me["leaderboard_enabled"] is True
    # two recordings done; the revision adds its time but not a recording; annotations of the latest attempts
    assert me["counters"] == {"done": 2, "assigned": 3, "worked_s": 360.0, "annotations": 2}
    assert [c["viewed_fraction"] for c in me["completions"]] == [1.0, 0.5]
    assert me["viewed_in_full"] == 1 and len(me["save_times"]) == 3
    assert me["goal"] == {"per_week": None}
    # the team: A01 to A04 are each given the three study recordings (T01 has none, ADMIN is not counted)
    assert me["team"] == {"done": 3, "assigned": 12, "people": 4}
    assert board(service, "A02")["viewed_in_full"] is None  # no coverage figure: no milestone either

    out = board(service, "A01", {"goal_per_week": 12})
    assert out["goal"] == {"per_week": 12}
    assert board(service, "A01")["goal"] == {"per_week": 12}
    assert board(service, "A01", {"goal_per_week": None})["goal"] == {"per_week": None}
    for bad in ({"goal_per_week": 0}, {"goal_per_week": 201}, {"goal_per_week": True}, {"goal_per_week": "5"},
                {"leaderboard_hidden": "yes"}):
        with pytest.raises(ApiError) as exc:
            board(service, "A01", bad)
        assert exc.value.status == 400


def test_the_leaderboard_ranks_completions_under_stable_pseudonyms(service: StudyService, recordings: Path,
                                                                    study: Path) -> None:
    for aid, rids in (("A01", (SUB1, SUB2, SUB3)), ("A02", (SUB1, SUB2)), ("A04", (SUB2, SUB3)), ("A03", (SUB3,))):
        for rid in rids:
            save(service, recordings, aid, rid, viewed=1.0 if aid == "A03" else None)
    views = {aid: board(service, aid) for aid in PEOPLE}
    lb = views["A02"]["leaderboard"]
    assert lb["ranked_by"] == "completed" and lb["people"] == 4 and lb["min_people"] == MIN_PEOPLE
    assert [(r["rank"], r["count"]) for r in lb["rows"]] == [(1, 3), (2, 2), (2, 2), (4, 1)]
    assert [r["you"] for r in lb["rows"]].count(True) == 1
    assert lb["you"]["rank"] == 2 and lb["you"]["count"] == 2 and lb["you"]["hidden"] is False
    names = {aid: v["leaderboard"]["you"]["name"] for aid, v in views.items()}
    assert len(set(names.values())) == 4
    for name in names.values():
        adjective, animal = name.split(" ")
        assert adjective in ADJECTIVES and animal in ANIMALS
    assert {r["name"] for r in lb["rows"]} == set(names.values())
    assert next(r for r in lb["rows"] if r["you"])["name"] == names["A02"]

    # No real ID reaches anyone, and the study's secret never leaves the store.
    secret = service.store.study_secret("leaderboard_pseudonyms")
    for aid, v in views.items():
        text = json.dumps(v)
        assert secret not in text
        for other in PEOPLE:
            assert not re.search(rf"\b{other}\b", text), (aid, other)
        assert "display_name" not in text and "Annotator" not in text

    # Stable: the same names from a new service on the same study, and from the keyed hash itself.
    store2 = FilesStore(study)
    try:
        again = StudyService(store2)
        assert {aid: board(again, aid)["leaderboard"]["you"]["name"] for aid in PEOPLE} == names
    finally:
        store2.close()
    assert pseudonym(secret, "A01") == pseudonym(secret, "a01")
    assert pseudonyms(secret, ["A01", "A02"])["A01"] == names["A01"]
    assert pseudonym("00" * 32, "A01") != pseudonym("11" * 32, "A01")  # another study, other names

    # Hiding: left out of everyone's table; the person still sees that they are hidden.
    hidden = board(service, "A04", {"leaderboard_hidden": True})["leaderboard"]
    assert hidden["you"]["hidden"] is True and hidden["you"]["rank"] is None
    assert names["A04"] not in [r["name"] for r in hidden["rows"]]
    lb = board(service, "A01")["leaderboard"]
    assert [(r["rank"], r["count"]) for r in lb["rows"]] == [(1, 3), (2, 2), (3, 1)]
    assert names["A04"] not in json.dumps(board(service, "A02"))
    board(service, "A04", {"leaderboard_hidden": False})
    assert names["A04"] in [r["name"] for r in board(service, "A01")["leaderboard"]["rows"]]

    # Only recordings viewed in full, when the study asks for that.
    service.store.update_study(overrides={**service.store.settings_overrides,
                                          "gamification": {"leaderboard_viewed_only": True}})
    lb = board(service, "A01")["leaderboard"]
    assert lb["ranked_by"] == "viewed_in_full" and lb["people"] == 1 and lb["rows"] == []  # too few to show
    assert board(service, "A03")["leaderboard"]["you"]["count"] == 1


def test_a_small_team_is_not_shown_and_the_switches_work(service: StudyService, recordings: Path) -> None:
    save(service, recordings, "A01", SUB1)
    save(service, recordings, "A02", SUB1)
    lb = board(service, "A01")["leaderboard"]
    assert lb["people"] == 2 and lb["rows"] == [] and lb["you"]["rank"] is None and lb["you"]["count"] == 1
    me = service.call("me", User("A01"), {})
    assert me["study"]["gamification"] == {"enabled": True, "leaderboard": True}
    service.store.update_study(overrides={**service.store.settings_overrides, "gamification": {"leaderboard": False}})
    out = board(service, "A01")
    assert out["enabled"] is True and out["leaderboard"] is None and out["leaderboard_enabled"] is False
    service.store.update_study(overrides={**service.store.settings_overrides, "gamification": {"enabled": False}})
    assert board(service, "A01") == {"enabled": False, "leaderboard_enabled": False}
    assert service.call("me", User("A01"), {})["study"]["gamification"] == {"enabled": False, "leaderboard": False}


def test_the_share_viewed_is_kept_with_the_results(service: StudyService, recordings: Path, study: Path) -> None:
    save(service, recordings, "A01", SUB1, viewed=0.73)
    sess = json.loads((study / "Annotated_Events" / "annotator-A01" / "sub-001" / "eeg"
                       / "sub-001_task-rest_eeg_annotator-A01_session.json").read_text())
    assert sess["display"]["viewed_fraction"] == 0.73
    save(service, recordings, "A01", SUB2, viewed="all")  # not a share: ignored, and the save goes ahead
    assert [c["viewed_fraction"] for c in board(service, "A01")["completions"]] == [0.73, None]


def test_removing_an_account_removes_its_record(service: StudyService, recordings: Path) -> None:
    board(service, "A03", {"goal_per_week": 3})
    assert service.store.annotator_record("A03")["goal_per_week"] == 3
    service.store.remove_account("A03")
    assert service.store.annotator_record("A03") == {}


def test_a_team_of_two_does_not_show_its_progress(service: StudyService, recordings: Path) -> None:
    save(service, recordings, "A01", SUB1)
    save(service, recordings, "A02", SUB2)
    assert board(service, "A01")["team"]["done"] == 2
    for aid in ("A03", "A04"):
        service.store.remove_account(aid)
    # A01 knows their own count, so the team's would tell them what A02 has done.
    assert board(service, "A01")["team"] == {"done": None, "assigned": None, "people": 2}


def test_times_cannot_go_negative_or_absurd(service: StudyService, recordings: Path, study: Path) -> None:
    from electroclean.web.service import MAX_ELAPSED_S

    def draft(elapsed):
        return service.call("put_draft", User("A01"), {"recording_id": SUB2, "mode": "standard", "context_id": "",
                                                       "draft": {"annotations": [], "view": {}, "elapsed_s": elapsed}})

    with pytest.raises(ApiError) as exc:
        draft(-50.0)
    assert (exc.value.status, exc.value.code) == (422, "invalid_draft")
    draft(1e300)
    key = service.find_item(User("A01"), SUB2, "standard", "").key
    assert service.store.draft("A01", key)["draft"]["elapsed_s"] == MAX_ELAPSED_S
    # A save is never refused for its time: an absurd figure is recorded as a week, with a warning.
    service.call("submit", User("A01"), submission(recordings, SUB1, [BLINK], elapsed=1e300))
    sess = json.loads((study / "Annotated_Events" / "annotator-A01" / "sub-001" / "eeg"
                       / "sub-001_task-rest_eeg_annotator-A01_session.json").read_text())
    assert "more than a week" in json.dumps(sess)
    assert board(service, "A01")["counters"]["worked_s"] == MAX_ELAPSED_S
    with pytest.raises(ApiError):
        service.call("submit", User("A01"), submission(recordings, SUB3, [BLINK], elapsed=-1.0))
