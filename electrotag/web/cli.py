"""``electrotag-web``: the browser version's study, from the command line.

Every command works on a study in one of two places:

* a **study folder** for the ElectroTag server (``--study-dir DIR``, or ``ELECTROTAG_STUDY_DIR``);
* a study in a **Firebase project** (``--firebase-project P --study S``, or
  ``ELECTROTAG_FIREBASE_PROJECT`` and ``ELECTROTAG_STUDY``), with the service account in
  ``GOOGLE_APPLICATION_CREDENTIALS``.

Run ``electrotag-web --help`` for the commands and ``electrotag-web <command> --help`` for their
options. docs/web/firebase.md and docs/web/server.md explain them step by step.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
from pathlib import Path
from typing import Any

from electrotag import __version__

EPILOG = """\
examples:
  electrotag-web demo                                   try everything on this computer
  electrotag-web init-study --firebase-project my-eeg --study pilot --name "Pilot study"
  electrotag-web register /data/Pilot --firebase-project my-eeg --study pilot
  electrotag-web add-user A01 --email a01@example.org --firebase-project my-eeg --study pilot
  electrotag-web assign A01 --all --firebase-project my-eeg --study pilot
  electrotag-web progress --firebase-project my-eeg --study pilot      who has done what so far
  electrotag-web export --firebase-project my-eeg --study pilot --to ~/Pilot-results
  electrotag-web serve --study-dir ~/pilot-server          the ElectroTag server instead of Firebase

exit status: 0 on success, 2 for a mistake in the command or the study, 1 when something failed.
"""


class CommandError(Exception):
    """A mistake in the command (printed without a traceback)."""


# --------------------------------------------------------------------- stores
def _store_args(p: argparse.ArgumentParser, *, required: bool = True) -> None:
    g = p.add_argument_group("the study")
    g.add_argument("--study-dir", type=Path, default=os.environ.get("ELECTROTAG_STUDY_DIR") or None,
                   help="study folder of an ElectroTag server (default: $ELECTROTAG_STUDY_DIR)")
    g.add_argument("--firebase-project", default=os.environ.get("ELECTROTAG_FIREBASE_PROJECT") or None,
                   help="Firebase project ID (default: $ELECTROTAG_FIREBASE_PROJECT)")
    g.add_argument("--study", default=os.environ.get("ELECTROTAG_STUDY") or None,
                   help="study ID in the Firebase project (default: $ELECTROTAG_STUDY)")
    p.set_defaults(store_required=required)


def open_store(a: argparse.Namespace) -> Any:
    from electrotag.web.store import StoreError

    if a.firebase_project:
        if not a.study:
            raise CommandError("Give the study with --study (the study ID in the Firebase project)")
        from electrotag.web.firebase import firestore_client
        from electrotag.web.store_firestore import FirestoreStore

        store = FirestoreStore(firestore_client(a.firebase_project), a.study)
        try:
            _ = store.name  # the study must exist
        except StoreError as exc:
            raise CommandError(str(exc)) from exc
        return store
    if a.study_dir:
        from electrotag.web.store_files import FilesStore

        try:
            return FilesStore(a.study_dir)
        except StoreError as exc:
            raise CommandError(str(exc)) from exc
    raise CommandError("Say which study: --firebase-project P --study S, or --study-dir DIR")


def _is_firebase(store: Any) -> bool:
    return getattr(store, "kind", "") == "firestore"


def _audit(store: Any, op: str, summary: str, **details: Any) -> None:
    """The study's audit log records what the commands change, by "command"."""
    from electrotag.web.audit import record
    from electrotag.web.store import BY_COMMAND

    record(store, BY_COMMAND, op, summary + " (electrotag-web)", details)


