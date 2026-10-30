"""Readable HTML report for an agreement analysis.

Figures are static PNG images (matplotlib) embedded in the page, each
accompanied by the table it was drawn from. The page and the figures follow
the reports' shared design (``electrotag.report_style``). Colours: the
ink blue of that design and the vermillion and reddish purple of the Okabe
and Ito colour-blind-safe palette for the three agreement measures, always
paired with distinct marker shapes or line styles so that colour is never
the only cue, and a single-hue ink-blue ramp for heat maps, boxes and
timelines. Category identity in timelines is carried by labelled rows, not
by colour.

The HTML tables use readable column headings (with the TSV column name in a
tooltip); the TSV files keep their column names for scripts.
"""

from __future__ import annotations

import base64
import functools
import html
import io
import json
from collections.abc import Callable
from typing import Any

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from matplotlib.colors import LinearSegmentedColormap, to_hex  # noqa: E402

from electrotag.reliability.config import ANY_ARTIFACT  # noqa: E402
from electrotag.report_style import BASE_CSS, COLOURS, chart_font, contrast_ratio  # noqa: E402

# The design's ink blue, Okabe-Ito vermillion and Okabe-Ito reddish purple, each at least 3:1 on white.
# Under simulated protan, deutan and tritan vision every pair stays at least 37 CIELAB units apart (the
# Okabe-Ito blue, vermillion and bluish green used before came within 16).
SERIES = [COLOURS["accent"], "#D55E00", "#CC79A7"]
MARKERS = ["o", "s", "D"]
LINESTYLES = ["-", "--", ":"]
#: Single-hue ramp from the design's soft ink blue through the accent to a darker tone, in nearly even
#: steps of lightness (CIELAB L* 94, 82, 70, 57, 44, 31, 20).
BLUE_RAMP = ["#E9EDF7", "#C7CBE4", "#A5A8D1", "#8085BC", "#5963A7", "#2B4392", "#182C67"]
INK = COLOURS["ink"]
TEXT = COLOURS["body"]  # chart titles
TEXT_2 = COLOURS["secondary"]  # every other text of a chart
GRID = COLOURS["hairline"]
SPINE = COLOURS["edge"]
CMAP = LinearSegmentedColormap.from_list("et_blue", BLUE_RAMP)

POOLED = "ALL (pooled)"
MICRO = "ALL categories (micro-average)"

#: Readable headings for the HTML tables: TSV column name -> (heading, explanation).
COLUMN_TITLES: dict[str, tuple[str, str]] = {
    "recording": ("Recording", ""),
    "category": ("Category", "Artifact category (HED-SCORE label), a group with its subtypes, or ANY-artifact"),
    "annotations": ("Annotations", "Number of annotations of this category, all annotators and recordings together"),
    "duration_s": ("Duration (s)", ""),
    "sfreq": ("Sampling rate (Hz)", ""),
    "n_channels": ("Channels", "Channels compared"),
    "n_annotators": ("Annotators", "Number of annotators"),
    "annotators": ("Annotators", ""),
    "warnings": ("Warnings", ""),
    "pair": ("Annotator pair", ""),
    "proportion_agreement": ("Proportion agreement", "Share of all time on which the two annotators agree, "
                             "including time both left unmarked"),
    "positive_agreement": ("Positive agreement", "Of the time either annotator marked, the share both marked "
                           "(2 x both / (2 x both + only one))"),
    "negative_agreement": ("Negative agreement", "Of the time either annotator left unmarked, the share both "
                           "left unmarked"),
    "cohen_kappa": ("Cohen's kappa", "Agreement corrected for chance; low for rare categories even when "
                    "annotators agree"),
    "prevalence_1": ("Prevalence, 1st", "Share of the time the first annotator marked"),
    "prevalence_2": ("Prevalence, 2nd", "Share of the time the second annotator marked"),
    "prevalence_index": ("Prevalence index", "How unbalanced marked and unmarked time are (0 = balanced)"),
    "bias_index": ("Bias index", "How differently often the two annotators mark (0 = equally often)"),
    "pabak": ("PABAK", "Prevalence- and bias-adjusted kappa"),
    "fleiss_kappa": ("Fleiss' kappa", "Chance-corrected agreement of all annotators together"),
    "krippendorff_alpha": ("Krippendorff's alpha", "Chance-corrected agreement of all annotators together"),
    "both": ("Both marked", "Time marked by both annotators"),
    "only_1": ("Only 1st", "Time marked by the first annotator only"),
    "only_2": ("Only 2nd", "Time marked by the second annotator only"),
    "neither": ("Neither", "Time marked by neither annotator"),
    "time_only": ("Time only", ""),
    "time_and_channel": ("Time and channel", ""),
    "exact": ("Exact", "Sample by sample"),
    "channel_mode": ("Mode", "Time only: when artifacts were marked; time and channel: also on which channels"),
    "reference": ("Reference", "First annotator of the pair (or the reference annotator)"),
    "compared": ("Compared", "Second annotator of the pair"),
    "n_reference": ("Events, reference", "Number of events of the reference annotator"),
    "n_compared": ("Events, compared", "Number of events of the compared annotator"),
    "matched_reference": ("Matched", "Reference events matched by an event of the compared annotator"),
    "missed": ("Missed", "Reference events without a match"),
    "extra": ("Extra", "Compared annotator's events without a match"),
    "precision": ("Precision", "Share of the compared annotator's events that match"),
    "recall": ("Recall", "Share of the reference events that are matched"),
    "f1": ("F1", "Combines precision and recall (1 = every event matched)"),
    "mean_iou": ("Mean IoU", "Mean overlap (intersection over union) of matched events"),
    "mean_channel_jaccard": ("Mean channel Jaccard", "Mean channel overlap of matched events"),
    "onset_diff_mean_s": ("Onset diff., mean (s)", "Compared minus reference"),
    "onset_diff_sd_s": ("Onset diff., SD (s)", ""),
    "offset_diff_mean_s": ("Offset diff., mean (s)", "Compared minus reference"),
    "offset_diff_sd_s": ("Offset diff., SD (s)", ""),
    "duration_diff_mean_s": ("Duration diff., mean (s)", "Compared minus reference"),
    "onset_diff_loa_low_s": ("Onset LoA, low (s)", "95% limits of agreement: mean - 1.96 SD"),
    "onset_diff_loa_high_s": ("Onset LoA, high (s)", "95% limits of agreement: mean + 1.96 SD"),
    "label_rater_1": ("Label, 1st annotator", "'none' = no artifact"),
    "label_rater_2": ("Label, 2nd annotator", "'none' = no artifact"),
    "seconds": ("Time (s)", "Summed over annotator pairs"),
    "path": ("File", ""),
    "status": ("Status", ""),
    "annotator": ("Annotator", ""),
    "confidence_setting": ("Confidence setting", "optional: ratings given only when the annotator wished; "
                           "every_mark: annotators were asked to rate each new mark"),
    "n_recordings": ("Recordings", ""),
    "n_annotations": ("Annotations", ""),
    "n_rated": ("Rated", "Annotations with a confidence rating"),
    "share_rated": ("Share rated", "Share of the annotations with a confidence rating"),
    "n_rated_1": ("1", "Not at all confident"),
    "n_rated_2": ("2", "Slightly confident"),
    "n_rated_3": ("3", "Moderately confident"),
    "n_rated_4": ("4", "Very confident"),
    "n_rated_5": ("5", "Completely confident"),
    "n_not_rated": ("Not rated", "Annotations without a confidence rating"),
    "median_confidence": ("Median", "Median rating of the rated annotations (1 to 5)"),
    "n_with_note": ("With a note", "Annotations that carry a note (notes take part in no statistic)"),
    "rater_1": ("Annotator 1", ""),
    "rater_2": ("Annotator 2", ""),
    "n_marks_all": ("Marks, all", "Events of both annotators"),
    "n_marks_without_low_confidence": ("Marks, without low confidence", "Events of both annotators, leaving "
                                       "out those rated 1 or 2"),
    "positive_agreement_all": ("Positive agreement, all", "Sample by sample, all recordings pooled"),
    "positive_agreement_without_low_confidence": ("Positive agreement, without low confidence", "Leaving out "
                                                  "marks rated 1 or 2"),
    "cohen_kappa_all": ("Kappa, all", "Cohen's kappa sample by sample, all recordings pooled"),
    "cohen_kappa_without_low_confidence": ("Kappa, without low confidence", "Leaving out marks rated 1 or 2"),
    "f1_all": ("F1, all", "Event F1 at the main threshold"),
    "f1_without_low_confidence": ("F1, without low confidence", "Leaving out marks rated 1 or 2"),
    "confidence": ("Confidence", "Rating from 1 (not at all confident) to 5 (completely confident)"),
    "anchor": ("Meaning", ""),
    "n_marks": ("Marks", ""),
    "n_matched": ("Found by another", "Marks matched by a mark of the same type from another annotator"),
    "share_matched": ("Share found by another", "Of the marks with this rating"),
}
NOWRAP = {"category", "pair", "recording", "reference", "compared", "label_rater_1", "label_rater_2",
          "channel_mode", "annotator", "path"}
