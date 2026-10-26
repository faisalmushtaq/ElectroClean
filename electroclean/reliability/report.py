"""Readable HTML report for an agreement analysis.

Figures are static PNG images (matplotlib) embedded in the page, each
accompanied by the table it was drawn from. Colours: the first three slots of
a colour-blind-validated categorical palette for the three agreement measures,
and a single-hue blue ramp for heat maps. Category identity in timelines is
carried by labelled rows, not by colour.
"""

from __future__ import annotations

import base64
import html
import io
import json
from typing import Any

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from matplotlib.colors import LinearSegmentedColormap  # noqa: E402

from electroclean.reliability.config import ANY_ARTIFACT  # noqa: E402

SERIES = ["#2a78d6", "#eb6834", "#1baf7a"]
BLUE_RAMP = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"]
INK = "#0b0b0b"
INK_2 = "#52514e"
GRID = "#e4e3df"
CMAP = LinearSegmentedColormap.from_list("ec_blue", BLUE_RAMP)

POOLED = "ALL (pooled)"


def _style(ax: Any) -> None:
    ax.spines[["top", "right"]].set_visible(False)
    ax.spines[["left", "bottom"]].set_color(GRID)
    ax.tick_params(colors=INK_2, labelsize=9)
    ax.grid(axis="x", color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)


def _png(fig: Any) -> str:
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=110, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def _img(src: str, alt: str) -> str:
    return f'<figure><img src="{src}" alt="{html.escape(alt)}"><figcaption>{html.escape(alt)}</figcaption></figure>'


def _table(df: pd.DataFrame, max_rows: int = 400) -> str:
    if df is None or df.empty:
        return "<p class='muted'>No data.</p>"
    shown = df.head(max_rows).copy()
    shown.columns = [str(c) for c in shown.columns]
    shown.columns.name = None
    out = shown.to_html(
        index=False, float_format=lambda x: f"{0.0 if abs(x) < 5e-4 else x:.3f}", na_rep="n/a", border=0, classes="data"
    )
    if len(df) > max_rows:
        out += f"<p class='muted'>First {max_rows} of {len(df)} rows; see the TSV file for all.</p>"
    return out


def _present_categories(result: Any) -> list[str]:
    d = result.tables.get("descriptives_annotations_by_annotator")
    if d is None or d.empty:
        return []
    order = list(result.dataset.catalogue.label_names)
    present = set(d["category"])
    return [c for c in order if c in present]


# ------------------------------------------------------------------ figures
def fig_category_agreement(summary: pd.DataFrame) -> str | None:
    if summary.empty:
        return None
    cats = list(summary["category"])[::-1]
    y = np.arange(len(cats))
    fig, ax = plt.subplots(figsize=(7.5, 0.38 * len(cats) + 1.2))
    for i, (col, name) in enumerate(
        [("cohen_kappa", "Cohen's kappa"), ("positive_agreement", "Positive agreement"), ("negative_agreement", "Negative agreement")]
    ):
        vals = summary.set_index("category").loc[cats, col].to_numpy(dtype=float)
        ax.scatter(vals, y + (i - 1) * 0.18, s=46, color=SERIES[i], label=name, zorder=3,
                   edgecolors="white", linewidths=1.5)
    ax.set_yticks(y, cats, color=INK)
    ax.set_xlim(-0.25, 1.02)
    ax.axvline(0, color=GRID, linewidth=1)
    ax.set_xlabel("Agreement (pooled over recordings, mean over annotator pairs)", color=INK_2)
    _style(ax)
    ax.legend(loc="lower center", bbox_to_anchor=(0.5, 1.0), ncol=3, frameon=False, fontsize=9)
    return _png(fig)


def fig_pair_heatmap(df: pd.DataFrame, value: str, title: str, order: list[str] | None = None) -> str | None:
    if df.empty:
        return None
    piv = df.pivot_table(index="pair", columns="category", values=value, aggfunc="mean", dropna=False)
    if order:
        piv = piv.reindex(columns=[c for c in order if c in piv.columns])
    fig, ax = plt.subplots(figsize=(max(6, 0.55 * piv.shape[1] + 2.5), 0.45 * piv.shape[0] + 1.6))
    data = piv.to_numpy(dtype=float)
    im = ax.imshow(np.ma.masked_invalid(data), cmap=CMAP, vmin=0, vmax=1, aspect="auto")
    ax.set_xticks(range(piv.shape[1]), piv.columns, rotation=45, ha="right", fontsize=8, color=INK)
    ax.set_yticks(range(piv.shape[0]), piv.index, fontsize=9, color=INK)
    for (i, j), v in np.ndenumerate(data):
        txt = "n/a" if np.isnan(v) else f"{v:.2f}"
        colour = "white" if (not np.isnan(v) and v > 0.55) else INK
        ax.text(j, i, txt, ha="center", va="center", fontsize=8, color=colour)
    ax.set_title(title, fontsize=10, color=INK, loc="left")
    cb = fig.colorbar(im, ax=ax, fraction=0.03, pad=0.02)
    cb.ax.tick_params(labelsize=8, colors=INK_2)
    for s in ax.spines.values():
        s.set_visible(False)
    return _png(fig)


