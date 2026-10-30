"""The overlay's filters by the study's groups and by experience (docs/web/admin.md, "Everyone's marks").

The overlay (:mod:`electrotag.web.overlay`) offers a filter for each facet registered with
:func:`~electrotag.web.overlay.register_facet`. This module registers two, from the dataset library's groups
(:mod:`electrotag.web.datasets`) and from the sign-up questionnaire's band of datasets analysed
(:mod:`electrotag.web.questionnaire`, the latest answers). Trainees never receive facets.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from electrotag.web.overlay import register_facet

if TYPE_CHECKING:
    from electrotag.web.service import StudyService

#: A time after any answer, so that a person's latest answers are taken.
LATEST = "9999-12-31T23:59:59+00:00"


@register_facet("group", "Group")
def groups_of(service: StudyService, aids: list[str]) -> dict[str, Any]:
    """Each person's current groups, by name."""
    from electrotag.web.datasets import Datasets

    wanted = set(aids)
    out: dict[str, list[str]] = {}
    for group in service.store.records("groups"):
        if group.get("state") == "removed":
            continue
        name = str(group.get("name") or group.get("group_id") or "")
        for aid in Datasets.members(group):
            if aid in wanted:
                out.setdefault(aid, []).append(name)
    return {aid: sorted(names) for aid, names in out.items()}


@register_facet("experience", "Datasets analysed")
def experience_of(service: StudyService, aids: list[str]) -> dict[str, Any]:
    """Each person's latest answer to "How many EEG datasets have you analysed?" (n/a when not answered)."""
    from electrotag.web.questionnaire import ANSWERS_KIND, band_of

    records = {str(r.get("annotator_id")): r for r in service.store.records(ANSWERS_KIND)}
    bands = {aid: band_of(service.store, records, aid, LATEST) for aid in aids if aid in records}
    return {aid: band for aid, band in bands.items() if band != "n/a"}