#: Readable cell values in the HTML tables (the TSV files keep the codes).
VALUE_TITLES = {"channel_mode": {"time_only": "time only", "time_and_channel": "time and channel"}}


@functools.lru_cache(maxsize=1)
def _chart_rc() -> dict[str, Any]:
    """matplotlib settings of the charts: the design's serif when one is installed, and its colours."""
    rc: dict[str, Any] = {
        "text.color": TEXT_2, "axes.labelcolor": TEXT_2, "axes.titlecolor": TEXT, "legend.labelcolor": TEXT_2,
        "axes.edgecolor": SPINE, "axes.linewidth": 0.6, "xtick.color": SPINE, "ytick.color": SPINE,
        "xtick.labelcolor": TEXT_2, "ytick.labelcolor": TEXT_2, "xtick.major.width": 0.6, "ytick.major.width": 0.6,
    }
    font = chart_font()
    if font:
        rc["font.family"] = [font]
    return rc


def _chart(draw: Callable[..., str | None]) -> Callable[..., str | None]:
    """Draws a figure with the charts' settings (fonts, text colours and spines)."""

    @functools.wraps(draw)
    def wrapper(*args: Any, **kwargs: Any) -> str | None:
        with plt.rc_context(_chart_rc()):
            return draw(*args, **kwargs)

    return wrapper


def _style(ax: Any) -> None:
    ax.spines[["top", "right"]].set_visible(False)
    ax.spines[["left", "bottom"]].set_color(SPINE)
    ax.spines[["left", "bottom"]].set_linewidth(0.6)
    ax.tick_params(color=SPINE, labelcolor=TEXT_2, labelsize=9, width=0.6)
    ax.grid(axis="x", color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)


def _value_colour(v: float) -> str:
    """Ink or white for a value printed on a heat-map cell: whichever contrasts more with the cell."""
    cell = to_hex(CMAP(v))
    return "white" if contrast_ratio("#FFFFFF", cell) > contrast_ratio(INK, cell) else INK


def _png(fig: Any) -> str:
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=110, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def _img(src: str, alt: str) -> str:
    return f'<figure><img src="{src}" alt="{html.escape(alt)}"><figcaption>{html.escape(alt)}</figcaption></figure>'


def _cell(v: Any) -> str:
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return "n/a"
    if isinstance(v, (bool, np.bool_)):
        return "yes" if v else "no"
    if isinstance(v, (int, np.integer)):
        return str(int(v))
    if isinstance(v, (float, np.floating)):
        return f"{0.0 if abs(v) < 5e-4 else float(v):.3f}"
    return html.escape(str(v))


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float, np.integer, np.floating)) and not isinstance(v, (bool, np.bool_))


def _table(df: pd.DataFrame | None, max_rows: int = 400, caption: str = "") -> str:
    """HTML table with readable headings; the TSV column name is in each heading's tooltip."""
    cap = f"<p class='caption'>{caption}</p>" if caption else ""
    if df is None or df.empty:
        return cap + "<p class='muted'>No data.</p>"
    shown = df.head(max_rows)
    cols = [str(c) for c in shown.columns]
    head = []
    for c in cols:
        title, tip = COLUMN_TITLES.get(c, (c.replace("_", " ").capitalize(), ""))
        tooltip = f"{tip} [{c}]" if tip else f"[{c}]"
        cls = " class='nowrap'" if c in NOWRAP else ""
        head.append(f"<th{cls} title='{html.escape(tooltip, quote=True)}'>{html.escape(title)}</th>")
    rows = []
    for _, r in shown.iterrows():
        tds = []
        for c, v in zip(cols, r.tolist()):
            classes = (["nowrap"] if c in NOWRAP else []) + (["num"] if _is_number(v) else [])  # numbers: monospaced
            cls = f" class='{' '.join(classes)}'" if classes else ""
            v = VALUE_TITLES.get(c, {}).get(v, v) if isinstance(v, str) else v
            tds.append(f"<td{cls}>{_cell(v)}</td>")
        rows.append("<tr>" + "".join(tds) + "</tr>")
    out = cap + "<table class='data'><thead><tr>" + "".join(head) + "</tr></thead><tbody>" + "".join(rows)
    out += "</tbody></table>"
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