def fig_f1_vs_threshold(ev: pd.DataFrame) -> str | None:
    micro = ev[ev["category"] == "ALL categories (micro-average)"]
    if micro.empty or micro["threshold"].isna().all():
        return None
    fig, ax = plt.subplots(figsize=(6.5, 3.2))
    ends = []
    for i, (mode, grp) in enumerate(micro.groupby("channel_mode", sort=True)):
        g = grp.groupby("threshold")["f1"].mean()
        ax.plot(g.index, g.values, color=SERIES[i], linewidth=2, marker="o", markersize=7,
                markeredgecolor="white", markeredgewidth=1.5, label=mode.replace("_", " "))
        ends.append((float(g.values[-1]), float(g.index[-1]), mode.replace("_", " ")))
    # Direct labels at the line ends, nudged apart when the lines finish close together.
    ends.sort()
    for k, (yv, xv, text) in enumerate(ends):
        close = len(ends) > 1 and abs(ends[-1][0] - ends[0][0]) < 0.06
        dy = (-7 if k == 0 else 7) if close else 0
        ax.annotate(text, (xv, yv), xytext=(8, dy), textcoords="offset points", fontsize=8, color=INK_2, va="center")
    ax.set_xlabel("Minimum IoU for a match (0 = any overlap)", color=INK_2)
    ax.set_ylabel("F1 (micro-average, mean over pairs)", color=INK_2)
    ax.set_ylim(0, 1.02)
    _style(ax)
    ax.grid(axis="y", color=GRID, linewidth=0.8)
    ax.legend(frameon=False, fontsize=9, loc="lower left")
    return _png(fig)


def fig_timing(matched: pd.DataFrame, order: list[str] | None = None) -> str | None:
    if matched.empty:
        return None
    present = set(matched["category"].unique())
    cats = [c for c in (order or sorted(present)) if c in present and c != ANY_ARTIFACT]
    if not cats:
        return None
    fig, axes = plt.subplots(1, 2, figsize=(9, 0.42 * len(cats) + 1.4), sharey=True)
    for ax, col, title in ((axes[0], "onset_diff_s", "Onset difference (s)"), (axes[1], "offset_diff_s", "Offset difference (s)")):
        data = [matched.loc[matched["category"] == c, col].to_numpy() for c in cats]
        bp = ax.boxplot(data, orientation="horizontal", widths=0.5, patch_artist=True, showfliers=True,
                        medianprops={"color": INK, "linewidth": 1.5},
                        boxprops={"facecolor": BLUE_RAMP[1], "edgecolor": BLUE_RAMP[4]},
                        whiskerprops={"color": BLUE_RAMP[4]}, capprops={"color": BLUE_RAMP[4]},
                        flierprops={"markerfacecolor": BLUE_RAMP[4], "markeredgecolor": "white", "markersize": 5})
        del bp
        ax.axvline(0, color=INK_2, linewidth=1)
        ax.set_title(title, fontsize=10, color=INK, loc="left")
        _style(ax)
    axes[0].set_yticks(range(1, len(cats) + 1), cats, fontsize=9, color=INK)
    axes[0].invert_yaxis()  # first category at the top, as in the tables
    return _png(fig)


