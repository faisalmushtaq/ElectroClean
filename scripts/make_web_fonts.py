"""Make the browser application's font files (electrotag/web/static/fonts) from the fonts' sources.

The application uses one typeface under the SIL Open Font License 1.1: Newsreader, a serif with
optical sizes, for everything (roman and italic). It is served with the application, so that
annotators' browsers ask no other site for it. This script cuts each variable font down to the
characters the application shows and saves it as woff2, keeping the optical-size axis, the weights
the application uses and its tabular figures. It needs fontTools and brotli
(`pip install fonttools brotli`).

Download the sources from the Google Fonts repository into one folder, then run, for example:

    python scripts/make_web_fonts.py ~/Downloads/fonts electrotag/web/static/fonts

with these files in the source folder (https://github.com/google/fonts, folder ofl/<family>):
``Newsreader[opsz,wght].ttf`` and ``Newsreader-Italic[opsz,wght].ttf``. The family's OFL.txt is kept
beside the fonts as ``Newsreader-OFL.txt``. The family has no Reserved Font Name, so the cut-down fonts
keep their names.
"""
from __future__ import annotations

import sys
from pathlib import Path

UNICODES = (
    "U+0020-007E,U+00A0-00FF,U+0100-017F,U+0192,U+02C6,U+02DA,U+02DC,U+2010-2027,U+2030-203A,U+2044,"
    "U+20AC,U+2122,U+2190-2195,U+2212,U+2264,U+2265,U+2248,U+2260,U+00B5,U+03BC,U+2713,U+2715,U+25A0,U+25CF"
)
# (source, target, axis limits): Newsreader keeps its optical sizes and the weights 400 to 600.
JOBS = [
    ("Newsreader[opsz,wght].ttf", "Newsreader-Variable.woff2", {"wght": (400, 600)}),
    ("Newsreader-Italic[opsz,wght].ttf", "Newsreader-Italic-Variable.woff2", {"wght": (400, 600)}),
]


def main(src: Path, out: Path) -> None:
    from fontTools import subset
    from fontTools.ttLib import TTFont
    from fontTools.varLib import instancer

    out.mkdir(parents=True, exist_ok=True)
    for name, target, pin in JOBS:
        font = TTFont(src / name)
        if pin:
            font = instancer.instantiateVariableFont(font, pin)
        opts = subset.Options()
        opts.flavor = "woff2"
        opts.layout_features = ["kern", "liga", "calt", "tnum", "case", "ccmp", "locl", "mark", "mkmk"]
        opts.name_IDs = ["*"]
        opts.notdef_outline = True
        sub = subset.Subsetter(opts)
        sub.populate(unicodes=subset.parse_unicodes(UNICODES))
        sub.subset(font)
        font.flavor = "woff2"
        font.save(out / target)
        print(f"{target}: {(out / target).stat().st_size:,} bytes")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(Path(sys.argv[1]), Path(sys.argv[2]))