def category_counts(result: Any, categories: list[str]) -> dict[str, int]:
    """Annotations per analysis category, all annotators and recordings together."""
    from electrotag.reliability.timeresolved import category_label_set

    d = result.tables.get("descriptives_annotations_by_annotator")
    per_label: dict[str, int] = {}
    if d is not None and not d.empty:
        per_label = {str(k): int(v) for k, v in d.groupby("category")["n_annotations"].sum().items()}
    out = {}
    for c in categories:
        if c == ANY_ARTIFACT:
            out[c] = sum(per_label.values())
        else:
            labels = category_label_set(c, result.dataset.catalogue, result.config)
            out[c] = sum(per_label.get(lab, 0) for lab in labels)
    return out


def _too_few_note(excluded: list[str], counts: dict[str, int], minimum: int) -> str:
    if not excluded:
        return ""
    names = ", ".join(f"{html.escape(c)} ({counts.get(c, 0)})" for c in excluded)
    return (f"<p class='muted'>Not in the figure, because they have fewer than {minimum} annotations in total "
            f"(the number is in brackets) and their agreement values would mean little: {names}. They are in the "
            "table.</p>")


# ------------------------------------------------------------------ figures
@_chart
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
        ax.scatter(vals, y + (i - 1) * 0.22, s=42, color=SERIES[i], marker=MARKERS[i], label=name, zorder=3,
                   edgecolors="white", linewidths=1.0)
    ax.set_yticks(y, cats, color=TEXT_2)
    ax.set_xlim(-0.25, 1.02)
    ax.axvline(0, color=COLOURS["header_rule"], linewidth=1)
    ax.set_xlabel("Agreement (pooled over recordings, mean over annotator pairs)", color=TEXT_2)
    _style(ax)
    ax.legend(loc="lower center", bbox_to_anchor=(0.5, 1.0), ncol=3, frameon=False, fontsize=9)
    return _png(fig)


@_chart
def fig_pair_heatmap(df: pd.DataFrame, value: str, title: str, order: list[str] | None = None) -> str | None:
    if df.empty:
        return None
    piv = df.pivot_table(index="pair", columns="category", values=value, aggfunc="mean", dropna=False)
    if order:
        piv = piv.reindex(columns=[c for c in order if c in piv.columns])
    if piv.shape[1] == 0:
        return None
    fig, ax = plt.subplots(figsize=(max(6, 0.55 * piv.shape[1] + 2.5), 0.45 * piv.shape[0] + 1.6))
    data = piv.to_numpy(dtype=float)
    im = ax.imshow(np.ma.masked_invalid(data), cmap=CMAP, vmin=0, vmax=1, aspect="auto")
    ax.set_xticks(range(piv.shape[1]), piv.columns, rotation=45, ha="right", fontsize=8, color=TEXT_2)
    ax.set_yticks(range(piv.shape[0]), piv.index, fontsize=9, color=TEXT_2)
    ax.tick_params(color=SPINE, width=0.6)
    for (i, j), v in np.ndenumerate(data):
        txt = "n/a" if np.isnan(v) else f"{v:.2f}"
        colour = INK if np.isnan(v) else _value_colour(v)
        ax.text(j, i, txt, ha="center", va="center", fontsize=8, color=colour)
    ax.set_title(title, fontsize=10, color=TEXT, loc="left")
    cb = fig.colorbar(im, ax=ax, fraction=0.03, pad=0.02)
    cb.ax.tick_params(labelsize=8, color=SPINE, labelcolor=TEXT_2, width=0.6)
    cb.outline.set_edgecolor(COLOURS["header_rule"])
    cb.outline.set_linewidth(0.6)
    for s in ax.spines.values():
        s.set_visible(False)
    return _png(fig)


@_chart
def fig_f1_vs_threshold(ev: pd.DataFrame) -> str | None:
    micro = ev[ev["category"] == MICRO]
    if micro.empty or micro["threshold"].isna().all():
        return None
    fig, ax = plt.subplots(figsize=(6.5, 3.2))
    for i, (mode, grp) in enumerate(micro.groupby("channel_mode", sort=True)):
        g = grp.groupby("threshold")["f1"].mean()
        # The lines often coincide (requiring shared channels changes no match), so the first is drawn wide
        # with hollow circles and the second thin and dashed with small squares on top: both stay visible.
        first = i == 0
        ax.plot(g.index, g.values, color=SERIES[i], linewidth=4 if first else 1.6, linestyle=LINESTYLES[i],
                marker=MARKERS[i], markersize=11 if first else 5, markerfacecolor="white" if first else SERIES[i],
                markeredgecolor=SERIES[i], markeredgewidth=2 if first else 0.8,
                label=COLUMN_TITLES.get(mode, (mode.replace("_", " "), ""))[0], zorder=3 + i)
    ax.set_xlabel("Minimum IoU for a match (0 = any overlap)", color=TEXT_2)
    ax.set_ylabel("F1 (micro-average, mean over pairs)", color=TEXT_2)
    ax.set_ylim(0, 1.02)
    _style(ax)
    ax.grid(axis="y", color=GRID, linewidth=0.8)
    ax.legend(frameon=False, fontsize=9, loc="lower center", bbox_to_anchor=(0.5, 1.0), ncol=2)
    return _png(fig)


@_chart
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
                        boxprops={"facecolor": BLUE_RAMP[1], "edgecolor": BLUE_RAMP[5]},
                        whiskerprops={"color": BLUE_RAMP[5]}, capprops={"color": BLUE_RAMP[5]},
                        flierprops={"markerfacecolor": BLUE_RAMP[5], "markeredgecolor": "white", "markersize": 5})
        del bp
        ax.axvline(0, color=SPINE, linewidth=0.8)
        ax.set_title(title, fontsize=10, color=TEXT, loc="left")
        _style(ax)
    axes[0].set_yticks(range(1, len(cats) + 1), cats, fontsize=9, color=TEXT_2)
    axes[0].invert_yaxis()  # first category at the top, as in the tables
    return _png(fig)


