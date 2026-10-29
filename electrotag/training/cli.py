"""``electrotag-admin``: study administration from the command line.

Run ``electrotag-admin --help`` for the list of commands, and
``electrotag-admin <command> --help`` for each command's options. Every
command that changes something validates the result before saving it.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
from pathlib import Path

from electrotag.app.annotations.labels import default_catalogue
from electrotag.app.io.atomic import atomic_write_bytes
from electrotag.app.io.canonical import read_annotations_json
from electrotag.app.io.naming import OutputLayout
from electrotag.app.io.discovery import DEFAULT_SUFFIXES
from electrotag.app.session.failures import FailureLog
from electrotag.app.session.register import CompletionRegister, RegisterError
from electrotag.config.settings import STUDY_CONFIG_FILENAME, FilterSettings, SettingsError, load_settings
from electrotag.hints import did_you_mean
from electrotag.training import admin
from electrotag.training.assessment import METRICS, competency_report
from electrotag.training.consensus import build_consensus, disagreements_tsv
from electrotag.training.reference import (
    NONE_OPTION,
    QuizItem,
    ReferenceSet,
    import_adjudicated_reference,
    import_expert_reference,
    load_reference_set_by_id,
    reference_sets_dir,
)


class CommandError(ValueError):
    """A mistake in the command line, reported without a traceback."""


def _has_recording(root: Path) -> bool:
    """True as soon as one recording file is found (the whole tree is not listed)."""
    try:
        settings, _ = load_settings(root)
        suffixes = tuple(s.lower() for s in settings.discovery_suffixes)
        excluded = set(settings.discovery_exclude_dir_names)
    except (SettingsError, OSError, ValueError):
        suffixes, excluded = DEFAULT_SUFFIXES, {"derivatives", "Annotated_Events", ".git", ".electrotag"}
    for _dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in excluded and not d.startswith(".")]
        if any(f.lower().endswith(suffixes) for f in filenames):
            return True
    return False


def check_dataset(path: Path, command: str, *, create: bool = False) -> None:
    """Refuse a dataset folder that does not exist or (except for init-study) holds no study."""
    if not path.exists():
        if command == "init-study" and create:
            path.mkdir(parents=True)
            return
        hint = " Use --create to make a new folder for the study." if command == "init-study" else ""
        raise CommandError(f"Dataset folder not found: {path}. Check the path.{hint}")
    if not path.is_dir():
        raise CommandError(f"{path} is a file; give the dataset folder that holds the recordings.")
    if command in ("init-study", "create-example-set"):
        return
    if (path / STUDY_CONFIG_FILENAME).is_file() or _has_recording(path):
        return
    raise CommandError(
        f"{path} does not look like an ElectroTag dataset: it holds no recordings "
        f"({', '.join('*' + s for s in DEFAULT_SUFFIXES)}, also in sub-folders) and no {STUDY_CONFIG_FILENAME}. "
        "Check the path, or set up the study first with 'electrotag-admin init-study'."
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
    from electrotag.training.reference import find_reference_sets

    for rs in find_reference_sets(reference_sets_dir(a.dataset, study)):
        print(f"reference set {rs.set_id}: {len(rs.practice_recordings)} practice, "
              f"{len(rs.assessment_recordings)} assessment, {len(rs.quiz_items)} quiz items, "
              f"method {rs.provenance.get('method')}")
    return 0


def cmd_init_study(a: argparse.Namespace) -> int:
    if not _has_recording(a.dataset):
        print(f"Note: no recordings were found in {a.dataset} yet.", file=sys.stderr)
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
        notch_hz=50.0 if a.notch == "off" else float(a.notch),
        notch_harmonics=a.harmonics,
        method=a.method,
    )
    print("Saved", admin.fix_filters(a.dataset, fs))
    return 0


def cmd_unlock_filters(a: argparse.Namespace) -> int:
    print("Saved", admin.unlock_filters(a.dataset))
    return 0


def cmd_allocation(a: argparse.Namespace) -> int:
    print("Saved", admin.set_allocation(a.dataset, a.strategy, seed=a.seed))
    return 0


def cmd_allocate(a: argparse.Namespace) -> int:
    from electrotag.app.io.discovery import discover_recordings

    settings, _ = load_settings(a.dataset)
    recs = [r.recording_id for r in discover_recordings(a.dataset, suffixes=settings.discovery_suffixes,
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


def cmd_example_set(a: argparse.Namespace) -> int:
    from electrotag.training.examples import create_example_training_set

    _, study = load_settings(a.dataset)
    rs = create_example_training_set(a.dataset, study, set_id=a.set_id)
    print(f"Created {rs.name} in {rs.directory}: {len(rs.guided_recordings)} guided and "
          f"{len(rs.practice_recordings)} practice recording(s) (simulated placeholders)")
    return 0


def cmd_import_recording(a: argparse.Namespace) -> int:
    from electrotag.training.reference import import_expert_recording

    rs = _set(a.dataset, a.set_id)
    rid = import_expert_recording(rs, a.recording, a.annotations, use=a.use, guidance=a.guidance or "",
                                  expert_id=a.expert)
    print(f"Added {rid} to {rs.set_id} for {a.use}")
    return 0


def cmd_guidance(a: argparse.Namespace) -> int:
    rs = _set(a.dataset, a.set_id)
    if a.recording not in rs.recordings:
        raise CommandError(f"{a.recording} is not in reference set {rs.set_id}.{did_you_mean(a.recording, list(rs.recordings))}")
    rs.set_guidance(a.recording, "" if a.guidance == "auto" else a.guidance)
    print(f"{a.recording}: guidance {rs.guidance_for(a.recording)}")
    return 0


def cmd_note(a: argparse.Namespace) -> int:
    rs = _set(a.dataset, a.set_id)
    rs.set_guided_note(a.annotation_id, a.text)
    print("Note saved" if a.text.strip() else "Note removed")
    return 0


def cmd_programme(a: argparse.Namespace) -> int:
    rs = _set(a.dataset, a.set_id)
    if a.pass_f1 is not None or a.pass_types is not None:
        rule = dict(rs.practice_pass)
        if a.pass_f1 is not None:
            rule["event_f1"] = a.pass_f1
        if a.pass_types is not None:
            rule["label_accuracy"] = a.pass_types
        rs.set_practice_pass(rule)
    tol = dict(rs.guided.get("tolerance", {}))
    for key, value in (("seconds", a.tolerance_s), ("fraction", a.tolerance_fraction),
                       ("channel_jaccard", a.channel_overlap)):
        if value is not None:
            tol[key] = value
    rs.set_guided_tolerance(tol)
    from electrotag.training.guided import Tolerance
    from electrotag.training.programme import PassRule

    print(f"Pass mark for practice: {PassRule.from_dict(rs.practice_pass).describe()}")
    t = Tolerance.from_dict(rs.guided.get("tolerance"))
    print(f"Guided steps match within {t.seconds:g} s or {t.fraction:.0%} of the duration; "
          f"channels {t.channel_jaccard:.0%} the same")
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


def cmd_assign(a: argparse.Namespace) -> int:
    rs = _set(a.dataset, a.set_id)
    rs.assigned_annotators = sorted({x.upper() for x in a.annotators})
    rs.save()
    print(f"{rs.set_id} is assigned to: {', '.join(rs.assigned_annotators) or 'anyone'}")
    return 0


def cmd_quiz_item(a: argparse.Namespace) -> int:
    rs = _set(a.dataset, a.set_id)
    if a.offer_none_option and not rs.quiz.get("include_none_option"):
        rs.quiz["include_none_option"] = True
        rs.save()
    label = NONE_OPTION if a.label.strip().lower() in ("none", NONE_OPTION.lower()) else a.label
    item = QuizItem(a.item_id, a.recording, a.start, a.end, label, a.accept or [], a.explanation or "", a.context)
    rs.add_quiz_item(item, default_catalogue().label_names)
    print(f"Quiz item {a.item_id} saved ({len(rs.quiz_items)} items)")
    return 0


def known_annotators(dataset: Path, layout: OutputLayout, rs: ReferenceSet) -> list[str]:
    """Annotators this study knows of: listed in the study, assigned to the set, in the register or with outputs."""
    known: set[str] = set(rs.assigned_annotators)
    _, study = load_settings(dataset)
    if study is not None:
        known.update(e.annotator_id for e in study.annotators)
    known.update(str(e.get("annotator_id", "")) for e in CompletionRegister(layout).entries())
    for base in (layout.root, layout.annotator_dir("X", "assessment", rs.set_id).parent,
                 layout.annotator_dir("X", "practice", rs.set_id).parent):
        if base.is_dir():
            known.update(p.name.removeprefix("annotator-") for p in base.iterdir()
                         if p.is_dir() and p.name.startswith("annotator-"))
    known.discard("")
    return sorted(known)


def cmd_report(a: argparse.Namespace) -> int:
    rs = _set(a.dataset, a.set_id)
    layout = output_layout(a.dataset)
    aid = a.annotator.upper()
    known = known_annotators(a.dataset, layout, rs)
    if aid not in known:
        listing = ", ".join(known) if known else "none yet"
        raise CommandError(
            f"{aid} is not an annotator of this study: not listed in the study, not assigned to reference set "
            f"'{rs.set_id}' and without any saved work.{did_you_mean(aid, known)} Known annotators: {listing}."
        )
    rep = competency_report(layout, rs, aid)
    print(rep["status_text"])
    if "paths" in rep:
        print("Report:", rep["paths"]["html"])
    return 0


def cmd_progress(a: argparse.Namespace) -> int:
    rs = _set(a.dataset, a.set_id)
    for row in admin.assessment_progress(output_layout(a.dataset), rs, a.annotators):
        passed = " (passed)" if row["practice_passed"] else ""
        print(f"{row['annotator_id']}: guided {row['guided_completed']}/{row['guided_total']} "
              f"({row['guided_stars']}/{row['guided_max_stars']} stars), "
              f"practice {row['practice_completed']}/{row['practice_total']}{passed}, "
              f"assessment {row['assessment_completed']}/{row['assessment_total']}")
    return 0


def cmd_resolve(a: argparse.Namespace) -> int:
    layout = output_layout(a.dataset)
    latest: dict[str, str] = {}
    for e in FailureLog(layout).entries():
        if e.get("event") in ("failure", "resolved"):
            latest[str(e.get("recording_id", ""))] = e["event"]
    open_failures = sorted(rid for rid, ev in latest.items() if ev == "failure")
    if a.recording not in open_failures:
        resolved = latest.get(a.recording) == "resolved"
        state = "is already marked resolved" if resolved else "has no recorded load failure"
        listing = ", ".join(open_failures[:10]) + (" ..." if len(open_failures) > 10 else "")
        listing = listing or "none"
        raise CommandError(
            f"{a.recording} {state}.{did_you_mean(a.recording, open_failures)} Unresolved failures: {listing}. "
            "Recordings are named by their path below the dataset folder, as in failed_load.txt."
        )
    admin.resolve_failure(layout, a.recording, a.note)
    print("Marked as resolved:", a.recording)
    return 0


def build_parser(prog: str = "electrotag-admin") -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog=prog,
        description="ElectroTag study administration: study set-up, viewing filters, allocation, reference sets, "
        "competency criteria and reports.",
        epilog=f"Run '{prog} COMMAND --help' for the options of one command. "
        f"Example: {prog} show /data/MyStudy. See docs/administrator_guide.md.",
    )
    sub = p.add_subparsers(dest="command", required=True, metavar="COMMAND", title="commands")

    def add(name: str, func, help_text: str) -> argparse.ArgumentParser:  # noqa: ANN001
        sp = sub.add_parser(name, help=help_text, description=help_text)
        sp.add_argument("dataset", type=Path, help="Dataset folder (the folder that holds the recordings)")
        sp.set_defaults(func=func)
        return sp

    add("show", cmd_show, "Show the study configuration and reference sets")
    sp = add("init-study", cmd_init_study, "Create or update the study configuration")
    sp.add_argument("--study-id", required=True, help="Short name of the study, e.g. pilot-2026")
    sp.add_argument("--annotators", nargs="*", help="IDs, optionally ID:Display name")
    sp.add_argument("--listed-only", action="store_true", help="Only listed annotators may start sessions")
    sp.add_argument("--create", action="store_true", help="Create the dataset folder if it does not exist yet")
    sp = add("set-passphrase", cmd_set_passphrase, "Set the administrator passphrase")
    sp.add_argument("--passphrase", help="For scripts; omit to be prompted")
    sp = add("fix-filters", cmd_fix_filters, "Fix the viewing filters for all annotators")
    sp.add_argument("--no-highpass", action="store_true", help="No high-pass filter")
    sp.add_argument("--highpass-hz", type=float, default=1.0, help="High-pass cut-off in Hz (default 1)")
    sp.add_argument("--notch", choices=("50", "60", "off"), default="50", help="Notch filter in Hz (default 50)")
    sp.add_argument("--harmonics", action="store_true", help="Also filter the harmonics of the mains frequency")
    sp.add_argument("--method", choices=("fir", "iir"), default="fir",
                    help="Filter design; the study uses FIR (IIR only for special purposes)")
    add("unlock-filters", cmd_unlock_filters, "Let annotators choose filters again")
    sp = add("allocation", cmd_allocation, "Choose random or seeded allocation")
    sp.add_argument("strategy", choices=("random", "seeded"))
    sp.add_argument("--seed", type=int, help="Seed for the seeded strategy (any whole number)")
    sp = add("allocate", cmd_allocate, "Create a balanced manual allocation with controlled overlap")
    sp.add_argument("--annotators", nargs="+", required=True, help="Annotator IDs to share the recordings")
    sp.add_argument("--raters-per-recording", type=int, required=True, help="How many annotators each recording gets")
    sp.add_argument("--seed", type=int, required=True, help="Seed for a reproducible allocation")
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
    sp.add_argument("--use", choices=("guided", "practice", "assessment"), required=True)
    sp.add_argument("--expert")
    sp = add("build-consensus", cmd_consensus, "Build a consensus reference from several experts' files")
    sp.add_argument("set_id")
    sp.add_argument("files", type=Path, nargs="+")
    sp.add_argument("--use", choices=("guided", "practice", "assessment"), required=True)
    sp.add_argument("--min-agreement", type=int, help="Experts needed for consensus (default: a strict majority)")
    sp.add_argument("--min-duration", type=float, default=0.0, help="Drop consensus intervals shorter than this (s)")
    sp.add_argument("--merge-gap", type=float, default=0.0, help="Join consensus intervals separated by at most this (s)")
    sp.add_argument("--disagreements", type=Path, help="Also write the disagreement list (TSV)")
    sp = sub.add_parser("export-disagreements", help="List expert disagreements for adjudication")
    sp.add_argument("files", type=Path, nargs="+")
    sp.add_argument("--out", type=Path, required=True)
    sp.add_argument("--min-agreement", type=int)
    sp.set_defaults(func=cmd_disagreements)
    sp = add("add-adjudicated", cmd_adjudicated, "Use an adjudicator's final file as a reference")
    sp.add_argument("set_id")
    sp.add_argument("file", type=Path)
    sp.add_argument("--use", choices=("guided", "practice", "assessment"), required=True)
    sp.add_argument("--experts", nargs="+", required=True)
    sp.add_argument("--adjudicator")
    sp.add_argument("--expert-files", type=Path, nargs="*")
    sp.add_argument("--disagreements", type=Path)
    sp = add("create-example-set", cmd_example_set,
             "Create the example training set: three simulated recordings as placeholders for expert files")
    sp.add_argument("--set-id", default="example")
    sp = add("import-recording", cmd_import_recording,
             "Copy a recording into a reference set's own folder, with an expert's annotations as its reference")
    sp.add_argument("set_id")
    sp.add_argument("recording", type=Path, help="The recording (*_eeg.vhdr, *_eeg.edf or *_eeg.bdf)")
    sp.add_argument("annotations", type=Path, help="The expert's ElectroTag annotations file for it")
    sp.add_argument("--use", choices=("guided", "practice", "assessment"), required=True)
    sp.add_argument("--guidance", choices=("show", "find", "find_unnamed"),
                    help="For guided recordings: how much help (default: by its place in the set)")
    sp.add_argument("--expert", help="The expert's ID (default: the annotator ID in the file)")
    sp = add("set-guidance", cmd_guidance, "How much help a guided recording gives")
    sp.add_argument("set_id")
    sp.add_argument("recording")
    sp.add_argument("guidance", choices=("show", "find", "find_unnamed", "auto"))
    sp = add("set-note", cmd_note, "The experts' explanation of one reference annotation, shown in guided steps")
    sp.add_argument("set_id")
    sp.add_argument("annotation_id")
    sp.add_argument("text", help="The note ('' removes it)")
    sp = add("set-programme", cmd_programme, "The practice pass mark and how closely guided steps must match")
    sp.add_argument("set_id")
    sp.add_argument("--pass-f1", type=float, help="Share of the experts' artifacts to find, 0 to 1 (default 0.8)")
    sp.add_argument("--pass-types", type=float, help="Share of found artifacts with the right type, 0 to 1 (default 0.8)")
    sp.add_argument("--tolerance-s", type=float, help="Start and end within this many seconds (default 0.2)")
    sp.add_argument("--tolerance-fraction", type=float, help="... or this share of the duration (default 0.2)")
    sp.add_argument("--channel-overlap", type=float, help="Channels the same, Jaccard 0 to 1 (default 0.75)")
    sp = add("set-criteria", cmd_criteria, "Set competency criteria: " + ", ".join(sorted(METRICS)))
    sp.add_argument("set_id")
    sp.add_argument("--criterion", action="append", help="metric:threshold[:each_category]; repeatable")
    sp.add_argument("--min-reference-events", type=int, default=3)
    sp.add_argument("--categories", nargs="*")
    sp.add_argument("--from-json")
    sp = add("assign", cmd_assign, "Restrict a reference set to named annotators (none = anyone)")
    sp.add_argument("set_id")
    sp.add_argument("annotators", nargs="*")
    sp = add("add-quiz-item", cmd_quiz_item, "Add a short-segment quiz item")
    sp.add_argument("set_id")
    sp.add_argument("--item-id", required=True)
    sp.add_argument("--recording", required=True)
    sp.add_argument("--start", type=float, required=True)
    sp.add_argument("--end", type=float, required=True)
    sp.add_argument("--label", required=True, help="Correct label; 'none' for a segment without an artifact")
    sp.add_argument("--offer-none-option", action="store_true",
                    help="Offer the answer 'No artifact / none of these' for every item of this quiz")
    sp.add_argument("--accept", nargs="*")
    sp.add_argument("--explanation")
    sp.add_argument("--context", type=float, default=2.0)
    sp = add("report", cmd_report, "Generate an annotator's competency report")
    sp.add_argument("set_id", help="Reference set")
    sp.add_argument("annotator", help="Annotator ID")
    sp = add("progress", cmd_progress, "Show practice and assessment progress")
    sp.add_argument("set_id")
    sp.add_argument("--annotators", nargs="+", required=True)
    sp = add("resolve-failure", cmd_resolve, "Mark a recording's load failure as resolved")
    sp.add_argument("recording",
                    help="Recording as listed in failed_load.txt, e.g. sub-007/eeg/sub-007_task-rest_eeg.vhdr")
    sp.add_argument("--note", required=True, help="What was done about it, for the record")
    return p


def main(argv: list[str] | None = None, prog: str = "electrotag-admin") -> int:
    args = build_parser(prog).parse_args(argv)
    try:
        if getattr(args, "dataset", None) is not None:
            check_dataset(args.dataset, args.command, create=getattr(args, "create", False))
        return int(args.func(args))
    except (ValueError, FileNotFoundError, OSError, RegisterError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
