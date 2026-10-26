"""``electroclean-admin``: study administration from the command line.

Run ``electroclean-admin --help`` for the list of commands, and
``electroclean-admin <command> --help`` for each command's options. Every
command that changes something validates the result before saving it.
"""

from __future__ import annotations

import argparse
import getpass
import json
import sys
from pathlib import Path

from electroclean.app.annotations.labels import default_catalogue
from electroclean.app.io.atomic import atomic_write_bytes
from electroclean.app.io.canonical import read_annotations_json
from electroclean.app.io.naming import OutputLayout
from electroclean.config.settings import FilterSettings, load_settings
from electroclean.training import admin
from electroclean.training.assessment import METRICS, competency_report
from electroclean.training.consensus import build_consensus, disagreements_tsv
from electroclean.training.reference import (
    QuizItem,
    ReferenceSet,
    import_adjudicated_reference,
    import_expert_reference,
    load_reference_set_by_id,
    reference_sets_dir,
)


def output_layout(dataset: Path) -> OutputLayout:
    settings, _ = load_settings(dataset)
    if settings.output_directory:
        p = Path(settings.output_directory)
        return OutputLayout(p if p.is_absolute() else dataset / p)
    return OutputLayout(dataset / settings.output_directory_name)


def _set(dataset: Path, set_id: str) -> ReferenceSet:
    _, study = load_settings(dataset)
    return load_reference_set_by_id(dataset, study, set_id)


def cmd_show(a: argparse.Namespace) -> int:
    print(json.dumps(admin.copy_without_secrets(admin.read_study_dict(a.dataset)), indent=2))
    _, study = load_settings(a.dataset)
    from electroclean.training.reference import find_reference_sets

    for rs in find_reference_sets(reference_sets_dir(a.dataset, study)):
        print(f"reference set {rs.set_id}: {len(rs.practice_recordings)} practice, "
              f"{len(rs.assessment_recordings)} assessment, {len(rs.quiz_items)} quiz items, "
              f"method {rs.provenance.get('method')}")
    return 0


def cmd_init_study(a: argparse.Namespace) -> int:
    data = admin.read_study_dict(a.dataset)
    data["study_id"] = a.study_id
    if a.annotators:
        data["annotators"] = []
        for spec in a.annotators:
            aid, _, name = spec.partition(":")
            data["annotators"].append({"annotator_id": aid.upper(), "display_name": name})
    data["allow_unlisted_annotators"] = not a.listed_only
    print("Saved", admin.write_study_dict(a.dataset, data))
    return 0


def cmd_set_passphrase(a: argparse.Namespace) -> int:
    pw = a.passphrase or getpass.getpass("New administrator passphrase: ")
    if not a.passphrase and pw != getpass.getpass("Repeat: "):
        print("Passphrases differ", file=sys.stderr)
        return 1
    print("Saved", admin.set_admin_passphrase(a.dataset, pw))
    return 0


def cmd_fix_filters(a: argparse.Namespace) -> int:
    fs = FilterSettings(
        highpass_enabled=not a.no_highpass,
        highpass_hz=a.highpass_hz,
        notch_enabled=a.notch != "off",
        notch_hz=60.0 if a.notch == "off" else float(a.notch),
        notch_harmonics=a.harmonics,
        method=a.method,
    )
    print("Saved", admin.fix_filters(a.dataset, fs))
    return 0


def cmd_unlock_filters(a: argparse.Namespace) -> int:
    print("Saved", admin.unlock_filters(a.dataset))
    return 0


def cmd_collision(a: argparse.Namespace) -> int:
    print("Saved", admin.set_collision_policy(a.dataset, a.policy))
    return 0


def cmd_allocation(a: argparse.Namespace) -> int:
    print("Saved", admin.set_allocation(a.dataset, a.strategy, seed=a.seed))
    return 0


def cmd_allocate(a: argparse.Namespace) -> int:
    from electroclean.app.io.discovery import discover_recordings

    settings, _ = load_settings(a.dataset)
    recs = [r.recording_id for r in discover_recordings(a.dataset, suffix=settings.discovery_suffix,
                                                        exclude_dir_names=settings.discovery_exclude_dir_names)]
    assignments = admin.make_balanced_allocation(a.dataset, recs, a.annotators, a.raters_per_recording, a.seed)
    for aid, rids in assignments.items():
        print(f"{aid}: {len(rids)} recordings")
    return 0


def cmd_create_set(a: argparse.Namespace) -> int:
    _, study = load_settings(a.dataset)
    rs = ReferenceSet.create(reference_sets_dir(a.dataset, study), a.set_id, name=a.name, description=a.description,
                             created_by=a.created_by, method=a.method, experts=a.experts or [], notes=a.notes)
    print("Created", rs.directory)
    return 0