@_chart
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
            colour = BLUE_RAMP[5] if ann.is_global else BLUE_RAMP[3]
            ax.barh(y, ann.duration_samples / sf, left=ann.onset_sample / sf, height=0.62, color=colour,
                    edgecolor="white", linewidth=0.5)
    labels = [f"{c} · {a}" for c, a in rows]
    ax.set_yticks(range(len(rows)), labels, fontsize=7.5, color=TEXT_2)
    ax.invert_yaxis()
    ax.set_xlim(0, group.timing.duration_s)
    ax.set_xlabel("Time (s)", color=TEXT_2)
    prev = None
    for y, (c, _a) in enumerate(rows):
        if prev is not None and c != prev:
            ax.axhline(y - 0.5, color=GRID, linewidth=1)
        prev = c
    _style(ax)
    ax.set_title(f"{group.recording_id}  (dark = whole montage, light = selected channels)", fontsize=9,
                 color=TEXT, loc="left")
    return _png(fig)


# ------------------------------------------------------------- key results
def key_results(result: Any) -> pd.DataFrame:
    """Per annotator pair: positive agreement and kappa on any artifact over time, and event F1."""
    cfg = result.config
    tr = result.tables.get("timeresolved_pairwise", pd.DataFrame())
    ev = result.tables.get("events_summary", pd.DataFrame())
    rows: dict[str, dict[str, Any]] = {}
    if not tr.empty:
        sel = tr[(tr.recording == POOLED) & (tr.representation == "exact") & (tr.channel_mode == "time_only")
                 & (tr.category == ANY_ARTIFACT)]
        for _, r in sel.iterrows():
            pair = f"{r.rater_1} – {r.rater_2}"
            rows.setdefault(pair, {"pair": pair})
            rows[pair]["any_artifact_positive_agreement"] = r.positive_agreement
            rows[pair]["any_artifact_kappa"] = r.cohen_kappa
    if not ev.empty:
        sel = ev[(ev.category == MICRO) & (ev.channel_mode == "time_only")]
        if cfg.match_criterion != "tolerance":
            sel = sel[sel.threshold == cfg.primary_iou_threshold]
        for _, r in sel.iterrows():
            pair = f"{r.reference} – {r.compared}"
            rows.setdefault(pair, {"pair": pair})
            rows[pair]["event_f1"] = r.f1
    df = pd.DataFrame(list(rows.values()), columns=["pair", "any_artifact_positive_agreement", "any_artifact_kappa",
                                                    "event_f1"])
    if len(df) > 1:
        mean = {"pair": "Mean over pairs", **{c: df[c].astype(float).mean() for c in df.columns if c != "pair"}}
        df = pd.concat([df, pd.DataFrame([mean])], ignore_index=True)
    return df


COLUMN_TITLES.update({
    "any_artifact_positive_agreement": ("Positive agreement, any artifact", "Time only, exact, pooled over recordings"),
    "any_artifact_kappa": ("Cohen's kappa, any artifact", "Time only, exact, pooled over recordings"),
    "event_f1": ("Event F1, all categories", "Micro-average over categories, time only, at the main IoU threshold"),
})


COLUMN_TITLES.update({
    "version": ("Version", "original, corrected (an expert's correction, or the adjudication of several), "
                "adjudicated, pending (a correction waiting for adjudication) or left_out"),
    "attempt": ("Version saved", "The annotator's attempt (each Save and Finish of a recording is the next)"),
    "source": ("File", ""),
    "corrected_by": ("Corrected by", ""),
    "correction_id": ("Correction", ""),
    "unit_id": ("Adjudication", "The task, recording or corrections adjudicated"),
    "note": ("Note", ""),
    "via": ("How", "correction: one expert's; adjudication: several experts' corrections, adjudicated"),
    "n_original": ("Marks before", "Annotations in the original"),
    "n_corrected": ("Marks after", "Annotations in the corrected version"),
    "added": ("Added", ""),
    "removed": ("Removed", ""),
    "changed": ("Changed", "Marks whose type, start, end, channels, confidence or note changed"),
    "relabelled": ("Type changed", ""),
    "reasons": ("Reasons", "The corrector's reason for each change, counted (JSON)"),
    "f1_with_original": ("F1 with the original", "Event F1, type by type, time only, at the main threshold "
                         "(1 = unchanged)"),
    "unit_kind": ("Kind", "task, recording, or corrections"),
    "group": ("Compared as", "The recording, or recording#adjudication for a part of it"),
    "window_start_s": ("Part from (s)", ""),
    "window_end_s": ("Part to (s)", ""),
    "adjudicator": ("Adjudicator", ""),
    "n_conflicts": ("Conflicts", ""),
    "presence": ("Presence", "Conflicts where someone has no mark"),
    "type": ("Type", "Conflicts between artifact types"),
    "timing": ("Timing", "Conflicts of start or end beyond the tolerance"),
    "split": ("Split", "Conflicts where one person has two or more marks"),
    "kept_one": ("Kept one", "Decisions that kept one person's marks"),
    "kept_all": ("Kept all", "Decisions that kept everyone's marks"),
    "kept_none": ("Kept none", "Decisions that kept no mark"),
    "kept_picked": ("Kept chosen marks", "Decisions that kept marks chosen one by one, from one person or several"),
    "edited": ("Edited", "Decisions that replaced the marks with the adjudicator's own"),
    "n_decided": ("Decided", ""),
    "mean_decision_s": ("Seconds per decision", "Mean time between decisions, from the start of the adjudication"),
    "f1_before": ("F1 before", "Mean event F1 between the versions compared (type by type, time only, at the main "
                  "threshold, as the key results)"),
    "f1_after": ("F1 after", "Mean event F1 of each version compared with the adjudicated version"),
    "n_adjudicated": ("Marks adjudicated", "Annotations in the adjudicated version"),
    "label_1": ("Type", ""),
    "label_2": ("Confused with", ""),
    "n_units": ("Adjudications", ""),
    "kept_label_1": ("Decided for the first", ""),
    "kept_label_2": ("Decided for the second", ""),
    "kept_both": ("Both kept", ""),
    "kept_neither_or_edited": ("Neither or edited", ""),
    "n_kept": ("Kept", "Marks the adjudicated version has with the same type (matched as the agreement does)"),
    "share_kept": ("Share kept", "Of the annotator's marks"),
    "n_conflict_marks": ("Marks in conflicts", ""),
    "n_decided_for": ("Conflicts decided for them", "Decisions that kept this person's marks (or everyone's)"),
    "adjudications": ("Adjudications", ""),
    "reason": ("Reason", ""),
    "n_changes": ("Changes", ""),
})
NOWRAP |= {"version", "unit_id", "group", "label_1", "label_2", "corrected_by"}
#: The tables of the versions analysed (reliability/versions.py), shown in their own section.
VERSION_TABLES = ("versions", "corrections_effect", "adjudication", "adjudication_pairs", "adjudication_survival")
VERSION_WORDS = {"original": "the original annotations, as the annotators saved them",
                 "corrected": "the corrected versions: each annotator's work as an expert corrected it, where it was "
                 "corrected, and as saved otherwise",
                 "adjudicated": "each annotator against the adjudicated version of every finished adjudication"}


