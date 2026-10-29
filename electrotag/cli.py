"""``electrotag``: one command for ElectroTag's tools (also ``python -m electrotag``).

ElectroTag is used in a web browser; the Python package provides the study server, the
administrator's commands for a study and the analyses of saved results. ``electrotag`` on its own
lists them; ``electrotag web ...``, ``electrotag agreement ...``, ``electrotag admin ...`` and
``electrotag activity ...`` pass everything after the tool's name to that tool, so that
``electrotag web demo`` is ``electrotag-web demo`` and ``electrotag admin --help`` explains the
administrator's tool. The four tools keep their own names (``electrotag-web`` and so on) as well.
"""

from __future__ import annotations

import argparse
import importlib
import sys
from collections.abc import Callable

from electrotag import APP_NAME, __version__

PROG = "electrotag"

# The tools: name -> (module whose main(argv, prog=...) runs it, the name it also has, what it is for)
TOOLS: dict[str, tuple[str, str, str]] = {
    "web": ("electrotag.web.cli", "electrotag-web",
            "the study server, the demonstration, and the administrator's commands for a study "
            "(create it, register recordings, add accounts, assign work, follow progress, export)"),
    "agreement": ("electrotag.reliability.cli", "electrotag-agreement",
                  "inter-rater agreement of saved annotations (an Annotated_Events folder)"),
    "admin": ("electrotag.training.cli", "electrotag-admin",
              "reference sets, competency criteria and the training programme"),
    "activity": ("electrotag.activity.cli", "electrotag-activity",
                 "tables and learning curves from the interaction logs"),
}

DESCRIPTION = f"""\
{APP_NAME} {__version__}: annotation of artifacts in continuous EEG, in a web browser.

Annotators use the browser application, published at https://faisalmushtaq.github.io/ElectroTag/
(a study gives its annotators its own link). This command runs the tools of the Python package."""

EPILOG = f"""\
Each tool explains itself with --help, for example: {PROG} web --help

To try the whole system on this computer, with simulated recordings and a real study server,
start the demonstration and open the address it prints (http://localhost:8000/) in a web browser:

  {PROG} web demo

The tools also have names of their own, which work as well:
  {", ".join(alias for _m, alias, _h in TOOLS.values())}

The guides are at https://github.com/faisalmushtaq/ElectroTag/tree/main/docs
"""


def build_parser() -> argparse.ArgumentParser:
    """The overview and the choice of tool; each tool parses its own arguments."""
    p = argparse.ArgumentParser(prog=PROG, description=DESCRIPTION, epilog=EPILOG,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--version", "-V", action="version", version=f"{APP_NAME} {__version__}")
    sub = p.add_subparsers(dest="tool", metavar="TOOL", title="tools")
    for name, (_module, _alias, help_text) in TOOLS.items():
        sub.add_parser(name, help=help_text, add_help=False)
    return p


def tool_main(name: str) -> Callable[..., int]:
    """The main() of one tool, imported only when it is used (the server's libraries load slowly)."""
    return importlib.import_module(TOOLS[name][0]).main


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else list(argv)
    parser = build_parser()
    if args and args[0] in TOOLS:
        # Everything after the tool's name is the tool's own, --help included.
        return int(tool_main(args[0])(args[1:], prog=f"{PROG} {args[0]}") or 0)
    if args:
        if not args[0].startswith("-"):
            parser.print_usage(sys.stderr)
            print(f"{PROG}: '{args[0]}' is not one of the tools; choose one of {', '.join(TOOLS)}, "
                  f"or run '{PROG} --help'.", file=sys.stderr)
            return 2
        parser.parse_args(args[:1])  # --help and --version answer and exit; anything else is refused
    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