def cmd_add_reference(a: argparse.Namespace) -> int:
    rs = _set(a.dataset, a.set_id)
    print("Added", import_expert_reference(rs, a.file, use=a.use, expert_id=a.expert))
    return 0


def cmd_consensus(a: argparse.Namespace) -> int:
    rs = _set(a.dataset, a.set_id)
    docs = [read_annotations_json(f) for f in a.files]
    res = build_consensus(docs, min_agreement=a.min_agreement, min_duration_s=a.min_duration, merge_gap_s=a.merge_gap)
    path = rs.add_reference(res.document, use=a.use, method="consensus", experts=res.rule["experts"],
                            source_files=list(a.files), details={"consensus_rule": res.rule})
    if a.disagreements:
        atomic_write_bytes(a.disagreements, disagreements_tsv(res.disagreements))
        print("Disagreements written to", a.disagreements)
    print(f"Consensus of {len(docs)} experts ({res.rule['min_agreement']} needed): "
          f"{len(res.document.annotations)} annotations -> {path}")
    return 0


def cmd_disagreements(a: argparse.Namespace) -> int:
    docs = [read_annotations_json(f) for f in a.files]
    res = build_consensus(docs, min_agreement=a.min_agreement)
    atomic_write_bytes(a.out, disagreements_tsv(res.disagreements))
    print(f"{len(res.disagreements)} disagreement segment(s) written to {a.out}")
    return 0


def cmd_adjudicated(a: argparse.Namespace) -> int:
    rs = _set(a.dataset, a.set_id)
    p = import_adjudicated_reference(rs, a.file, use=a.use, experts=[e.upper() for e in a.experts],
                                     adjudicator=a.adjudicator, expert_files=a.expert_files or [],
                                     disagreements_file=a.disagreements)
    print("Added", p)
    return 0


def cmd_criteria(a: argparse.Namespace) -> int:
    rs = _set(a.dataset, a.set_id)
    if a.from_json:
        crit = json.loads(Path(a.from_json).read_text(encoding="utf-8"))
    else:
        items = []
        for spec in a.criterion or []:
            parts = spec.split(":")
            if len(parts) not in (2, 3):
                print(f"Bad criterion {spec!r}; use metric:threshold[:each_category]", file=sys.stderr)
                return 2
            items.append({"metric": parts[0], "threshold": float(parts[1]),
                          "scope": parts[2] if len(parts) == 3 else "overall"})
        crit = {"criteria": items, "min_reference_events": a.min_reference_events, "categories": a.categories}
    rs.set_criteria(crit)
    print("Saved criteria for", rs.set_id)
    return 0


def cmd_quiz_item(a: argparse.Namespace) -> int:
    rs = _set(a.dataset, a.set_id)
    item = QuizItem(a.item_id, a.recording, a.start, a.end, a.label, a.accept or [], a.explanation or "", a.context)
    rs.add_quiz_item(item, default_catalogue().label_names)
    print(f"Quiz item {a.item_id} saved ({len(rs.quiz_items)} items)")
    return 0


def cmd_report(a: argparse.Namespace) -> int:
    rs = _set(a.dataset, a.set_id)
    rep = competency_report(output_layout(a.dataset), rs, a.annotator.upper())
    print(rep["status_text"])
    if "paths" in rep:
        print("Report:", rep["paths"]["html"])
    return 0


def cmd_progress(a: argparse.Namespace) -> int:
    rs = _set(a.dataset, a.set_id)
    for row in admin.assessment_progress(output_layout(a.dataset), rs, a.annotators):
        print(f"{row['annotator_id']}: practice {row['practice_completed']}/{row['practice_total']}, "
              f"assessment {row['assessment_completed']}/{row['assessment_total']}")
    return 0