def versions_paragraph(result: Any) -> str:
    """The "Versions analysed" box at the top of the report (empty for the originals analysed by recording)."""
    cfg = result.config
    v = result.settings_record.get("versions") or {}
    if cfg.versions == "original" and getattr(cfg, "unit", "recording") == "recording":
        return ""
    parts = [f"This analysis compares {VERSION_WORDS.get(cfg.versions, cfg.versions)}."]
    by = v.get("by") or {}
    if cfg.versions == "corrected":
        n = int(v.get("replaced") or 0)
        parts.append(f"{n} saved version{'s were' if n != 1 else ' was'} replaced by a correction"
                     + (" (" + ", ".join(f"{k}: {by[k]}" for k in sorted(by)) + ")." if by else "."))
    elif cfg.versions == "adjudicated":
        n = int(v.get("replaced") or 0)
        parts.append(f"{n} finished adjudication{'s are' if n != 1 else ' is'} the reference"
                     + (" (adjudicated by " + ", ".join(f"{k}: {by[k]}" for k in sorted(by)) + ")." if by else "."))
    pending = v.get("pending") or []
    if pending:
        parts.append(f"Correction pending adjudication, left out: {', '.join(pending)}.")
    left = [r for r in v.get("left_out") or [] if r not in pending]
    if left:
        parts.append(f"Left out: {len(left)} recording{'s' if len(left) != 1 else ''} without a version to compare.")
    if getattr(cfg, "unit", "recording") == "task":
        parts.append("Each task's part of a recording is compared on its own (recording#task).")
    return ("<div class='box' data-section='versions'><b>Versions analysed.</b> " + html.escape(" ".join(parts))
            + " The table versions.tsv lists the file used for each annotator and recording.</div>")


def _versions_section(result: Any, add: Callable[[str], None]) -> None:
    """Corrections and adjudication: what they changed (versions.py's tables)."""
    from electrotag.reliability.versions import survival_by_annotator

    t = result.tables
    cfg = result.config
    if not any(n in t for n in VERSION_TABLES):
        return
    add("<h2 data-section='versions-effect'>Corrections and adjudication</h2>")
    ce = t.get("corrections_effect")
    if ce is not None and cfg.versions == "corrected":
        if ce.empty:
            add("<p class='muted'>No saved version analysed was corrected.</p>")
        else:
            f1 = pd.to_numeric(ce["f1_with_original"], errors="coerce").mean()
            add(f"<p>{len(ce)} corrected file{'s' if len(ce) != 1 else ''}: {int(ce['added'].sum())} marks added, "
                f"{int(ce['removed'].sum())} removed and {int(ce['changed'].sum())} changed "
                f"({int(ce['relabelled'].sum())} of them to another type). The corrected versions agree with the "
                f"originals at a mean event F1 of {_cell(f1)} (1 would mean nothing changed).</p>")
            reasons: dict[str, int] = {}
            for text in ce["reasons"]:
                try:
                    for k, n in json.loads(text).items():
                        reasons[k] = reasons.get(k, 0) + int(n)
                except (ValueError, TypeError, AttributeError):
                    continue
            if reasons:
                from electrotag.reliability.versions import REASON_WORDS

                add(_table(pd.DataFrame([{"reason": REASON_WORDS.get(k, k), "n_changes": n}
                                         for k, n in sorted(reasons.items(), key=lambda kv: -kv[1])]),
                           caption="The correctors' reasons for their changes."))
            add(_table(ce.drop(columns=["reasons"]), caption="Each corrected file (corrections_effect.tsv)."))
    adj = t.get("adjudication")
    if adj is not None and cfg.versions == "adjudicated":
        if adj.empty:
            add("<p class='muted'>No adjudication is finished yet.</p>")
        else:
            before = pd.to_numeric(adj["f1_before"], errors="coerce").mean()
            after = pd.to_numeric(adj["f1_after"], errors="coerce").mean()
            add(f"<div class='key' data-section='before-after'><b>Before and after adjudication.</b> Over "
                f"{len(adj)} adjudication{'s' if len(adj) != 1 else ''} with {int(adj['n_conflicts'].sum())} "
                f"conflicts, the versions compared agreed with each other at a mean event F1 of {_cell(before)} "
                f"before adjudication, and with the adjudicated version at {_cell(after)} after it (event F1 over "
                "every type, time only, at the main threshold, as in the key results).</div>")
            add(_table(adj[["unit_id", "recording", "adjudicator", "annotators", "n_conflicts", "presence", "type",
                            "timing", "channels", "split", "kept_one", "kept_all", "kept_none", "kept_picked", "edited",
                            "mean_decision_s", "f1_before", "f1_after"]],
                       caption="Each adjudication: its conflicts by kind, the decisions by choice (from the study's "
                       "records; n/a when they were not available) and the agreement before and after."))
        pairs = t.get("adjudication_pairs")
        if pairs is not None and not pairs.empty:
            add(_table(pairs, caption="Conflicts between two types, by pair of types, and which type the decisions "
                       "kept."))
        surv = t.get("adjudication_survival")
        if surv is not None and not surv.empty:
            rows = survival_by_annotator(surv.to_dict("records"))
            add(_table(pd.DataFrame(rows), caption="How much of each annotator's work the adjudicated versions kept: "
                       "their marks matched by an adjudicated mark of the same type."))
    if "versions" in t:
        add("<details><summary>The version used for each annotator and recording</summary>"
            + _table(t["versions"]) + "</details>")


