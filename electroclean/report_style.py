"""The look of the HTML reports, taken from the browser application's design.

The agreement report (``reliability/report.py``), the activity report (``activity/report.py``) and
the competency report (``training/assessment.py``) are stand-alone pages: they are downloaded, and
the admin area shows them in a frame. Each embeds its own style sheet, which starts with
``BASE_CSS`` below. Fonts are named through stacks that end in fonts every system has, so a report
fetches nothing (no font files and no other addresses) and still reads well where the design's
fonts are not installed.

The design is editorial and precise: a warm off-white page, serif type with headings at regular
weight, hairline rules, one ink-blue accent and monospaced numbers. Panels, tables and figures have
square corners and hairline frames, with no shadows or gradients. Tables of data and figures are
white, and the header row of a table sits on a slightly stronger rule. Column headings and small
labels are the serif at a small size in a secondary grey, in ordinary case: no text is set in
capitals. JetBrains Mono is kept for numbers, codes and figures. Ink blue marks links and
highlighted figures and is the colour of a chart with one series. Warnings, errors and successes
are framed blocks on a tinted background with a 3-pixel bar on the left. Every text colour meets
the WCAG 2.1 AA contrast ratio of 4.5:1 on the background it is used on (``TEXT_PAIRS``, checked
by tests/test_report_style.py).
"""

from __future__ import annotations

COLOURS: dict[str, str] = {
    "page": "#FDFCFB",
    "panel": "#FAF6F0",  # secondary bands and panels
    "white": "#FFFFFF",  # tables of data and figures
    "fill": "#F3EFE8",  # a quiet filled cell
    "ink": "#1E1E1E",  # headings and strong text
    "body": "#3B3A38",
    "secondary": "#64625E",
    "tertiary": "#6B6863",
    "hairline": "#E4E0DA",  # dividers and table rules
    "header_rule": "#CFCAC2",  # the rule under the header row of a table
    "edge": "#8C8984",  # edges of controls; chart spines
    "accent": "#2B4392",  # ink blue: links, highlighted figures, the series of a single-series chart
    "accent_deep": "#213573",
    "accent_soft": "#E9EDF7",  # highlighted cells
    "warning_text": "#6B4700",  # the bar of a warning is its text colour
    "warning_bg": "#FAEFD7",
    "error_text": "#A8321C",  # the bar of an error is its text colour
    "error_bg": "#FBE6DF",
    "success_text": "#213573",
    "success_bg": "#E9EDF7",
    "success_bar": "#2B4392",
}

#: (text, background) pairs of ``COLOURS`` that the reports use for text.
TEXT_PAIRS: list[tuple[str, str]] = [
    ("ink", "page"), ("ink", "white"), ("ink", "panel"), ("ink", "accent_soft"),
    ("body", "page"), ("body", "white"), ("body", "panel"), ("body", "fill"),
    ("body", "warning_bg"), ("body", "error_bg"), ("body", "success_bg"),
    ("secondary", "page"), ("secondary", "white"), ("secondary", "panel"), ("secondary", "fill"),
    ("tertiary", "page"), ("tertiary", "white"),
    ("accent", "page"), ("accent", "white"), ("accent", "panel"), ("accent", "accent_soft"),
    ("accent_deep", "accent_soft"),
    ("warning_text", "warning_bg"), ("error_text", "error_bg"), ("success_text", "success_bg"),
]

FONT_SERIF = '"Newsreader", "Iowan Old Style", "Palatino Linotype", Georgia, serif'
FONT_MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
#: The serif faces of ``FONT_SERIF`` for matplotlib, which uses the first one installed (or its own
#: default sans when none is; the reports never ship fonts).
CHART_SERIFS = ("Newsreader", "Iowan Old Style", "Palatino Linotype", "Georgia")


def relative_luminance(hex_colour: str) -> float:
    """WCAG 2.1 relative luminance of a colour written as ``#RRGGBB``."""

    def channel(v: int) -> float:
        c = v / 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (int(hex_colour[i:i + 2], 16) for i in (1, 3, 5))
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)


def contrast_ratio(a: str, b: str) -> float:
    """WCAG 2.1 contrast ratio of two ``#RRGGBB`` colours (1 to 21)."""
    la, lb = sorted((relative_luminance(a), relative_luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def chart_font() -> str | None:
    """The first of ``CHART_SERIFS`` that matplotlib can find, or None (then its default applies)."""
    from matplotlib import font_manager

    installed = {f.name for f in font_manager.fontManager.ttflist}
    return next((name for name in CHART_SERIFS if name in installed), None)


_VARIABLES = "".join(f"--{name.replace('_', '-')}:{value};" for name, value in COLOURS.items())

#: The custom properties and the rules for plain elements that every report shares.
BASE_CSS = (
    f":root{{color-scheme:light;{_VARIABLES}--font-serif:{FONT_SERIF};--font-mono:{FONT_MONO}}}"
    "html{background:var(--page)}"
    "body{background:var(--page);color:var(--body);font-family:var(--font-serif);font-size:15.5px;line-height:1.55;"
    "overflow-wrap:break-word;-webkit-font-smoothing:antialiased}"
    "h1,h2,h3,h4{font-family:var(--font-serif);font-weight:400;color:var(--ink)}"
    "h1{font-size:40px;line-height:1;letter-spacing:-0.03em;margin:0 0 14px}"
    "h2{font-size:26px;line-height:1.1;letter-spacing:-0.02em}"
    "h3{font-size:19px;line-height:1.25;letter-spacing:-0.01em}"
    "b,strong{color:var(--ink);font-weight:600}"
    "a{color:var(--accent)}"
    "code,pre{font-family:var(--font-mono)}"
    "code{font-size:.85em;color:var(--ink);background:var(--fill);padding:1px 4px}"
    "pre{font-size:12px;line-height:1.55;color:var(--body);background:var(--white);border:1px solid var(--hairline);"
    "padding:14px 16px;overflow-x:auto}"
    "table{border-collapse:collapse;background:var(--white)}"
    "th{font-size:13px;font-weight:400;line-height:1.35;color:var(--secondary);text-align:left;"
    "vertical-align:bottom;border-bottom:1px solid var(--header-rule)}"
    "td{border-bottom:1px solid var(--hairline)}"
    "td.num{font-family:var(--font-mono);font-size:.94em;font-variant-numeric:tabular-nums}"
    # On a narrow screen a wide table scrolls sideways on its own instead of widening the page.
    "@media (max-width:720px){table{display:block;width:fit-content;max-width:100%;overflow-x:auto}"
    ".scroll table,.wide table{display:table;max-width:none}}"
)
