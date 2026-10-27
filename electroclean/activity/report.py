"""A self-contained HTML report of annotator activity with learning curves.

Charts are inline SVG (no external files or scripts), drawn with the reference data-visualisation
palette: one colour per annotator in a fixed order, a 2 px line with 8 px markers, hairline
gridlines, a legend for two or more annotators, direct labels at the line ends when they do not
collide, and a crosshair with a tooltip on hover. With more than eight annotators, every annotator
is drawn in grey and the median across annotators carries the colour. Every value is also in the
tables below the charts.
"""

from __future__ import annotations

import html
import json
import math
from datetime import datetime
from statistics import median
from typing import Any

from electroclean import __version__
from electroclean.activity.summary import ActivityTables

#: Categorical slots (light, dark): the validated reference palette, in its fixed order.
SERIES = [("#2a78d6", "#3987e5"), ("#eb6834", "#d95926"), ("#1baf7a", "#199e70"), ("#eda100", "#c98500"),
          ("#e87ba4", "#d55181"), ("#008300", "#008300"), ("#6250d6", "#9085e9"), ("#e34948", "#e66767")]

W, H = 760, 300
ML, MR, MT, MB = 58, 140, 16, 46


def _esc(x: Any) -> str:
    return html.escape(str(x), quote=True)


def _fmt(v: Any, digits: int = 1) -> str:
    if v is None or v == "":
        return ""
    if isinstance(v, float):
        if math.isnan(v):
            return ""
        return f"{v:,.{digits}f}"
    return _esc(v)


def _nice_max(v: float) -> tuple[float, float]:
    """A round upper limit and tick step for an axis from 0 to ``v``."""
    if v <= 0 or math.isnan(v):
        return 1.0, 0.25
    raw = v / 4
    mag = 10 ** math.floor(math.log10(raw))
    step = next(m * mag for m in (1, 2, 2.5, 5, 10) if m * mag >= raw)
    return step * math.ceil(v / step), step


def _num(v: Any) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return float("nan")


def _tick(v: float) -> str:
    return f"{v:,.0f}" if abs(v - round(v)) < 1e-9 else f"{v:,.2f}".rstrip("0").rstrip(".")


