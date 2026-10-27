"""Suggestions for mistyped names in command-line tools and dialogs."""

from __future__ import annotations

import difflib
from collections.abc import Iterable


def did_you_mean(value: str, choices: Iterable[str]) -> str:
    """`` Did you mean 'EMG-artifact'?`` for the closest choice, or an empty string.

    Matching ignores case, so ``a01`` suggests ``A01`` and ``emg`` suggests
    ``EMG-artifact`` (a prefix counts as close).
    """
    options = list(dict.fromkeys(choices))
    if not options:
        return ""
    lowered = {c.lower(): c for c in options}
    v = value.lower()
    prefixed = [c for c in options if c.lower().startswith(v)] if len(v) >= 2 else []
    close = difflib.get_close_matches(v, list(lowered), n=1, cutoff=0.6)
    best = prefixed[0] if len(prefixed) == 1 else (lowered[close[0]] if close else "")
    return f" Did you mean '{best}'?" if best and best != value else ""


def unknown_names(kind: str, given: Iterable[str], known: Iterable[str]) -> str | None:
    """A message naming every unknown value with a suggestion, or None when all are known."""
    known_list = list(known)
    known_set = set(known_list)
    bad = [g for g in given if g not in known_set]
    if not bad:
        return None
    parts = [f"'{b}'.{did_you_mean(b, known_list)}" for b in bad]
    listing = ", ".join(known_list[:12]) + (f" and {len(known_list) - 12} more" if len(known_list) > 12 else "")
    return (f"Unknown {kind}: " + " ".join(parts)
            + (f" Known {kind}s: {listing}." if known_list else f" There are no {kind}s to choose from."))
