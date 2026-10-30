"""Datasets, collections, groups and hand-outs (electrotag/web/datasets.py; docs/web/api.md, "Datasets, collections,
groups and hand-outs")."""

from __future__ import annotations

from electrotag.web import admin as admin_mod
from electrotag.web.store import RECORD_KINDS, Assignment


# ------------------------------------------------------------------ the interfaces
def test_the_operations_and_record_kinds_are_declared() -> None:
    for op in admin_mod.DATASET_READS + admin_mod.TRACKING_READS:
        assert op in admin_mod.READ_ONLY and op.endswith(("_get", "_list")), op
    for op in admin_mod.DATASET_WRITES:
        assert op in admin_mod.OPERATIONS and op not in admin_mod.READ_ONLY, op
        assert not op.endswith(("_get", "_list")), "a write is never retried, so it never looks like a read"
    for op in admin_mod.DATASET_READS + admin_mod.DATASET_WRITES + admin_mod.TRACKING_READS:
        assert callable(getattr(admin_mod.Admin, f"op_{op}")), op
    assert len(set(admin_mod.OPERATIONS)) == len(admin_mod.OPERATIONS), "each operation is declared once"
    assert {"datasets", "collections", "groups", "handouts", "notices"} <= set(RECORD_KINDS)


def test_an_assignment_keeps_its_positional_form() -> None:
    a = Assignment("A01", "sub-001/eeg/x.edf", "standard", "", 3, "t-000000000001")
    assert (a.task_id, a.handout_id, a.assigned_at) == ("t-000000000001", "", "")
    assert Assignment("A01", "r", handout_id="h-0123456789").handout_id == "h-0123456789"