def line_chart(chart_id: str, series: list[dict[str, Any]], *, unit: str, digits: int = 1,
               y_max: float | None = None) -> str:
    """SVG learning curve: x is the order in which recordings were done, y one measure.

    ``series``: dicts with ``name``, ``points`` [(order, value, recording)] and optionally ``kind``
    ("median"). Returns the SVG plus a tooltip element; the script at the end of the page adds the
    crosshair."""
    pts = [(x, y) for s in series for x, y, _r in s["points"] if not math.isnan(y)]
    if not pts:
        return ""
    max_x = max(x for x, _ in pts)
    top, step = _nice_max(y_max if y_max is not None else max(y for _, y in pts) * 1.05)
    x0, x1 = (0.5, 1.5) if max_x <= 1 else (1, max_x)
    pw, ph = W - ML - MR, H - MT - MB

    def sx(x: float) -> float:
        return ML + (x - x0) / (x1 - x0) * pw

    def sy(y: float) -> float:
        return MT + ph - (y / top) * ph

    out = [f'<svg class="chart" id="{chart_id}" viewBox="0 0 {W} {H}" role="img" '
           f'aria-label="{_esc(unit)} by recording order">']
    n_ticks = int(round(top / step))
    for i in range(n_ticks + 1):
        v = i * step
        y = sy(v)
        cls = "axis" if i == 0 else "grid"
        out.append(f'<line class="{cls}" x1="{ML}" x2="{ML + pw}" y1="{y:.1f}" y2="{y:.1f}"/>')
        out.append(f'<text class="tick" x="{ML - 8}" y="{y + 4:.1f}" text-anchor="end">{_tick(v)}</text>')
    every = max(1, math.ceil(max_x / 12))
    for x in range(1, max_x + 1):
        if (x - 1) % every == 0 or x == max_x:
            out.append(f'<text class="tick" x="{sx(x):.1f}" y="{MT + ph + 18}" text-anchor="middle">{x}</text>')
    out.append(f'<text class="axislabel" x="{ML + pw / 2:.1f}" y="{H - 8}" text-anchor="middle">'
               'Recording, in the order each annotator did them (1 = first)</text>')
    many = sum(1 for s in series if s.get("kind") != "median") > len(SERIES)
    ends: list[tuple[float, str, str]] = []
    data = []
    slot = 0
    series = sorted(series, key=lambda s: s.get("kind") != "median")  # the median band goes underneath
    for s in series:
        p = [(x, y, r) for x, y, r in s["points"] if not math.isnan(y)]
        if not p:
            continue
        if s.get("kind") == "median":
            cls = "median"
        elif many:
            cls = "muted"
        else:
            cls = f"s{slot % len(SERIES) + 1}"
            slot += 1
        d = " ".join(f"{'M' if i == 0 else 'L'}{sx(x):.1f},{sy(y):.1f}" for i, (x, y, _r) in enumerate(p))
        out.append(f'<path class="line {cls}" d="{d}"/>')
        if cls == "median":
            data.append({"name": s["name"], "cls": cls, "points": [[x, round(y, 4)] for x, y, _r in p]})
            continue
        for x, y, r in p:
            tip = f"{s['name']}: {_fmt(y, digits)} {unit} (recording {x}{', ' + r if r else ''})"
            out.append(f'<circle class="dot {cls}" cx="{sx(x):.1f}" cy="{sy(y):.1f}" r="4"/>')
            out.append(f'<circle class="hit" cx="{sx(x):.1f}" cy="{sy(y):.1f}" r="10"><title>{_esc(tip)}</title></circle>')
        ends.append((sy(p[-1][1]), s["name"], f"{sx(p[-1][0]) + 9:.1f}"))
        data.append({"name": s["name"], "cls": cls, "points": [[x, round(y, 4)] for x, y, _r in p]})
    # Direct end labels, only when there are few lines and the labels do not collide (never nudged).
    ys = sorted(y for y, _n, _x in ends)
    if 1 < len(ends) <= 4 and all(b - a >= 14 for a, b in zip(ys, ys[1:])):
        for y, name, x in ends:
            out.append(f'<text class="endlabel" x="{x}" y="{y + 4:.1f}">{_esc(name)}</text>')
    out.append(f'<line class="crosshair" x1="0" x2="0" y1="{MT}" y2="{MT + ph}" visibility="hidden"/>')
    out.append("</svg>")
    meta = {"x0": x0, "x1": x1, "ml": ML, "pw": pw, "w": W, "unit": unit, "digits": digits, "series": data}
    out.append(f'<div class="tooltip" hidden></div><script type="application/json" class="chart-data">'
               f"{json.dumps(meta)}</script>")
    return "".join(out)


def _legend(names: list[str], many: bool, with_median: bool) -> str:
    items = []
    if many:
        items.append('<li><span class="key muted"></span>Each annotator (hover for names; see the table)</li>')
    else:
        for i, n in enumerate(names):
            items.append(f'<li><span class="key s{i % len(SERIES) + 1}"></span>{_esc(n)}</li>')
    if with_median:
        items.append('<li><span class="key median"></span>Median across annotators (grey band)</li>')
    return f'<ul class="legend">{"".join(items)}</ul>'


def _curves(rows: list[dict[str, Any]], measure: str, *, scale: float = 1.0) -> tuple[list[dict[str, Any]], list[str]]:
    by_ann: dict[str, list[tuple[int, float, str]]] = {}
    for r in rows:
        v = _num(r.get(measure)) * scale
        if math.isnan(v):
            continue
        by_ann.setdefault(r["annotator_id"], []).append((0, v, r.get("recording", "")))
    # Re-number each annotator's points 1..n in their own order, so the curves line up.
    series = []
    for ann in sorted(by_ann):
        pts = [(i + 1, v, rec) for i, (_o, v, rec) in enumerate(by_ann[ann])]
        series.append({"name": ann, "points": pts})
    names = [s["name"] for s in series]
    if len(series) >= 2:
        n = max(len(s["points"]) for s in series)
        med = []
        for x in range(1, n + 1):
            vals = [y for s in series for xx, y, _r in s["points"] if xx == x]
            if len(vals) >= 2:
                med.append((x, median(vals), f"{len(vals)} annotators"))
        if med:
            series.append({"name": "Median", "kind": "median", "points": med})
    return series, names