def cmd_resolve(a: argparse.Namespace) -> int:
    admin.resolve_failure(output_layout(a.dataset), a.recording, a.note)
    print("Marked as resolved:", a.recording)
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="electroclean-admin", description="ElectroClean study administration")
    sub = p.add_subparsers(dest="command", required=True)

    def add(name: str, func, help_text: str) -> argparse.ArgumentParser:  # noqa: ANN001
        sp = sub.add_parser(name, help=help_text, description=help_text)
        sp.add_argument("dataset", type=Path, help="Dataset folder")
        sp.set_defaults(func=func)
        return sp

    add("show", cmd_show, "Show the study configuration and reference sets")
    sp = add("init-study", cmd_init_study, "Create or update the study configuration")
    sp.add_argument("--study-id", required=True)
    sp.add_argument("--annotators", nargs="*", help="IDs, optionally ID:Display name")
    sp.add_argument("--listed-only", action="store_true", help="Only listed annotators may start sessions")
    sp = add("set-passphrase", cmd_set_passphrase, "Set the administrator passphrase")
    sp.add_argument("--passphrase", help="For scripts; omit to be prompted")
    sp = add("fix-filters", cmd_fix_filters, "Fix the viewing filters for all annotators")
    sp.add_argument("--no-highpass", action="store_true")
    sp.add_argument("--highpass-hz", type=float, default=1.0)
    sp.add_argument("--notch", choices=("50", "60", "off"), default="60")
    sp.add_argument("--harmonics", action="store_true")
    sp.add_argument("--method", choices=("fir", "iir"), default="fir")
    add("unlock-filters", cmd_unlock_filters, "Let annotators choose filters again")
    sp = add("collision-policy", cmd_collision, "Set the policy for original event codes 100-115")
    sp.add_argument("policy", choices=("require_explicit_policy", "preserve_and_flag"))
    sp = add("allocation", cmd_allocation, "Choose random or seeded allocation")
    sp.add_argument("strategy", choices=("random", "seeded"))
    sp.add_argument("--seed", type=int)
    sp = add("allocate", cmd_allocate, "Create a balanced manual allocation with controlled overlap")
    sp.add_argument("--annotators", nargs="+", required=True)
    sp.add_argument("--raters-per-recording", type=int, required=True)
    sp.add_argument("--seed", type=int, required=True)
    sp = add("create-reference-set", cmd_create_set, "Create a reference set for training/assessment")
    sp.add_argument("set_id")
    sp.add_argument("--name", default="")
    sp.add_argument("--description", default="")
    sp.add_argument("--created-by", default="")
    sp.add_argument("--method", choices=("single_expert", "consensus", "adjudicated"), default="single_expert")
    sp.add_argument("--experts", nargs="*")
    sp.add_argument("--notes", default="")
    sp = add("add-reference", cmd_add_reference, "Use one expert's annotation file as a reference")
    sp.add_argument("set_id")
    sp.add_argument("file", type=Path)
    sp.add_argument("--use", choices=("practice", "assessment"), required=True)
    sp.add_argument("--expert")
    sp = add("build-consensus", cmd_consensus, "Build a consensus reference from several experts' files")
    sp.add_argument("set_id")
    sp.add_argument("files", type=Path, nargs="+")
    sp.add_argument("--use", choices=("practice", "assessment"), required=True)
    sp.add_argument("--min-agreement", type=int)
    sp.add_argument("--min-duration", type=float, default=0.0)
    sp.add_argument("--merge-gap", type=float, default=0.0)
    sp.add_argument("--disagreements", type=Path, help="Also write the disagreement list (TSV)")
    sp = sub.add_parser("export-disagreements", help="List expert disagreements for adjudication")
    sp.add_argument("files", type=Path, nargs="+")
    sp.add_argument("--out", type=Path, required=True)
    sp.add_argument("--min-agreement", type=int)
    sp.set_defaults(func=cmd_disagreements)
    sp = add("add-adjudicated", cmd_adjudicated, "Use an adjudicator's final file as a reference")
    sp.add_argument("set_id")
    sp.add_argument("file", type=Path)
    sp.add_argument("--use", choices=("practice", "assessment"), required=True)
    sp.add_argument("--experts", nargs="+", required=True)
    sp.add_argument("--adjudicator")
    sp.add_argument("--expert-files", type=Path, nargs="*")
    sp.add_argument("--disagreements", type=Path)
    sp = add("set-criteria", cmd_criteria, "Set competency criteria: " + ", ".join(sorted(METRICS)))
    sp.add_argument("set_id")
    sp.add_argument("--criterion", action="append", help="metric:threshold[:each_category]; repeatable")
    sp.add_argument("--min-reference-events", type=int, default=3)
    sp.add_argument("--categories", nargs="*")
    sp.add_argument("--from-json")
    sp = add("add-quiz-item", cmd_quiz_item, "Add a short-segment quiz item")
    sp.add_argument("set_id")
    sp.add_argument("--item-id", required=True)
    sp.add_argument("--recording", required=True)
    sp.add_argument("--start", type=float, required=True)
    sp.add_argument("--end", type=float, required=True)
    sp.add_argument("--label", required=True)
    sp.add_argument("--accept", nargs="*")
    sp.add_argument("--explanation")
    sp.add_argument("--context", type=float, default=2.0)
    sp = add("report", cmd_report, "Generate an annotator's competency report")
    sp.add_argument("set_id")
    sp.add_argument("annotator")
    sp = add("progress", cmd_progress, "Show practice and assessment progress")
    sp.add_argument("set_id")
    sp.add_argument("--annotators", nargs="+", required=True)
    sp = add("resolve-failure", cmd_resolve, "Mark a recording's load failure as resolved")
    sp.add_argument("recording")
    sp.add_argument("--note", required=True)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args))
    except (ValueError, FileNotFoundError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