def fig_timeline(group: Any, cats: list[str]) -> str | None:
    rows: list[tuple[str, str]] = []
    for c in cats:
        for aid in group.annotators:
            rows.append((c, aid))
    rows = [(c, a) for c, a in rows if any(x.label == c for x in group.docs[a].annotations)] or []
    used_cats = sorted({c for c, _ in rows}, key=cats.index)
    rows = [(c, a) for c in used_cats for a in group.annotators]
    if not rows:
        return None
    sf = group.timing.sfreq
    fig, ax = plt.subplots(figsize=(10, 0.28 * len(rows) + 1.2))
    for y, (c, a) in enumerate(rows):
        for ann in group.docs[a].annotations:
            if ann.label != c:
                continue
            colour = BLUE_RAMP[4] if ann.is_global else BLUE_RAMP[2]
            ax.barh(y, ann.duration_samples / sf, left=ann.onset_sample / sf, height=0.62, color=colour,
                    edgecolor="white", linewidth=0.5)
    labels = [f"{c} · {a}" for c, a in rows]
    ax.set_yticks(range(len(rows)), labels, fontsize=7.5, color=INK)
    ax.invert_yaxis()
    ax.set_xlim(0, group.timing.duration_s)
    ax.set_xlabel("Time (s)", color=INK_2)
    prev = None
    for y, (c, _a) in enumerate(rows):
        if prev is not None and c != prev:
            ax.axhline(y - 0.5, color=GRID, linewidth=1)
        prev = c
    _style(ax)
    ax.set_title(f"{group.recording_id}  (dark = whole montage, light = selected channels)", fontsize=9,
                 color=INK, loc="left")
    return _png(fig)


# -------------------------------------------------------------------- page
CSS = """
body { font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #0b0b0b;
       background: #fcfcfb; max-width: 1150px; margin: 2em auto; padding: 0 1em; line-height: 1.45; }
h1 { font-size: 1.6em; } h2 { margin-top: 2em; border-bottom: 1px solid #e4e3df; padding-bottom: .2em; }
table.data { border-collapse: collapse; font-size: 12.5px; margin: .6em 0; }
table.data th { background: #f1f0ec; text-align: left; padding: 4px 8px; position: sticky; top: 0; }
table.data td { padding: 3px 8px; border-top: 1px solid #ecebe7; font-variant-numeric: tabular-nums; }
.muted { color: #52514e; font-size: .92em; } .box { background: #f4f7fb; border-left: 4px solid #2a78d6;
       padding: .6em 1em; margin: 1em 0; } figure { margin: 1em 0; } figure img { max-width: 100%; }
figcaption { color: #52514e; font-size: .9em; } code { background: #f1f0ec; padding: 0 3px; }
details { margin: .6em 0; } .scroll { max-height: 420px; overflow: auto; }
"""


