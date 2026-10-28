"""Make the browser application's font files (electroclean/web/static/fonts) from the fonts' sources.

The application uses three typefaces under the SIL Open Font License 1.1: Space Grotesk for headings,
Instrument Sans for text and JetBrains Mono for labels and figures. They are served with the
application, so that annotators' browsers ask no other site for them. This script cuts each variable
font down to the characters the application shows and saves it as woff2, keeping the weight axis
(Instrument Sans at its normal width). It needs fontTools and brotli (`pip install fonttools brotli`).

Download the sources from the Google Fonts repository into one folder, then run, for example:

    python scripts/make_web_fonts.py ~/Downloads/fonts electroclean/web/static/fonts

with these files in the source folder (https://github.com/google/fonts, folder ofl/<family>):
``SpaceGrotesk[wght].ttf``, ``JetBrainsMono[wght].ttf`` and ``InstrumentSans[wdth,wght].ttf``.
Each family's OFL.txt is kept beside its font as ``<Family>-OFL.txt``. None of the three has a Reserved
Font Name, so the cut-down fonts keep their names.
"""
from __future__ import annotations

import sys
from pathlib import Path

UNICODES = (
    "U+0020-007E,U+00A0-00FF,U+0100-017F,U+0192,U+02C6,U+02DA,U+02DC,U+2010-2027,U+2030-203A,U+2044,"
    "U+20AC,U+2122,U+2190-2195,U+2212,U+2264,U+2265,U+2248,U+2260,U+00B5,U+03BC,U+2713,U+2715,U+25A0,U+25CF"
)
JOBS = [
    ("SpaceGrotesk[wght].ttf", "SpaceGrotesk-Variable.woff2", {}),
    ("JetBrainsMono[wght].ttf", "JetBrainsMono-Variable.woff2", {}),
    ("InstrumentSans[wdth,wght].ttf", "InstrumentSans-Variable.woff2", {"wdth": 100}),
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
