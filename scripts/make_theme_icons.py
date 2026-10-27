"""Draw the small chevrons used by drop-down menus and number boxes (electroclean/app/gui/icons).

    QT_QPA_PLATFORM=offscreen python scripts/make_theme_icons.py

PNG rather than SVG, so the stand-alone applications need no SVG image plugin. Each icon is
drawn at 1x and 2x (``@2x``, picked automatically on high-resolution screens).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

os.environ.setdefault("QT_API", "pyside6")
REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))


def main() -> int:
    from qtpy.QtCore import QPointF, Qt
    from qtpy.QtGui import QColor, QImage, QPainter, QPainterPath, QPen
    from qtpy.QtWidgets import QApplication

    from electroclean.app.gui.style import COLOURS

    app = QApplication.instance() or QApplication([])  # noqa: F841 - painting needs an application
    out = REPO / "electroclean" / "app" / "gui" / "icons"
    out.mkdir(parents=True, exist_ok=True)
    for name, colour in (("", COLOURS["text_secondary"]), ("-disabled", COLOURS["text_disabled"])):
        for direction in ("down", "up"):
            for scale, suffix in ((1, ""), (2, "@2x")):
                size = 10 * scale
                img = QImage(size, size, QImage.Format_ARGB32)
                img.fill(Qt.transparent)
                p = QPainter(img)
                p.setRenderHint(QPainter.Antialiasing)
                pen = QPen(QColor(colour), 1.6 * scale)
                pen.setCapStyle(Qt.RoundCap)
                pen.setJoinStyle(Qt.RoundJoin)
                p.setPen(pen)
                path = QPainterPath()
                top, bottom = 3.3 * scale, 6.7 * scale
                y0, y1 = (top, bottom) if direction == "down" else (bottom, top)
                path.moveTo(QPointF(2.0 * scale, y0))
                path.lineTo(QPointF(5.0 * scale, y1))
                path.lineTo(QPointF(8.0 * scale, y0))
                p.drawPath(path)
                p.end()
                target = out / f"chevron-{direction}{name}{suffix}.png"
                img.save(str(target))
                print("saved", target.relative_to(REPO))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