# -------------------------------------------------------------------- page
CSS = BASE_CSS + """
body { max-width: 1150px; margin: 0 auto; padding: 40px 24px 64px; }
h2 { margin: 56px 0 16px; padding-top: 16px; border-top: 1px solid var(--hairline); }
h3 { margin: 32px 0 12px; }
table.data { font-size: 14px; line-height: 20px; margin: 8px 0 20px; border: 1px solid var(--hairline); }
table.data th { padding: 8px 12px; position: sticky; top: 0; background: var(--white); cursor: help; }
table.data td { padding: 4px 12px; }
table.data tr:last-child td { border-bottom: 0; }
.nowrap { white-space: nowrap; }
.muted { color: var(--secondary); font-size: 14px; line-height: 20px; }
.caption { color: var(--secondary); font-size: 14px; line-height: 20px; margin: 24px 0 8px; }
.box, .key, .warn { border: 1px solid var(--hairline); border-left: 3px solid var(--edge); background: var(--panel);
       padding: 16px 20px; margin: 20px 0; }
.key { background: var(--white); border-left-color: var(--accent); }
.key td.num { color: var(--accent); }
.warn { background: var(--warning-bg); border-left-color: var(--warning-text); color: var(--warning-text); }
.warn b { color: inherit; }
.box > b:first-child, .key > b:first-child, .warn > b:first-child { display: block; margin-bottom: 6px;
       font-size: 14px; line-height: 20px; color: var(--secondary); }
.key > b:first-child { color: var(--accent); }
.warn > b:first-child { color: var(--warning-text); }
figure { margin: 20px 0; padding: 16px; background: var(--white); border: 1px solid var(--hairline);
       width: fit-content; max-width: 100%; box-sizing: border-box; }
figure img { display: block; max-width: 100%; height: auto; }
figcaption { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--hairline); color: var(--secondary);
       font-size: 14px; line-height: 20px; }
details { margin: 12px 0; overflow-x: auto; }
summary { cursor: pointer; font-size: 14px; line-height: 20px; color: var(--secondary); }
.scroll { max-height: 420px; overflow: auto; margin: 8px 0 20px; padding: 0 12px; background: var(--white);
       border: 1px solid var(--hairline); }
.scroll table.data { margin: 0; border: 0; }
/* Narrower than the widest tables (as in the admin area's frame): a wide table scrolls sideways on its own. */
@media (max-width: 1180px) {
  table.data { display: block; width: fit-content; max-width: 100%; overflow-x: auto; }
  .scroll table.data { display: table; max-width: none; }
}
"""


def _confidence_section(result: Any, add: Callable[[str], None]) -> None:
    """Section 5: the annotators' confidence ratings, agreement without low-confidence marks, and calibration."""
    from electrotag.reliability.confidence import confidence_given, explanation

    add("<h2>5. Confidence of the annotations</h2>")
    add(f"<p>{html.escape(explanation(result.dataset, result.config))} Notes that annotators added to their marks "
        "are listed with each event in <code>events_matched.tsv</code> and <code>events_unmatched.tsv</code> and "
        "take part in none of the statistics.</p>")
    by = result.tables.get("confidence_by_annotator", pd.DataFrame())
    if not by.empty:
        add(_table(by, caption="For each annotator, all recordings together: how many annotations were rated, how "
                   "many had each rating from 1 (not at all confident) to 5 (completely confident), the median "
                   "rating, and how many carry a note. Annotators use a scale differently, so compare an "
                   "annotator's ratings with their own rather than with another's."))
    if not confidence_given(result.dataset, result.config):
        return
    sens = result.tables.get("confidence_sensitivity", pd.DataFrame())
    cfg = result.config
    if sens.empty:
        add("<p class='muted'>No annotator pair to compare.</p>")
    else:
        shown = sens[(sens.channel_mode == "time_only") & (sens.category == ANY_ARTIFACT)]
        add(_table(shown if not shown.empty else sens.head(40), caption="Agreement of each pair of annotators for "
                   "all marks and again without the marks of low confidence (rated 1 or 2; unrated marks are kept): "
                   "positive agreement and Cohen's kappa sample by sample and event F1 at the main threshold "
                   f"({html.escape(f'{cfg.primary_iou_threshold:g}')}), for any artifact, time only, all recordings "
                   "pooled. Higher agreement without them means that much of the disagreement lies in marks the "
                   "annotators themselves were unsure of. confidence_sensitivity.tsv has every category and mode."))
    cal = result.tables.get("confidence_calibration", pd.DataFrame())
    if not cal.empty:
        add(_table(cal, caption="Calibration: for each annotator and rating, the share of their marks that at least "
                   "one other annotator also found (a mark of the same type matching it, time only, at the main "
                   "threshold). If the share rises with the rating, the ratings tell which marks others agree with. "
                   "Small numbers of marks make a share unreliable."))