CHARTS = [
    ("active_minutes", "active_s", 1 / 60, "min", "Active minutes per recording",
     "Time spent on each finished recording, leaving out idle periods. A falling curve means annotators got faster."),
    ("seconds_per_annotation", "seconds_per_annotation", 1.0, "s", "Seconds per annotation",
     "Active time on a finished recording divided by the annotations saved in it."),
    ("score", "score", 1.0, "", "Training score",
     "Score against the reference: practice F1, or the proportion of quiz answers that were correct."),
]


def _change_table(rows: list[dict[str, Any]]) -> str:
    """Per annotator: the first three finished recordings against the last three."""
    by_ann: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        by_ann.setdefault(r["annotator_id"], []).append(r)
    body = []
    for ann in sorted(by_ann):
        rs = by_ann[ann]
        mins = [_num(r["active_s"]) / 60 for r in rs]
        spa = [_num(r["seconds_per_annotation"]) for r in rs if not math.isnan(_num(r["seconds_per_annotation"]))]
        k = min(3, len(spa) // 2)
        first = median(spa[:k]) if k else float("nan")
        last = median(spa[-k:]) if k else float("nan")
        change = (last - first) / first * 100 if k and first > 0 else float("nan")
        body.append(f"<tr><td>{_esc(ann)}</td><td>{len(rs)}</td><td>{_fmt(sum(mins), 1)}</td>"
                    f"<td>{_fmt(first, 1)}</td><td>{_fmt(last, 1)}</td><td>{_fmt(change, 0)}</td></tr>")
    return ("<table><thead><tr><th>Annotator</th><th>Finished recordings</th><th>Active minutes</th>"
            "<th>Seconds per annotation, first recordings</th><th>Seconds per annotation, last recordings</th>"
            "<th>Change (%)</th></tr></thead><tbody>" + "".join(body) + "</tbody></table>")


ROW_COLUMNS = [("annotator_id", "Annotator"), ("order", "Order"), ("mode", "Mode"), ("recording", "Recording"),
               ("outcome", "Outcome"), ("active_s", "Active (s)"), ("wall_s", "Wall (s)"), ("clicks", "Clicks"),
               ("key_presses", "Keys"), ("shortcuts", "Shortcuts"), ("annotations_created", "Created"),
               ("final_annotations", "Saved"), ("seconds_per_annotation", "s per annotation"),
               ("share_seen", "Share seen"), ("undos", "Undos"), ("score", "Score")]


def report_html(tables: ActivityTables, *, files: dict[str, str] | None = None) -> str:
    rows = tables.recordings
    finished = [r for r in rows if r["segment"] == "recording" and r["outcome"] == "finished"]
    annotators = sorted({r["annotator_id"] for r in rows} | {v["annotator_id"] for v in tables.visits})
    active_h = sum(_num(v["active_s"]) for v in tables.visits) / 3600
    saved = sum(int(v["annotations_saved"] or 0) for v in tables.visits)
    tiles = [("Annotators", len(annotators)), ("Visits", len(tables.visits)),
             ("Recordings finished", len(finished)), ("Active hours", f"{active_h:,.1f}"),
             ("Annotations saved", f"{saved:,}")]
    parts = [f'<div class="tiles">{"".join(f"<div class=tile><div class=label>{_esc(a)}</div><div class=value>{_esc(b)}</div></div>" for a, b in tiles)}</div>']
    charts = []
    for cid, measure, scale, unit, title, sub in CHARTS:
        source = [r for r in rows if r["segment"] in ("recording", "quiz")] if measure == "score" else finished
        series, names = _curves(source, measure, scale=scale)
        if not any(s["points"] for s in series):
            continue
        many = len(names) > len(SERIES)
        with_median = any(s.get("kind") == "median" for s in series)
        legend = _legend(names, many, with_median) if len(names) >= 2 else ""
        svg = line_chart(cid, series, unit=unit or "", digits=2 if measure == "score" else 1,
                         y_max=1.0 if measure == "score" else None)
        charts.append(f'<section class="card"><h2>{_esc(title)}</h2><p class="sub">{_esc(sub)}</p>{legend}'
                      f'<div class="plot">{svg}</div></section>')
    if charts:
        parts += charts
    else:
        parts.append('<section class="card"><p>No finished recordings yet, so there are no learning curves.</p></section>')
    if finished:
        parts.append(f'<section class="card"><h2>First and last recordings</h2><p class="sub">For each annotator, the '
                     "median seconds per annotation over their first finished recordings (up to three) and over their "
                     "last ones (the same number). A negative change means they got faster.</p>"
                     f"{_change_table(finished)}</section>")
    head = "".join(f"<th>{_esc(h)}</th>" for _c, h in ROW_COLUMNS)
    body = []
    for r in rows:
        cells = []
        for c, _h in ROW_COLUMNS:
            v = r.get(c)
            digits = 2 if c in ("score", "share_seen") else 1
            if c == "recording":
                short = str(v).rsplit("/", 1)[-1]
                cells.append(f'<td class="rec" title="{_esc(v)}">{_esc(short)}</td>')
                continue
            cells.append(f"<td>{_fmt(v, digits) if isinstance(v, float) else _esc(v)}</td>")
        body.append(f"<tr>{''.join(cells)}</tr>")
    parts.append(f'<section class="card"><h2>Every recording</h2><p class="sub">One row per annotator, recording and '
                 "visit. All the columns are in recordings.tsv.</p><div class=scroll><table><thead><tr>"
                 f"{head}</tr></thead><tbody>{''.join(body)}</tbody></table></div></section>")
    if tables.warnings:
        parts.append('<section class="card"><h2>Notes on the logs</h2><ul>'
                     + "".join(f"<li>{_esc(w)}</li>" for w in tables.warnings) + "</ul></section>")
    if files:
        parts.append('<section class="card"><h2>Files</h2><ul>'
                     + "".join(f"<li><b>{_esc(k)}</b>: {_esc(v)}</li>" for k, v in files.items()) + "</ul></section>")
    stamp = datetime.now().astimezone().isoformat(timespec="minutes")
    return _PAGE.format(
        title="Annotator activity and learning curves",
        subtitle=_esc(f"{len(tables.visits)} visit log(s) · generated {stamp} · ElectroClean {__version__}"),
        intro=("Active time leaves out idle periods (gaps between inputs longer than the idle threshold, 30 s by "
               "default, count only that much) and time when ElectroClean was not the active application. "
               "Order counts each annotator's recordings in the order they were started, across visits."),
        body="".join(parts),
        css=_css(),
        script=_SCRIPT,
    )


def _css() -> str:
    light = "".join(f"--series-{i + 1}:{lt};" for i, (lt, _dk) in enumerate(SERIES))
    dark = "".join(f"--series-{i + 1}:{dk};" for i, (_lt, dk) in enumerate(SERIES))
    series_rules = "".join(
        f".line.s{i + 1}{{stroke:var(--series-{i + 1})}}.dot.s{i + 1}{{fill:var(--series-{i + 1})}}"
        f".key.s{i + 1}{{background:var(--series-{i + 1})}}" for i in range(len(SERIES)))
    dark_vars = (f"color-scheme:dark;--surface-1:#1a1a19;--page:#0d0d0d;--text-primary:#f0efec;--text-secondary:#c3c2b7;"
                 f"--muted:#898781;--grid:#2c2c2a;--axis:#383835;--border:rgba(255,255,255,.10);--tip:#2c2c2a;{dark}")
    return (
        ":root{color-scheme:light;--surface-1:#fcfcfb;--page:#f9f9f7;--text-primary:#0b0b0b;--text-secondary:#52514e;"
        f"--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;--border:rgba(11,11,11,.10);--tip:#ffffff;{light}}}"
        f"@media (prefers-color-scheme:dark){{:root:not([data-theme=\"light\"]){{{dark_vars}}}}}"
        f":root[data-theme=\"dark\"]{{{dark_vars}}}"
        "body{margin:0;background:var(--page);color:var(--text-primary);font:15px/1.5 system-ui,-apple-system,"
        "\"Segoe UI\",sans-serif}main{max-width:1000px;margin:0 auto;padding:24px 16px 48px}"
        "h1{font-size:26px;margin:0 0 4px}h2{font-size:17px;margin:0 0 4px}.sub,.subtitle{color:var(--text-secondary);"
        "margin:0 0 12px}.card{background:var(--surface-1);border:1px solid var(--border);border-radius:10px;"
        "padding:16px 18px;margin:16px 0}.tiles{display:flex;flex-wrap:wrap;gap:12px;margin:16px 0}"
        ".tile{background:var(--surface-1);border:1px solid var(--border);border-radius:10px;padding:10px 16px;"
        "min-width:140px}.tile .label{color:var(--text-secondary);font-size:13px}.tile .value{font-size:24px;"
        "font-weight:600}.plot{position:relative}svg.chart{width:100%;height:auto;display:block;overflow:visible}"
        ".grid{stroke:var(--grid);stroke-width:1}.axis{stroke:var(--axis);stroke-width:1}"
        ".tick{fill:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}.axislabel{fill:var(--text-secondary);"
        "font-size:12px}.endlabel{fill:var(--text-secondary);font-size:12px}"
        ".line{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}.dot{stroke:var(--surface-1);"
        "stroke-width:2}.hit{fill:transparent}.line.median{stroke:var(--text-primary);stroke-width:8;opacity:.14}"
        ".line.muted{stroke:var(--muted);stroke-width:1.5}.dot.muted{fill:var(--muted)}"
        ".crosshair{stroke:var(--axis);stroke-width:1}"
        f"{series_rules}"
        ".legend{list-style:none;padding:0;margin:0 0 8px;display:flex;flex-wrap:wrap;gap:4px 16px;"
        "color:var(--text-secondary);font-size:13px}.key{display:inline-block;width:14px;height:3px;border-radius:2px;"
        "margin-right:6px;vertical-align:middle}.key.median{background:var(--text-primary);height:8px;opacity:.25}.key.muted{background:var(--muted)}"
        ".tooltip{position:absolute;pointer-events:none;background:var(--tip);color:var(--text-primary);"
        "border:1px solid var(--border);border-radius:6px;padding:6px 8px;font-size:12px;box-shadow:0 2px 8px "
        "rgba(0,0,0,.12);white-space:nowrap}.tooltip .row{display:flex;align-items:center;gap:6px}"
        "table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:5px 8px;"
        "border-bottom:1px solid var(--grid);font-variant-numeric:tabular-nums}th{color:var(--text-secondary);"
        "font-weight:600}.scroll{overflow-x:auto}td.rec{white-space:nowrap}"
    )


_SCRIPT = """
for (const plot of document.querySelectorAll('.plot')) {
  const svg = plot.querySelector('svg'); const tip = plot.querySelector('.tooltip');
  const dataEl = plot.querySelector('.chart-data'); if (!svg || !tip || !dataEl) continue;
  const meta = JSON.parse(dataEl.textContent); const cross = svg.querySelector('.crosshair');
  const toX = x => meta.ml + (x - meta.x0) / (meta.x1 - meta.x0) * meta.pw;
  svg.addEventListener('mousemove', ev => {
    const box = svg.getBoundingClientRect(); const sx = (ev.clientX - box.left) / box.width * meta.w;
    const x = Math.round(meta.x0 + (sx - meta.ml) / meta.pw * (meta.x1 - meta.x0));
    const rows = meta.series.map(s => [s, s.points.find(p => p[0] === x)]).filter(r => r[1]);
    if (!rows.length) { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); return; }
    cross.setAttribute('x1', toX(x)); cross.setAttribute('x2', toX(x)); cross.setAttribute('visibility', 'visible');
    tip.innerHTML = '<b>Recording ' + x + '</b>' + rows.map(([s, p]) =>
      '<div class="row"><span class="key ' + s.cls + '"></span>' + s.name.replace(/[&<>]/g, '') + ': ' +
      p[1].toFixed(meta.digits) + ' ' + meta.unit + '</div>').join('');
    tip.hidden = false;
    const px = toX(x) / meta.w * box.width;
    tip.style.left = Math.min(px + 12, box.width - tip.offsetWidth - 4) + 'px'; tip.style.top = '8px';
  });
  svg.addEventListener('mouseleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); });
}
"""

_PAGE = """<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Annotator activity</title><style>{css}</style></head>
<body><main><h1>{title}</h1><p class="subtitle">{subtitle}</p><p class="sub">{intro}</p>
{body}</main><script>{script}</script></body></html>
"""
