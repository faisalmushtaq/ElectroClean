"""Command-line inter-rater agreement analysis.

Example::

    electroclean-agreement path/to/Annotated_Events --out agreement_results
    electroclean-agreement A01_dir A02_dir --resolutions 0.01 0.05 0.1 \\
        --iou-thresholds 0 0.2 0.5 --channel-modes time_only time_and_channel

Every setting is written to ``analysis_settings.json`` next to the results.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from electroclean.reliability.config import CHANNEL_MODES, MATCH_CRITERIA, AnalysisConfig


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="electroclean-agreement", description="ElectroClean inter-rater agreement analysis")
    p.add_argument("inputs", nargs="+", type=Path, help="Folders (searched recursively) or *_annotations.json files")
    p.add_argument("--out", type=Path, required=True, help="Folder for the results")
    p.add_argument("--config", type=Path, help="JSON file with analysis settings (command-line options override it)")
    p.add_argument("--resolutions", type=float, nargs="+", help="Bin widths in seconds (default 0.01 0.05 0.1)")
    p.add_argument("--min-bin-coverage", type=float, help="Fraction of a bin that must be covered (0 = any overlap)")
    p.add_argument("--channel-modes", nargs="+", choices=CHANNEL_MODES)
    p.add_argument("--criterion", choices=MATCH_CRITERIA, help="Event matching criterion")
    p.add_argument("--iou-thresholds", type=float, nargs="+")
    p.add_argument("--primary-iou", type=float, help="Threshold used for timing statistics")
    p.add_argument("--onset-tolerance", type=float)
    p.add_argument("--offset-tolerance", type=float)
    p.add_argument("--allow-many-to-one", action="store_true", default=None)
    p.add_argument("--min-channel-jaccard", type=float)
    p.add_argument("--annotators", nargs="+", help="Only these annotators")
    p.add_argument("--categories", nargs="+", help="Only these categories")
    p.add_argument("--reference", help="Compare every annotator with this one only")
    p.add_argument("--modes", nargs="+", choices=("standard", "practice", "assessment"), help="Session modes to include")
    p.add_argument("--no-html", action="store_true", help="Write tables only")
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


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    from electroclean.reliability.analysis import run_analysis, write_outputs

    try:
        cfg = config_from_args(args)
        result = run_analysis(args.inputs, cfg)
    except (ValueError, FileNotFoundError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    paths = write_outputs(result, args.out, html=not args.no_html)
    print(f"Analysed {len(result.dataset.groups)} recording(s) from {len(result.dataset.annotators)} annotator(s).")
    for w in result.settings_record.get("warnings", []):
        print(f"warning: {w}")
    print(f"Results written to {args.out}")
    if "report" in paths:
        print(f"Report: {paths['report']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
