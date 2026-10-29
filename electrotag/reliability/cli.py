"""Command-line inter-rater agreement analysis (``electrotag-agreement``).

Run ``electrotag-agreement --help`` for every option. Every setting is
written to ``analysis_settings.json`` next to the results.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path

from electrotag.reliability.config import CHANNEL_MODES, MATCH_CRITERIA, AnalysisConfig

#: Exit status when the analysis ran but no recording had two annotators to compare.
EXIT_NOTHING_TO_COMPARE = 3

_D = AnalysisConfig()

EPILOG = f"""\
examples:
  electrotag-agreement /data/MyStudy/Annotated_Events
  electrotag-agreement /data/MyStudy/Annotated_Events --out pilot_agreement \\
      --resolutions 0.05 0.1 --iou-thresholds 0 0.2 0.5 --categories EMG-artifact Eye-blink-artifact
  electrotag-agreement A01_folder A02_folder --reference A01

exit status: 0 when the analysis ran, 2 for a mistake in the command (for example an unknown
category or annotator, or a results folder that already holds results), and
{EXIT_NOTHING_TO_COMPARE} when it ran but no recording was annotated by two of the annotators being
compared (the descriptive tables are still written).

The measures, their assumptions and how to read them are explained in docs/reliability_guide.md
(https://github.com/faisalmushtaq/ElectroTag/blob/main/docs/reliability_guide.md).
"""


def _seconds(values: tuple[float, ...]) -> str:
    return " ".join(f"{v:g}" for v in values)


def default_out_dir(now: datetime | None = None) -> Path:
    """``agreement_<date>-<time>`` in the current folder, so earlier results are never replaced."""
    return Path(f"agreement_{(now or datetime.now()).strftime('%Y%m%d-%H%M%S')}")


def build_parser(prog: str = "electrotag-agreement") -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog=prog,
        description="Inter-rater agreement of ElectroTag annotations: by artifact category, over time, by channel "
        "and by matched events. Writes tab-separated tables and an HTML report.",
        epilog=EPILOG.replace("electrotag-agreement ", f"{prog} "),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("inputs", nargs="+", type=Path,
                   help="Folders searched (with their sub-folders) for *_annotations.json files, normally the study's "
                   "Annotated_Events folder, or individual *_annotations.json files")
    out = p.add_argument_group("results")
    out.add_argument("--out", type=Path,
                     help="Folder for the results (default: a new folder agreement_<date>-<time> in the current "
                     "folder)")
    out.add_argument("--overwrite", action="store_true",
                     help="Allow --out to be a folder that already holds results, which are then replaced")
    out.add_argument("--no-html", action="store_true", help="Write the tables only, without the HTML report")
    out.add_argument("--config", type=Path,
                     help="JSON file with analysis settings (see analysis_settings.json of an earlier analysis); "
                     "command-line options override it")
    sel = p.add_argument_group("what to analyse")
    sel.add_argument("--annotators", nargs="+", metavar="ID", help="Only these annotators (default: all found)")
    sel.add_argument("--categories", nargs="+", metavar="LABEL",
                     help="Only these artifact categories, as HED-SCORE labels such as EMG-artifact (default: all)")
    sel.add_argument("--reference", metavar="ID",
                     help="Compare every annotator with this one only, for example an expert (default: every pair)")
    sel.add_argument("--modes", nargs="+", choices=("standard", "practice", "assessment"),
                     help=f"Session modes to include (default: {' '.join(_D.modes)})")
    tr = p.add_argument_group("time-resolved agreement")
    tr.add_argument("--resolutions", type=float, nargs="+", metavar="SECONDS",
                    help=f"Bin widths in seconds, besides the exact (sample-by-sample) comparison "
                    f"(default: {_seconds(_D.resolutions_s)})")
    tr.add_argument("--min-bin-coverage", type=float, metavar="FRACTION",
                    help=f"Fraction of a bin that an annotation must cover for the bin to count as marked; "
                    f"0 means any overlap (default: {_D.min_bin_coverage:g})")
    tr.add_argument("--channel-modes", nargs="+", choices=CHANNEL_MODES,
                    help="time_only compares when artifacts were marked; time_and_channel also which channels, "
                    "counting each channel separately (default: both)")
    ev = p.add_argument_group("event matching")
    ev.add_argument("--criterion", choices=MATCH_CRITERIA,
                    help="How two annotations are matched: iou (enough overlap), tolerance (onsets and offsets close "
                    f"enough) or iou_and_tolerance (both) (default: {_D.match_criterion})")
    ev.add_argument("--iou-thresholds", type=float, nargs="+", metavar="IOU",
                    help="Minimum overlap (intersection over union, 0 to 1; 0 means any overlap) at which events are "
                    f"matched; each is reported (default: {_seconds(_D.iou_thresholds)})")
    ev.add_argument("--primary-iou", type=float, metavar="IOU",
                    help=f"The threshold used for boundary differences and figures (default: "
                    f"{_D.primary_iou_threshold:g})")
    ev.add_argument("--onset-tolerance", type=float, metavar="SECONDS",
                    help=f"Largest onset difference for the tolerance criteria, in seconds (default: "
                    f"{_D.onset_tolerance_s:g})")
    ev.add_argument("--offset-tolerance", type=float, metavar="SECONDS",
                    help=f"Largest offset difference for the tolerance criteria, in seconds (default: "
                    f"{_D.offset_tolerance_s:g})")
    ev.add_argument("--allow-many-to-one", action="store_true", default=None,
                    help="Let one event match several events of the other annotator (default: one-to-one)")
    ev.add_argument("--min-channel-jaccard", type=float, metavar="FRACTION",
                    help="time_and_channel matching: smallest channel overlap (Jaccard index, 0 to 1) for a match; "
                    f"0 means at least one shared channel (default: {_D.min_channel_jaccard:g})")
    rp = p.add_argument_group("report")
    rp.add_argument("--min-events", type=int, metavar="N",
                    help="Categories with fewer annotations than this (all annotators together) are left out of the "
                    f"report's figures but kept in its tables (default: {_D.min_events_per_category})")
    return p


def config_from_args(args: argparse.Namespace) -> AnalysisConfig:
    data = AnalysisConfig.load(args.config).to_dict() if args.config else AnalysisConfig().to_dict()
    mapping = {
        "resolutions": "resolutions_s",
        "min_bin_coverage": "min_bin_coverage",
        "channel_modes": "channel_modes",
        "criterion": "match_criterion",
        "iou_thresholds": "iou_thresholds",
        "primary_iou": "primary_iou_threshold",
        "onset_tolerance": "onset_tolerance_s",
        "offset_tolerance": "offset_tolerance_s",
        "allow_many_to_one": "allow_many_to_one",
        "min_channel_jaccard": "min_channel_jaccard",
        "annotators": "annotators",
        "categories": "categories",
        "reference": "reference_annotator",
        "modes": "modes",
        "min_events": "min_events_per_category",
    }
    for arg, key in mapping.items():
        value = getattr(args, arg)
        if value is not None:
            data[key] = value
    if data.get("annotators"):
        data["annotators"] = [a.upper() for a in data["annotators"]]
    if data.get("reference_annotator"):
        data["reference_annotator"] = data["reference_annotator"].upper()
    return AnalysisConfig.from_dict(data)


def main(argv: list[str] | None = None, prog: str = "electrotag-agreement") -> int:
    args = build_parser(prog).parse_args(argv)
    from electrotag.app.annotations.model import AnnotationError
    from electrotag.reliability.analysis import has_earlier_results, run_analysis, write_outputs

    out = args.out or default_out_dir()
    if out.exists() and not out.is_dir():
        print(f"error: --out {out} is a file; give a folder for the results.", file=sys.stderr)
        return 2
    if has_earlier_results(out) and not args.overwrite:
        print(f"error: {out} already holds the results of an earlier analysis. Choose another folder with --out, "
              "or add --overwrite to replace them.", file=sys.stderr)
        return 2
    try:
        cfg = config_from_args(args)
        result = run_analysis(args.inputs, cfg, strict=True)
    except (ValueError, FileNotFoundError, AnnotationError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    paths = write_outputs(result, out, html=not args.no_html)
    print(f"Analysed {len(result.dataset.groups)} recording(s) from {len(result.dataset.annotators)} annotator(s); "
          f"{result.settings_record.get('n_comparable_recordings', 0)} recording(s) had annotators to compare.")
    for w in result.settings_record.get("warnings", []):
        print(f"warning: {w}")
    print(f"Results written to {out}")
    if "report" in paths:
        print(f"Report: {paths['report']}")
    return 0 if result.has_comparisons else EXIT_NOTHING_TO_COMPARE


if __name__ == "__main__":
    sys.exit(main())
