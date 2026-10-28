"""The look of the HTML reports: contrast, a flat and self-contained style, and the chart colours."""

from __future__ import annotations

import re

import pandas as pd
import pytest

from electroclean.activity.report import _css as activity_css
from electroclean.activity.report import line_chart
from electroclean.reliability.report import CSS as AGREEMENT_CSS
from electroclean.reliability.report import INK, _table, _value_colour
from electroclean.report_style import COLOURS, FONT_MONO, FONT_SERIF, TEXT_PAIRS, contrast_ratio
from electroclean.training.assessment import _CSS as COMPETENCY_CSS
from electroclean.training.assessment import competency_html

STYLE_SHEETS = {"agreement": AGREEMENT_CSS, "activity": activity_css(), "competency": COMPETENCY_CSS}


@pytest.mark.parametrize("text, background", TEXT_PAIRS)
def test_text_colours_meet_wcag_aa(text, background):
    assert contrast_ratio(COLOURS[text], COLOURS[background]) >= 4.5, (text, background)


@pytest.mark.parametrize("name", sorted(STYLE_SHEETS))
def test_every_report_is_flat_and_fetches_nothing(name):
    css = STYLE_SHEETS[name]
    assert "box-shadow" not in css and "gradient" not in css
    assert all(r.strip() in ("0", "999px") for r in re.findall(r"border-radius:([^;}]+)", css))  # square panels
    # Self-contained: no font files, imports or other addresses.
    assert "@font-face" not in css and "@import" not in css and "url(" not in css and "http" not in css
    assert f"--page:{COLOURS['page']}" in css and f"--accent:{COLOURS['accent']}" in css
    assert "uppercase" not in css and "small-caps" not in css  # no text set in capitals
    # Every font comes from the two stacks, which end in a family every system has.
    assert {f.strip() for f in re.findall(r"font-family:([^;}]+)", css)} <= {"var(--font-serif)", "var(--font-mono)"}
    assert FONT_SERIF.endswith(", serif") and FONT_MONO.endswith(", monospace")


def test_numbers_in_the_agreement_tables_are_marked_for_the_monospaced_font():
    page = _table(pd.DataFrame({"category": ["Eye-blink-artifact"], "f1": [0.5], "n_reference": [3]}))
    assert "<td class='nowrap'>Eye-blink-artifact</td>" in page
    assert "<td class='num'>0.500</td>" in page and "<td class='num'>3</td>" in page


def test_heat_map_values_take_the_more_legible_of_ink_and_white():
    assert _value_colour(0.0) == INK and _value_colour(1.0) == "white"


def test_a_single_learning_curve_takes_the_accent_and_several_keep_their_palette():
    one = line_chart("c", [{"name": "A01", "points": [(1, 2.0, "r1"), (2, 1.5, "r2")]}], unit="min")
    assert 'class="line single"' in one and ".line.single{stroke:var(--accent)}" in activity_css()
    two = line_chart("c", [{"name": "A01", "points": [(1, 2.0, "r1")]}, {"name": "A02", "points": [(1, 3.0, "r1")]}],
                     unit="min")
    assert 'class="line s1"' in two and 'class="line s2"' in two


@pytest.mark.parametrize("status, text, background, bar", [
    ("met", "success_text", "success_bg", "success_bar"), ("not_met", "error_text", "error_bg", "error_text"),
    ("incomplete", "warning_text", "warning_bg", "warning_text"),
])
def test_competency_status_uses_the_state_colours(status, text, background, bar):
    report = {"status": status, "status_text": "Result.", "annotator_id": "A01", "inputs": {},
              "reference_set": {"set_id": "s", "name": "Set", "provenance": {}}, "software": {"electroclean": "x"}}
    page = competency_html(report)
    heading = page[page.index("<h2 class='status'"):]
    heading = heading[:heading.index(">")]
    assert f"color:{COLOURS[text]};background:{COLOURS[background]};border-left-color:{COLOURS[bar]}" in heading