def build_html_report(result: Any) -> str:
    cfg = result.config
    tables = result.tables
    tr = tables.get("timeresolved_pairwise", pd.DataFrame())
    mr = tables.get("timeresolved_multirater", pd.DataFrame())
    ev = tables.get("events_summary", pd.DataFrame())
    matched = tables.get("events_matched", pd.DataFrame())
    present = _present_categories(result)
    # Group roll-ups are shown when they combine at least two labels that were used.
    from electrotag.reliability.config import is_rollup
    from electrotag.reliability.timeresolved import categories_for, category_label_set

    used = set(present)
    show_cats = [
        c for c in categories_for(result.dataset, cfg)
        if c in used
        or (is_rollup(c) and len(category_label_set(c, result.dataset.catalogue, cfg) & used) >= 2)
        or c == ANY_ARTIFACT
    ]
    counts = category_counts(result, show_cats)
    minimum = cfg.min_events_per_category
    plot_cats = [c for c in show_cats if counts.get(c, 0) >= minimum]
    sparse = [c for c in show_cats if c not in plot_cats]
    has_pairs = bool(result.settings_record.get("n_comparable_recordings", 1))
    parts: list[str] = []
    add = parts.append
    add("<!DOCTYPE html><html lang='en'><head><meta charset='utf-8'>")
    add("<meta name='viewport' content='width=device-width, initial-scale=1'>")
    add(f"<title>Agreement report</title><style>{CSS}</style></head><body>")
    rec = result.settings_record
    add("<h1>Inter-rater agreement report</h1>")
    add(
        f"<p class='muted'>{html.escape(rec.get('generated_by', ''))} · {len(result.dataset.groups)} recording(s), "
        f"{rec.get('n_comparable_recordings', 0)} with annotators to compare · "
        f"annotators: {html.escape(', '.join(result.dataset.annotators))} · label catalogue "
        f"{html.escape(result.dataset.catalogue.catalogue_id)} {html.escape(result.dataset.catalogue.catalogue_version)}</p>"
    )
    add(versions_paragraph(result))
    warnings = rec.get("warnings", [])
    if not has_pairs:
        add("<div class='warn'><b>Nothing to compare.</b> " + html.escape(warnings[0] if warnings else "")
            + " Sections 2 to 8 (except the counts of confidence in section 5) are therefore empty; section 1 lists "
            "the annotations.</div>")
    add(
        "<div class='box'><b>How to read this report.</b> Agreement is reported along three dimensions: "
        "<i>category</i> (do annotators use the same artifact type?), <i>time</i> (do they mark the same parts of the "
        "recording?) and <i>channels</i> (do they mark the same channels?). Most EEG is clean, so two annotators agree "
        "on most of the recording simply by both leaving it unmarked. Overall proportion agreement is therefore "
        "dominated by clean data and is not a useful headline. Read <b>positive agreement</b> (agreement about where "
        "artifacts are) together with <b>negative agreement</b> and <b>kappa</b>, the <b>prevalence</b> of each "
        "category, and the event-based <b>F1</b>, rather than any single number. Kappa is low when a category is rare "
        "even if annotators mostly agree (see the prevalence and bias indices). Units of time are not independent, "
        "so no confidence intervals are given for time-resolved statistics. Hold the pointer over a column heading "
        "for an explanation.</div>"
    )
    if has_pairs:
        key = key_results(result)
        thr = (f"at an overlap (IoU) of at least {cfg.primary_iou_threshold:g}" if cfg.match_criterion != "tolerance"
               else "within the onset and offset tolerances")
        add("<div class='key'><b>Key results.</b> For each pair of annotators: <i>positive agreement</i> is, of all the "
            "time either of them marked as any artifact, the share both marked (1 means they marked exactly the same "
            "time); <i>Cohen's kappa</i> is their agreement on artifact versus clean time corrected for chance (0 is "
            f"chance level, 1 perfect); <i>event F1</i> is the share of artifacts they both found, {thr}, across all "
            "categories (1 means every artifact matched). Sections 2 to 4 break these down by category."
            + _table(key) + "</div>")
    if warnings:
        add("<h2>Warnings</h2><ul>" + "".join(f"<li>{html.escape(w)}</li>" for w in warnings) + "</ul>")
    _versions_section(result, add)

    # Overview
    add("<h2>1. Recordings and annotations</h2>")
    add(_table(tables.get("descriptives_recordings", pd.DataFrame()),
               caption="One row per recording: its duration, sampling rate, the channels compared and the annotators "
               "whose files were analysed."))
    d = tables.get("descriptives_annotations_by_annotator", pd.DataFrame())
    if not d.empty:
        order = [c for c in result.dataset.catalogue.label_names if c in set(d.category)]
        piv = d.pivot_table(index="category", columns="annotator", values="n_annotations", aggfunc="sum", fill_value=0)
        dur = d.pivot_table(index="category", columns="annotator", values="total_duration_s", aggfunc="sum", fill_value=0)
        piv, dur = piv.reindex(order).rename_axis(columns=None), dur.reindex(order).rename_axis(columns=None)
        add(_table(piv.reset_index(), caption="Number of annotations per category (rows) and annotator (columns), all "
                   "recordings together."))
        add(_table(dur.reset_index(), caption="Total annotated time in seconds per category and annotator."))

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
        summ.insert(1, "annotations", [counts.get(c, 0) for c in summ["category"]])
        m_sel = mr[(mr.recording == POOLED) & (mr.representation == "exact") & (mr.channel_mode == mode)] if not mr.empty else mr
        if not m_sel.empty:
            summ = summ.merge(m_sel[["category", "fleiss_kappa", "krippendorff_alpha"]], on="category", how="left")
        unit = "seconds" if mode == "time_only" else "channel-seconds"
        add(f"<h3>{COLUMN_TITLES[mode][0]} (exact, {unit})</h3>")
        img = fig_category_agreement(summ[summ.category.isin(plot_cats)])
        if img:
            add(_img(img, f"Agreement by category, {COLUMN_TITLES[mode][0].lower()}"))
        add(_too_few_note([c for c in sparse if c in set(summ.category)], counts, minimum))
        add(_table(summ, caption=f"Agreement by category, comparing {unit} sample by sample and pooling all "
                   "recordings. Values are means over annotator pairs (0 to 1, except kappa and PABAK, which can be "
                   "negative); Fleiss' kappa and Krippendorff's alpha use all annotators together. 'Annotations' is the "
                   "number of annotations of the category, all annotators together."))
    add("<h3>Effect of temporal resolution</h3>")
    if not tr.empty:
        sel = tr[(tr.recording == POOLED) & (tr.channel_mode == "time_only")]
        if not sel.empty:
            # groupby keeps categories whose kappa is undefined (NaN), which pivot_table would drop.
            res = sel.groupby(["category", "representation"], sort=False)["cohen_kappa"].mean().unstack("representation")
            reps = list(dict.fromkeys(sel.representation))
            reps = (["exact"] if "exact" in reps else []) + [r for r in reps if r != "exact"]
            res = res.reindex(index=[c for c in show_cats if c in res.index], columns=reps).rename_axis(columns=None)
            add(_table(res.reset_index(), caption=f"Mean Cohen's kappa (time only) sample by sample ('Exact') and for "
                       f"time bins of the widths shown; a bin counts as marked when at least {cfg.min_bin_coverage:g} "
                       "of it is covered (0 = any overlap)."))
    else:
        add("<p class='muted'>No data.</p>")

    # Rater pairs
    add("<h2>3. Agreement by annotator pair</h2>")
    if not tr.empty:
        sel = tr[(tr.recording == POOLED) & (tr.representation == "exact") & (tr.channel_mode == "time_only")
                 & (tr.category.isin(show_cats))].copy()
        if not sel.empty:
            sel["pair"] = sel.rater_1 + " – " + sel.rater_2
            add(_table(sel[sel.category == ANY_ARTIFACT][["pair", "both", "only_1", "only_2", "neither", "positive_agreement",
                                                           "negative_agreement", "cohen_kappa", "prevalence_index", "bias_index"]],
                       caption="Any artifact, time only, sample by sample, all recordings together: seconds marked by "
                       "both annotators, by only the first or second, or by neither, and the agreement measures."))
            img = fig_pair_heatmap(sel, "positive_agreement", "Positive agreement (time only, exact) by pair and category",
                                   plot_cats)
            if img:
                add(_img(img, "Positive agreement by annotator pair and category"))
    else:
        add("<p class='muted'>No data.</p>")
    if not ev.empty:
        e = ev[(ev.channel_mode == "time_only") & (ev.threshold == cfg.primary_iou_threshold)].copy()
        if cfg.match_criterion == "tolerance":
            e = ev[ev.channel_mode == "time_only"].copy()
        e = e[e.category.isin(plot_cats)]
        if not e.empty:
            e["pair"] = e.reference + " – " + e.compared
            img = fig_pair_heatmap(e, "f1", "Event F1 (time only) by pair and category", plot_cats)
            if img:
                add(_img(img, "Event-matching F1 by annotator pair and category"))
    add(_too_few_note(sparse, counts, minimum))

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
        # The most useful columns first: who, F1, precision, recall, then counts and boundaries.
        cols = ["category", "channel_mode", "reference", "compared", "f1", "precision", "recall", "n_reference",
                "n_compared", "matched_reference", "missed", "extra", "mean_iou", "mean_channel_jaccard",
                "onset_diff_mean_s", "onset_diff_sd_s", "offset_diff_mean_s", "offset_diff_sd_s", "duration_diff_mean_s",
                "onset_diff_loa_low_s", "onset_diff_loa_high_s"]
        add("<div class='scroll'>" + _table(
            prim[[c for c in cols if c in prim.columns]],
            caption="One row per category, comparison mode and annotator pair at the main threshold: F1, precision and "
            "recall (0 to 1), numbers of events, mean overlap of matched events, and boundary differences in seconds "
            "(compared minus reference; LoA = 95% limits of agreement, mean ± 1.96 SD).") + "</div>")
    else:
        add("<p class='muted'>No data.</p>")
    if not matched.empty:
        m = matched[(matched.threshold == cfg.primary_iou_threshold) & (matched.channel_mode == "time_only")]
        img = fig_timing(m, list(result.dataset.catalogue.label_names))
        if img:
            add(_img(img, "Boundary differences of matched events (compared minus reference)"))

    _confidence_section(result, add)

    # Channels
    add("<h2>6. Channel-specific agreement</h2>")
    add("<p>In time-and-channel mode every channel is analysed separately and the results are pooled (units: "
        "channel-seconds or channel-bins). Whole-montage annotations count for every channel of the recording. "
        "Event matching additionally requires the events to share channels; the channel Jaccard index of matched "
        "events measures how similar the channel selections were.</p>")
    if not tr.empty and "time_and_channel" in cfg.channel_modes:
        sel = tr[(tr.recording == POOLED) & (tr.representation == "exact")]
        comp = sel.pivot_table(index="category", columns="channel_mode", values="positive_agreement", aggfunc="mean")
        comp = comp.reindex([c for c in show_cats if c in comp.index]).rename_axis(columns=None)
        add(_table(comp.reset_index(), caption="Mean positive agreement over time only, and over time and channel "
                   "together (0 to 1). A lower value with channels means the annotators chose different channels."))

    # Confusion
    conf = tables.get("confusion_time_weighted", pd.DataFrame())
    add("<h2>7. Category disagreements</h2>")
    if not conf.empty:
        tot = conf.groupby(["label_rater_1", "label_rater_2"])["seconds"].sum().reset_index()
        tot = tot[(tot.label_rater_1 != tot.label_rater_2)].sort_values("seconds", ascending=False)
        add(_table(tot.head(40), caption="Time in seconds, summed over annotator pairs, where the first annotator used "
                   "one label and the second another ('none' = no artifact). Largest disagreements first."))
    else:
        add("<p class='muted'>No data.</p>")

    # Timelines
    add("<h2>8. Interval overlap by recording</h2>")
    for i, (rid, group) in enumerate(sorted(result.dataset.groups.items())):
        if i >= cfg.timeline_max_recordings:
            add(f"<p class='muted'>Timelines shown for the first {cfg.timeline_max_recordings} recordings only.</p>")
            break
        img = fig_timeline(group, list(result.dataset.catalogue.label_names))
        if img:
            add(_img(img, f"Annotations in {rid}"))

    # Bad channels and uncertain marks (reliability/bad_channels.py)
    add("<h2>Channels marked bad and uncertain marks</h2>")
    add("<p>Annotators can mark a channel as bad for the whole recording. Their agreement is shown here, apart "
        "from the artifact tables above, which are unchanged by it: each channel of a recording is one unit, bad "
        "or not. Marks of the uncertain type (Data-artifact, shown to annotators as Uncertain / needs review) are "
        "counted apart below; in the tables above they are a category of their own.</p>")
    add(_table(tables.get("bad_channels_by_channel"), caption="Each channel someone marked bad, with how many of "
               "the recording's annotators did."))
    add(_table(tables.get("bad_channels_pairwise"), caption="Agreement on bad channels for each pair of annotators "
               "of a recording, over its channels."))
    add(_table(tables.get("uncertain_by_annotator"), caption="Marks of the uncertain type by each annotator: how many, "
               "their share of the annotator's marks, and their time."))

    # Extra measures
    extra = [n for n in tables
             if not n.startswith(("descriptives_", "timeresolved_", "events_", "confusion_", "confidence_",
                                  "bad_channels_", "uncertain_"))
             and n not in VERSION_TABLES]
    if extra:
        add("<h2>Additional measures</h2>")
        for n in extra:
            add(f"<h3>{html.escape(n)}</h3>" + _table(tables[n]))

    add("<h2>9. Analysis settings</h2>")
    add("<pre>" + html.escape(json.dumps(result.settings_record.get("config", {}), indent=2)) + "</pre>")
    add("<details><summary>Input files</summary>" + _table(pd.DataFrame(result.settings_record.get("input_files", []))) + "</details>")
    add("<p class='muted'>All tables are also saved as tab-separated files next to this report, with the column names "
        "shown in the headings' tooltips. The matched and unmatched event lists (<code>events_matched.tsv</code>, "
        "<code>events_unmatched.tsv</code>) keep every pairing decision for further analysis, with each "
        "annotation's confidence and note.</p>")
    add("</body></html>")
    return "\n".join(parts)