def build_html_report(result: Any) -> str:
    cfg = result.config
    tables = result.tables
    tr = tables.get("timeresolved_pairwise", pd.DataFrame())
    mr = tables.get("timeresolved_multirater", pd.DataFrame())
    ev = tables.get("events_summary", pd.DataFrame())
    matched = tables.get("events_matched", pd.DataFrame())
    present = _present_categories(result)
    show_cats = present + ([ANY_ARTIFACT] if cfg.include_any_artifact else [])
    parts: list[str] = []
    add = parts.append
    add("<!DOCTYPE html><html lang='en'><head><meta charset='utf-8'>")
    add("<meta name='viewport' content='width=device-width, initial-scale=1'>")
    add(f"<title>Agreement report</title><style>{CSS}</style></head><body>")
    rec = result.settings_record
    add("<h1>Inter-rater agreement report</h1>")
    add(
        f"<p class='muted'>{html.escape(rec.get('generated_by', ''))} · {len(result.dataset.groups)} recording(s) · "
        f"annotators: {html.escape(', '.join(result.dataset.annotators))} · label catalogue "
        f"{html.escape(result.dataset.catalogue.catalogue_id)} {html.escape(result.dataset.catalogue.catalogue_version)}</p>"
    )
    add(
        "<div class='box'><b>How to read this report.</b> Agreement is reported along three dimensions: "
        "<i>category</i> (do annotators use the same artifact type?), <i>time</i> (do they mark the same parts of the "
        "recording?) and <i>channels</i> (do they mark the same channels?). Most EEG is clean, so two annotators agree "
        "on most of the recording simply by both leaving it unmarked. Overall proportion agreement is therefore "
        "dominated by clean data and is not a useful headline. Read <b>positive agreement</b> (agreement about where "
        "artifacts are) together with <b>negative agreement</b> and <b>kappa</b>, the <b>prevalence</b> of each "
        "category, and the event-based <b>F1</b>, rather than any single number. Kappa is low when a category is rare "
        "even if annotators mostly agree (see the prevalence and bias indices). Units of time are not independent, "
        "so no confidence intervals are given for time-resolved statistics.</div>"
    )
    warnings = rec.get("warnings", [])
    if warnings:
        add("<h2>Warnings</h2><ul>" + "".join(f"<li>{html.escape(w)}</li>" for w in warnings) + "</ul>")

    # Overview
    add("<h2>1. Recordings and annotations</h2>")
    add(_table(tables.get("descriptives_recordings", pd.DataFrame())))
    d = tables.get("descriptives_annotations_by_annotator", pd.DataFrame())
    if not d.empty:
        order = [c for c in result.dataset.catalogue.label_names if c in set(d.category)]
        piv = d.pivot_table(index="category", columns="annotator", values="n_annotations", aggfunc="sum", fill_value=0)
        dur = d.pivot_table(index="category", columns="annotator", values="total_duration_s", aggfunc="sum", fill_value=0)
        piv, dur = piv.reindex(order).rename_axis(columns=None), dur.reindex(order).rename_axis(columns=None)
        add("<p>Number of annotations per category and annotator (all recordings):</p>")
        add(_table(piv.reset_index()))
        add("<p>Total annotated time (s):</p>")
        add(_table(dur.reset_index()))

    # Category agreement
    add("<h2>2. Agreement by artifact category (time-resolved)</h2>")
    for mode in cfg.channel_modes:
        sel = tr[(tr.recording == POOLED) & (tr.representation == "exact") & (tr.channel_mode == mode)] if not tr.empty else tr
        if sel.empty:
            continue
        summ = (
            sel.groupby("category")[
                ["proportion_agreement", "positive_agreement", "negative_agreement", "cohen_kappa", "prevalence_1",
                 "prevalence_2", "pabak"]
            ].mean().reindex([c for c in show_cats if c in set(sel.category)]).reset_index()
        )
        m_sel = mr[(mr.recording == POOLED) & (mr.representation == "exact") & (mr.channel_mode == mode)] if not mr.empty else mr
        if not m_sel.empty:
            summ = summ.merge(m_sel[["category", "fleiss_kappa", "krippendorff_alpha"]], on="category", how="left")
        unit = "seconds" if mode == "time_only" else "channel-seconds"
        add(f"<h3>{mode.replace('_', ' ').capitalize()} (exact, {unit})</h3>")
        add("<p class='muted'>Means over annotator pairs of pooled 2&times;2 tables; Fleiss' kappa and "
            "Krippendorff's alpha use all annotators (samples as units).</p>")
        img = fig_category_agreement(summ[summ.category.isin(present + [ANY_ARTIFACT])])
        if img:
            add(_img(img, f"Agreement by category, {mode.replace('_', ' ')}"))
        add(_table(summ))
    add("<h3>Effect of temporal resolution</h3>")
    if not tr.empty:
        sel = tr[(tr.recording == POOLED) & (tr.channel_mode == "time_only")]
        if not sel.empty:
            res = sel.pivot_table(index="category", columns="representation", values="cohen_kappa", aggfunc="mean")
            res = res.reindex([c for c in show_cats if c in res.index]).rename_axis(columns=None)
            res = res[["exact"] + [c for c in res.columns if c != "exact"]]
            add(f"<p class='muted'>Mean Cohen's kappa (time only) for the exact representation and for bins; a bin is "
                f"positive when at least {cfg.min_bin_coverage:g} of it is covered (0 = any overlap).</p>")
            add(_table(res.reset_index()))

    # Rater pairs
    add("<h2>3. Agreement by annotator pair</h2>")
    if not tr.empty:
        sel = tr[(tr.recording == POOLED) & (tr.representation == "exact") & (tr.channel_mode == "time_only")
                 & (tr.category.isin(show_cats))].copy()
        if not sel.empty:
            sel["pair"] = sel.rater_1 + " – " + sel.rater_2
            add(_table(sel[sel.category == ANY_ARTIFACT][["pair", "both", "only_1", "only_2", "neither", "positive_agreement",
                                                           "negative_agreement", "cohen_kappa", "prevalence_index", "bias_index"]]))
            img = fig_pair_heatmap(sel, "positive_agreement", "Positive agreement (time only, exact) by pair and category",
                                   show_cats)
            if img:
                add(_img(img, "Positive agreement by annotator pair and category"))
    if not ev.empty:
        e = ev[(ev.channel_mode == "time_only") & (ev.threshold == cfg.primary_iou_threshold)].copy()
        if cfg.match_criterion == "tolerance":
            e = ev[ev.channel_mode == "time_only"].copy()
        e = e[e.category.isin(show_cats)]
        if not e.empty:
            e["pair"] = e.reference + " – " + e.compared
            img = fig_pair_heatmap(e, "f1", "Event F1 (time only) by pair and category", show_cats)
            if img:
                add(_img(img, "Event-matching F1 by annotator pair and category"))

    # Events
    add("<h2>4. Event matching and boundary agreement</h2>")
    crit = (
        f"criterion {cfg.match_criterion}, "
        + (f"IoU thresholds {', '.join(f'{t:g}' for t in cfg.matching_thresholds)} (primary {cfg.primary_iou_threshold:g}), "
           if cfg.match_criterion != "tolerance" else "")
        + (f"onset/offset tolerance {cfg.onset_tolerance_s:g}/{cfg.offset_tolerance_s:g} s, " if cfg.match_criterion != "iou" else "")
        + ("many-to-one matches allowed" if cfg.allow_many_to_one else "one-to-one matching")
    )
    add(f"<p class='muted'>{html.escape(crit)}.</p>")
    if not ev.empty:
        img = fig_f1_vs_threshold(ev)
        if img:
            add(_img(img, "F1 as the required overlap increases"))
        prim = ev[(ev.threshold == cfg.primary_iou_threshold) | ev.threshold.isna()]
        cols = ["category", "channel_mode", "reference", "compared", "n_reference", "n_compared", "matched_reference",
                "missed", "extra", "precision", "recall", "f1", "mean_iou", "mean_channel_jaccard",
                "onset_diff_mean_s", "onset_diff_sd_s", "offset_diff_mean_s", "offset_diff_sd_s", "duration_diff_mean_s",
                "onset_diff_loa_low_s", "onset_diff_loa_high_s"]
        add("<div class='scroll'>" + _table(prim[[c for c in cols if c in prim.columns]]) + "</div>")
        add("<p class='muted'>Differences are compared minus reference; LoA = 95% limits of agreement "
            "(mean ± 1.96 SD) among matched events.</p>")
    if not matched.empty:
        m = matched[(matched.threshold == cfg.primary_iou_threshold) & (matched.channel_mode == "time_only")]
        img = fig_timing(m, list(result.dataset.catalogue.label_names))
        if img:
            add(_img(img, "Boundary differences of matched events (compared minus reference)"))

    # Channels
    add("<h2>5. Channel-specific agreement</h2>")
    add("<p>In time-and-channel mode every channel is analysed separately and the results are pooled (units: "
        "channel-seconds or channel-bins). Whole-montage annotations count for every channel of the recording. "
        "Event matching additionally requires the events to share channels; the channel Jaccard index of matched "
        "events measures how similar the channel selections were.</p>")
    if not tr.empty and "time_and_channel" in cfg.channel_modes:
        sel = tr[(tr.recording == POOLED) & (tr.representation == "exact")]
        comp = sel.pivot_table(index="category", columns="channel_mode", values="positive_agreement", aggfunc="mean")
        comp = comp.reindex([c for c in show_cats if c in comp.index]).rename_axis(columns=None)
        add("<p class='muted'>Mean positive agreement, time only versus time and channel:</p>")
        add(_table(comp.reset_index()))

    # Confusion
    conf = tables.get("confusion_time_weighted", pd.DataFrame())
    add("<h2>6. Category disagreements</h2>")
    if not conf.empty:
        tot = conf.groupby(["label_rater_1", "label_rater_2"])["seconds"].sum().reset_index()
        tot = tot[(tot.label_rater_1 != tot.label_rater_2)].sort_values("seconds", ascending=False)
        add("<p class='muted'>Time (s, summed over pairs) where the first annotator used one label and the second "
            "another ('none' = no artifact). Largest disagreements first.</p>")
        add(_table(tot.head(40)))

    # Timelines
    add("<h2>7. Interval overlap by recording</h2>")
    for i, (rid, group) in enumerate(sorted(result.dataset.groups.items())):
        if i >= cfg.timeline_max_recordings:
            add(f"<p class='muted'>Timelines shown for the first {cfg.timeline_max_recordings} recordings only.</p>")
            break
        img = fig_timeline(group, list(result.dataset.catalogue.label_names))
        if img:
            add(_img(img, f"Annotations in {rid}"))

    # Extra measures
    extra = [n for n in tables if not n.startswith(("descriptives_", "timeresolved_", "events_", "confusion_"))]
    if extra:
        add("<h2>Additional measures</h2>")
        for n in extra:
            add(f"<h3>{html.escape(n)}</h3>" + _table(tables[n]))

    add("<h2>8. Analysis settings</h2>")
    add("<pre>" + html.escape(json.dumps(result.settings_record.get("config", {}), indent=2)) + "</pre>")
    add("<details><summary>Input files</summary>" + _table(pd.DataFrame(result.settings_record.get("input_files", []))) + "</details>")
    add("<p class='muted'>All tables are also saved as tab-separated files next to this report. "
        "The matched and unmatched event lists (<code>events_matched.tsv</code>, <code>events_unmatched.tsv</code>) "
        "keep every pairing decision for further analysis.</p>")
    add("</body></html>")
    return "\n".join(parts)