def _settings_file(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {}
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise CommandError(f"Cannot read the settings in {path}: {exc}") from exc
    return dict(data.get("settings", data)) if isinstance(data, dict) else {}


# ------------------------------------------------------------------- commands
def cmd_init_study(a: argparse.Namespace) -> int:
    settings = _settings_file(a.settings)
    if a.firebase_project:
        if not a.study:
            raise CommandError("Give the study ID with --study")
        from electrotag.web.firebase import firestore_client
        from electrotag.web.store import StoreError
        from electrotag.web.store_firestore import FirestoreStore

        try:
            store = FirestoreStore.create_study(firestore_client(a.firebase_project), a.study, name=a.name or a.study,
                                                settings=settings, exist_ok=a.update)
        except (StoreError, ValueError) as exc:
            raise CommandError(str(exc)) from exc
        _audit(store, "settings_update" if a.update else "study_create",
               ("Changed the study's name or settings" if a.update else f"Created the study {a.study}"),
               name=a.name or a.study, settings=settings)
        print(f"Study {a.study} is ready in the Firebase project {a.firebase_project}.")
        return 0
    if not a.study_dir:
        raise CommandError("Say where: --firebase-project P --study S, or --study-dir DIR")
    from electrotag.web.store_files import FilesStore
    from electrotag.web.study import StudyError, WebStudy

    try:
        study = WebStudy.init(a.study_dir, study_id=a.study or Path(a.study_dir).name, name=a.name or "",
                              settings=settings, exist_ok=a.update)
    except (StudyError, ValueError) as exc:
        raise CommandError(str(exc)) from exc
    files = FilesStore(study.root)
    try:
        _audit(files, "settings_update" if a.update else "study_create",
               ("Changed the study's name or settings" if a.update else f"Created the study {study.study_id}"),
               name=study.name, settings=settings)
    finally:
        files.close()
    print(f"Study folder ready: {study.root}")
    return 0


def _report_registration(reg: Any) -> int:
    n_sets = len(reg.reference_sets)
    print(f"Registered {len(reg.manifests)} recording(s)" + (f" and {n_sets} reference set(s)" if n_sets else "") + ".")
    if reg.failed:
        print(f"{len(reg.failed)} recording(s) could not be registered:", file=sys.stderr)
        for rid, why in reg.failed:
            print(f"  {rid}: {why}", file=sys.stderr)
        return 1
    return 0


def cmd_register(a: argparse.Namespace) -> int:
    from electrotag.web.registration import register_dataset

    store = open_store(a)
    print(f"Registering the recordings in {a.dataset} (each is opened and checked with ElectroTag's loader):")
    reg = register_dataset(a.dataset, store, check_filters=not a.no_filter_check, include_sets=not a.no_sets)
    _audit_registration(store, reg, f"from the folder {Path(a.dataset).name}")
    return _report_registration(reg)


def _audit_registration(store: Any, reg: Any, where: str) -> None:
    from electrotag.web.audit import count

    if not reg.manifests and not reg.reference_sets:
        return
    sets = [d.get("set_id") for d, _f in reg.reference_sets]
    _audit(store, "recordings_register", f"Registered {count(len(reg.manifests), 'recording')}"
           + (f" and {count(len(sets), 'reference set')}" if sets else "") + f" {where}",
           added=[m["recording_id"] for m in reg.manifests], scopes=sorted({m["scope"] for m in reg.manifests}),
           reference_sets=sets, failed=[r for r, _why in reg.failed])


def cmd_export_manifests(a: argparse.Namespace) -> int:
    from electrotag.app.annotations.labels import default_catalogue
    from electrotag.config.settings import load_settings
    from electrotag.web.registration import collect, write_bundle

    if a.study_dir or a.firebase_project:
        store = open_store(a)
        settings, catalogue = store.settings, store.catalogue
    else:
        settings, _ = load_settings(a.dataset)
        catalogue = default_catalogue()
    reg = collect(a.dataset, settings, catalogue, check_filters=not a.no_filter_check, include_sets=not a.no_sets)
    write_bundle(a.out, reg, source=str(Path(a.dataset).resolve()))
    print(f"Wrote {a.out}: {len(reg.manifests)} recording(s), {len(reg.reference_sets)} reference set(s). It holds "
          "no EEG, but it does hold the reference sets' expert annotations: keep it safe.")
    return 1 if reg.failed else 0


def cmd_import_manifests(a: argparse.Namespace) -> int:
    from electrotag.web.registration import import_bundle

    store = open_store(a)
    try:
        reg = import_bundle(a.bundle, store)
    except ValueError as exc:
        raise CommandError(str(exc)) from exc
    _audit_registration(store, reg, f"from the file {Path(a.bundle).name}")
    print(f"Imported {len(reg.manifests)} recording(s) and {len(reg.reference_sets)} reference set(s).")
    return 0


def cmd_add_user(a: argparse.Namespace) -> int:
    from electrotag.web.accounts import AccountError, normalise_id

    from electrotag.web.store import primary_role, roles_text

    store = open_store(a)
    roles = tuple(r for r, on in (("annotator", True), ("expert", a.expert), ("admin", a.admin)) if on)
    if a.admin and not a.expert:
        roles = ("admin",)  # as before: an administrator's account (who can annotate too)
    role = primary_role(roles)
    try:
        aid = normalise_id(a.annotator_id)
    except AccountError as exc:
        raise CommandError(str(exc)) from exc
    if _is_firebase(store):
        if not a.email:
            raise CommandError("Give the annotator's email address with --email (they sign in with it)")
        from electrotag.web.firebase import AuthProblem, ensure_auth_user, firebase_app

        password = a.password
        try:
            uid, link = ensure_auth_user(firebase_app(a.firebase_project), email=a.email, annotator_id=aid,
                                         study=store.study_id, role=role, roles=roles, display_name=a.name or "",
                                         password=password or None)
        except AuthProblem as exc:
            raise CommandError(exc.message) from exc
        store.put_user(aid, display_name=a.name or "", roles=roles, uid=uid, email=a.email)
        _audit(store, "user_add", f"Added {aid} as {roles_text(roles)}",
               annotator_id=aid, display_name=a.name or "", role=role, roles=list(roles), email=a.email)
        print(f"{aid} ({a.email}) can sign in to study {store.study_id} as {', '.join(roles)}.")
        if link:
            print("Send them this link to choose their password (it works once):")
            print(link)
        return 0
    password = a.password or os.environ.get("ELECTROTAG_PASSWORD")
    if not password:
        password = getpass.getpass(f"Password for {aid}: ")
        if password != getpass.getpass("Repeat: "):
            raise CommandError("The passwords differ")
    try:
        store.db.add_user(aid, password, display_name=a.name or "", role=role, roles=roles, replace=a.replace)
        if a.email:
            store.db.update_user(aid, email=a.email)
    except AccountError as exc:
        raise CommandError(str(exc)) from exc
    _audit(store, "user_add", (f"Set a new password for {aid}" if a.replace else
                               f"Added {aid} as {roles_text(roles)}"),
           annotator_id=aid, display_name=a.name or "", role=role, roles=list(roles))
    print(f"{aid} can sign in to the server as {', '.join(roles)}.")
    return 0


def cmd_assign(a: argparse.Namespace) -> int:
    from electrotag.web.manifest import SCOPE_STUDY, set_scope
    from electrotag.web.store import StoreError

    store = open_store(a)
    aid = a.annotator_id.strip().upper()
    if store.user(aid) is None:
        raise CommandError(f"{aid} has no account in this study; add it first with 'electrotag-web add-user'")
    if a.programme is not None:
        if a.programme:
            try:
                store.reference_set(a.programme)
            except Exception as exc:  # noqa: BLE001
                raise CommandError(str(exc)) from exc
        store.enrol(aid, a.programme or None)
        said = (f"takes the training programme {a.programme}" if a.programme else
                "no longer takes a training programme")
        _audit(store, "programme_set", f"{aid} {said}", annotator_id=aid, set_id=a.programme or None)
        print(f"{aid} {said}.")
        return 0
    mode = a.mode
    ctx = a.set or ""
    if mode != "standard" and not ctx:
        raise CommandError("Training assignments need the reference set (--set)")
    scope = SCOPE_STUDY
    if ctx:
        try:
            rs = store.reference_set(ctx)
        except Exception as exc:  # noqa: BLE001
            raise CommandError(str(exc)) from exc
        scope = set_scope(rs.set_id) if rs.self_contained else SCOPE_STUDY
    in_scope = [m for m in store.manifests() if m["scope"] == scope]
    registered = sorted(m["recording_id"] for m in in_scope)
    if a.all:  # recordings retired in the admin area are offered for no new assignments
        wanted = sorted(m["recording_id"] for m in in_scope if not (m.get("registration") or {}).get("retired"))
    else:
        wanted = list(a.recordings or [])
        unknown = [r for r in wanted if r not in registered]
        if unknown:
            raise CommandError("Not registered: " + ", ".join(unknown) + " (see 'electrotag-web list')")
    if not wanted:
        raise CommandError("Name the recordings (--recordings ...) or give --all")
    try:
        n = store.assign(aid, wanted, mode=mode, context_id=ctx)
    except (StoreError, ValueError) as exc:
        raise CommandError(str(exc)) from exc
    from electrotag.web.audit import count

    _audit(store, "assign", f"Assigned {count(len(wanted), 'recording')} to {aid} ({mode}{', ' + ctx if ctx else ''})"
           f": {n} new", annotator_ids=[aid], recording_ids=wanted, mode=mode, context_id=ctx, added=n)
    print(f"Assigned {n} recording(s) to {aid} ({mode}{', ' + ctx if ctx else ''}); "
          f"{len(wanted) - n} were assigned already.")
    return 0


def cmd_list(a: argparse.Namespace) -> int:
    store = open_store(a)
    print(f"Study {store.study_id}: {store.name} ({store.kind})")
    ms = store.manifests()
    print(f"\nRecordings ({len(ms)}):")
    for m in sorted(ms, key=lambda m: (m["scope"], m["recording_id"])):
        print(f"  {m['recording_id']}" + ("" if m["scope"] == "study" else f"  [{m['scope']}]"))
    sets = store.reference_sets()
    if sets:
        print(f"\nReference sets ({len(sets)}):")
        for rs in sets:
            print(f"  {rs.set_id}: {len(rs.guided_recordings)} guided, {len(rs.practice_recordings)} practice, "
                  f"{len(rs.assessment_recordings)} assessment")
    users = store.users()
    print(f"\nAccounts ({len(users)}):")
    for u in users:
        prog = store.programme(u["annotator_id"])
        n = len(store.assignments(u["annotator_id"]))
        print(f"  {u['annotator_id']:8} {u['role']:9} {u.get('display_name', '')}  "
              f"{n} assigned" + (f", programme {prog}" if prog else ""))
    return 0


STATUS_TEXT = {"todo": "to do", "in_progress": "in progress", "done": "done", "unusable": "set aside"}


def cmd_progress(a: argparse.Namespace) -> int:
    """Who has done what: each annotator's recordings and training stages (GET /admin/progress)."""
    from electrotag.web.service import StudyService
    from electrotag.web.store import User

    store = open_store(a)
    report = StudyService(store).admin_progress(User("ADMIN", "", "admin"), {})
    if a.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return 0
    print(f"Progress of {report['study']}, {report['generated_at']}")
    for person in report["annotators"]:
        items = person["items"]
        done = sum(1 for i in items if i["status"] == "done")
        name = f" ({person['display_name']})" if person.get("display_name") else ""
        role = ", administrator" if person.get("role") == "admin" else ""
        print(f"\n{person['annotator_id']}{name}{role}: {done} of {len(items)} done; "
              f"last seen {person.get('last_seen') or 'never'}")
        for i in items:
            where = "" if i["mode"] == "standard" else f"  [{i['mode']}, {i['context_id']}]"
            tries = f", {i['attempts']} attempts" if i["attempts"] > 1 else ""
            last = f", last {i['last_activity']}" if i.get("last_activity") else ""
            print(f"  {STATUS_TEXT.get(i['status'], i['status']):12} {i['recording_id']}{where}{tries}{last}")
        prog = person.get("programme")
        if isinstance(prog, dict) and prog.get("stages"):
            for st in prog["stages"]:
                if st.get("status") == "not_used":
                    continue
                extra = []
                if st.get("max_stars"):
                    extra.append(f"{st.get('stars', 0)} of {st['max_stars']} stars")
                if st.get("best_score") is not None:
                    extra.append(f"best {round(100 * st['best_score'])}% found")
                print(f"  training: {st['title']}: {st['status'].replace('_', ' ')}, {st['done']} of {st['total']}"
                      + (f" ({'; '.join(extra)})" if extra else ""))
        elif isinstance(prog, dict) and prog.get("error"):
            print(f"  training: {prog.get('message', prog['error'])}")
    return 0


def cmd_example_set(a: argparse.Namespace) -> int:
    from electrotag.training.examples import EXAMPLE_SET_ID, create_example_training_set
    from electrotag.training.reference import ReferenceSetError
    from electrotag.web.registration import register_dataset

    store = open_store(a)
    where = Path(a.recordings_to).resolve()
    try:
        create_example_training_set(where)
    except ReferenceSetError as exc:
        raise CommandError(f"{exc} (in {where})") from exc
    reg = register_dataset(where, store)
    _audit_registration(store, reg, "of ElectroTag's example training set")
    rec = where / "derivatives" / "electrotag_reference_sets" / EXAMPLE_SET_ID / "recordings"
    print(f"The example training set ({EXAMPLE_SET_ID}) is in the study. Its recordings, to give to trainees, are in "
          f"{rec}. Enrol a trainee with: electrotag-web assign <ID> --programme {EXAMPLE_SET_ID}")
    return _report_registration(reg)


def cmd_export(a: argparse.Namespace) -> int:
    from electrotag.web.export import ExportError, export_study

    store = open_store(a)
    if not _is_firebase(store):
        raise CommandError("A study folder already holds its results (in Annotated_Events); export is for Firebase "
                           "studies")
    try:
        counts = export_study(store, a.to)
    except ExportError as exc:
        raise CommandError(str(exc)) from exc
    root = Path(a.to).resolve()
    print(f"Exported into {root}: {counts['recordings']} saved recording(s) ({counts['written']} new file(s)), "
          f"{counts['visits']} interaction log(s), {counts['progress']} training progress file(s), "
          f"{counts['reports']} competency report(s).")
    print(f"Analyse them with: electrotag-agreement {root / store.settings.output_directory_name}")
    return 0


def cmd_config(a: argparse.Namespace) -> int:
    from electrotag.web.firebase import REGION

    if not a.firebase_project or not a.study:
        raise CommandError("Give --firebase-project and --study")
    web: dict[str, Any] = {}
    if a.web_config:
        import re

        text = Path(a.web_config).read_text(encoding="utf-8")
        start, end = text.find("{"), text.rfind("}")
        body = text[start:end + 1] if start >= 0 else ""
        try:
            web = dict(json.loads(body))
        except ValueError:  # the console shows a JavaScript object: apiKey: "...", ...
            web = dict(re.findall(r"""(\w+)\s*:\s*["']([^"']*)["']""", body))
    for key, value in (("apiKey", a.api_key), ("appId", a.app_id)):
        if value:
            web[key] = value
    if not web.get("apiKey"):
        raise CommandError("Give the web app's apiKey (--api-key) or the SDK configuration copied from the Firebase "
                           "console (--web-config FILE); see docs/web/firebase.md")
    web.setdefault("projectId", a.firebase_project)
    web.setdefault("authDomain", f"{a.firebase_project}.firebaseapp.com")
    config = {"firebase": web, "study": a.study, "functions_region": REGION}
    text = json.dumps(config, indent=2) + "\n"
    if a.out:
        Path(a.out).write_text(text, encoding="utf-8")
        print(f"Wrote {a.out}. Put it beside the application (electrotag/web/static/config.json) and publish it.")
    else:
        sys.stdout.write(text)
    return 0


def cmd_serve(a: argparse.Namespace) -> int:
    import uvicorn

    from electrotag.web.app import allowed_origins_from_env, create_app
    from electrotag.web.store import StoreError

    if not a.study_dir:
        raise CommandError("Give the study folder (--study-dir, or ELECTROTAG_STUDY_DIR)")
    origins = allowed_origins_from_env(a.allowed_origins) if a.allowed_origins is not None else None
    try:
        app = create_app(a.study_dir, allowed_origins=origins)
    except StoreError as exc:
        raise CommandError(str(exc)) from exc
    port = a.port or int(os.environ.get("PORT", "8000"))
    print(f"ElectroTag server for {Path(a.study_dir).resolve()} on http://{a.host}:{port}/ (Ctrl+C to stop)")
    uvicorn.run(app, host=a.host, port=port, log_level="info", proxy_headers=True, forwarded_allow_ips="*")
    return 0


def cmd_demo(a: argparse.Namespace) -> int:
    from electrotag.web.demo import build_demo, serve_demo

    if a.no_serve:
        build_demo(a.dir, fresh=a.fresh)
        return 0
    port = a.port or int(os.environ.get("PORT", "8000"))
    origins = None
    if a.allowed_origins is not None:
        from electrotag.web.app import allowed_origins_from_env

        origins = allowed_origins_from_env(a.allowed_origins)
    serve_demo(a.dir, host=a.host, port=port, fresh=a.fresh, allowed_origins=origins)
    return 0


# --------------------------------------------------------------------- parser
def build_parser(prog: str = "electrotag-web") -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog=prog, description="The study of ElectroTag in the browser: "
                                "on Firebase, or on an ElectroTag server.",
                                epilog=EPILOG.replace("electrotag-web ", f"{prog} "),
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--version", action="version", version=f"ElectroTag {__version__}")
    sub = p.add_subparsers(dest="command", metavar="command")

    s = sub.add_parser("init-study", aliases=["init"], help="create a study (in Firebase or a study folder)")
    _store_args(s)
    s.add_argument("--name", help="the study's name, shown to annotators")
    s.add_argument("--settings", type=Path, help="JSON file with settings (as in electrotag_study.json)")
    s.add_argument("--update", action="store_true", help="change the name or settings of an existing study")
    s.set_defaults(func=cmd_init_study)

    s = sub.add_parser("register", help="register the recordings of a dataset (where the files are)")
    s.add_argument("dataset", type=Path, help="the dataset folder (BIDS or not)")
    _store_args(s)
    s.add_argument("--no-filter-check", action="store_true", help="skip checking the display filters on each file")
    s.add_argument("--no-sets", action="store_true", help="leave out the dataset's training reference sets")
    s.set_defaults(func=cmd_register)

    s = sub.add_parser("export-manifests", help="register a dataset into a file, to import where the study is")
    s.add_argument("dataset", type=Path)
    s.add_argument("--out", type=Path, required=True, help="the file to write (JSON)")
    _store_args(s, required=False)
    s.add_argument("--no-filter-check", action="store_true")
    s.add_argument("--no-sets", action="store_true")
    s.set_defaults(func=cmd_export_manifests)

    s = sub.add_parser("import-manifests", help="store the registrations written by export-manifests")
    s.add_argument("bundle", type=Path)
    _store_args(s)
    s.set_defaults(func=cmd_import_manifests)

    s = sub.add_parser("add-user", help="give an annotator (or administrator) an account")
    s.add_argument("annotator_id", help="the annotator's ID in the study, for example A01")
    _store_args(s)
    s.add_argument("--name", help="display name")
    s.add_argument("--email", help="Firebase: the address they sign in with")
    s.add_argument("--password", help="the password (Firebase: leave out to print a link that lets them choose one)")
    s.add_argument("--admin", action="store_true", help="a study administrator, who uses the admin area")
    s.add_argument("--expert", action="store_true",
                   help="an expert, who corrects saved work, adjudicates and supplies training material")
    s.add_argument("--replace", action="store_true", help="study folder: set a new password for an existing account")
    s.set_defaults(func=cmd_add_user)

    s = sub.add_parser("assign", help="give an annotator recordings, or a training programme")
    s.add_argument("annotator_id")
    _store_args(s)
    s.add_argument("--recordings", nargs="+", metavar="ID", help="recording IDs (as 'list' shows them)")
    s.add_argument("--all", action="store_true", help="every registered recording (of the set, with --set)")
    s.add_argument("--mode", choices=("standard", "guided", "practice", "assessment"), default="standard")
    s.add_argument("--set", help="the reference set of a training assignment")
    s.add_argument("--programme", nargs="?", const="", metavar="SET",
                   help="enrol in the training programme of SET (no SET: leave the programme)")
    s.set_defaults(func=cmd_assign)

    s = sub.add_parser("list", help="the study's recordings, reference sets and accounts")
    _store_args(s)
    s.set_defaults(func=cmd_list)

    s = sub.add_parser("progress", help="who has done what: each annotator's recordings and training")
    _store_args(s)
    s.add_argument("--json", action="store_true", help="the full report as JSON (as GET /api/v1/admin/progress)")
    s.set_defaults(func=cmd_progress)

    s = sub.add_parser("create-example-set", help="make the example training set and add it to the study")
    _store_args(s)
    s.add_argument("--recordings-to", type=Path, default=Path("electrotag-example-set"),
                   help="where to write its recordings, to give to trainees (default: ./electrotag-example-set)")
    s.set_defaults(func=cmd_example_set)

    s = sub.add_parser("export", help="Firebase: write the results into ElectroTag's usual folders")
    _store_args(s)
    s.add_argument("--to", type=Path, required=True, help="the folder to write (results go into its Annotated_Events)")
    s.set_defaults(func=cmd_export)

    s = sub.add_parser("config", help="Firebase: print the config.json to put beside the browser application")
    _store_args(s)
    s.add_argument("--api-key", help="the web app's apiKey (Firebase console, Project settings, Your apps)")
    s.add_argument("--app-id", help="the web app's appId")
    s.add_argument("--web-config", type=Path, help="a file holding the SDK configuration copied from the console")
    s.add_argument("--out", type=Path, help="write to this file instead of printing")
    s.set_defaults(func=cmd_config)

    s = sub.add_parser("serve", help="run the ElectroTag server for a study folder")
    s.add_argument("study_dir_pos", nargs="?", type=Path, metavar="STUDY_DIR", help="the study folder")
    _store_args(s)
    s.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"),
                   help="address to listen on (0.0.0.0 for every network interface)")
    s.add_argument("--port", type=int, help="port (default: $PORT or 8000)")
    s.add_argument("--allowed-origins", help="comma-separated origins allowed to call the API "
                   "(default: $ELECTROTAG_ALLOWED_ORIGINS)")
    s.set_defaults(func=cmd_serve)

    s = sub.add_parser("demo", help="make a demonstration study with simulated recordings and serve it")
    s.add_argument("--dir", type=Path, default=Path(os.environ.get("ELECTROTAG_DEMO_DIR", "electrotag-demo")),
                   help="where to make it (default: ./electrotag-demo)")
    s.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    s.add_argument("--port", type=int, help="port (default: $PORT or 8000)")
    s.add_argument("--fresh", action="store_true", help="make it again from scratch")
    s.add_argument("--no-serve", action="store_true", help="make it without starting the server")
    s.add_argument("--allowed-origins", help="comma-separated origins allowed besides GitHub Pages and this server")
    s.set_defaults(func=cmd_demo)
    return p


def main(argv: list[str] | None = None, prog: str = "electrotag-web") -> int:
    parser = build_parser(prog)
    a = parser.parse_args(argv)
    if not getattr(a, "func", None):
        parser.print_help()
        return 2
    if getattr(a, "study_dir_pos", None) is not None:
        a.study_dir = a.study_dir_pos
    try:
        return int(a.func(a) or 0)
    except CommandError as exc:
        print(f"{prog} {a.command}: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
