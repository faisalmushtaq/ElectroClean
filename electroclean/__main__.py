"""``python -m electroclean``: a short guide to ElectroClean's commands.

ElectroClean is used in a web browser; the Python package provides the study server, the
administrator's commands for Firebase studies and the analyses of saved results. This prints which
commands there are and how to start the demonstration.
"""

from __future__ import annotations

import sys

from electroclean import APP_NAME, __version__

HELP = f"""{APP_NAME} {__version__}: annotation of artifacts in continuous EEG, in a web browser.

Annotators use the browser application, published at https://faisalmushtaq.github.io/ElectroClean/
(a study gives its annotators its own link). The Python package provides these commands:

  electroclean-web        the study server, the demonstration, and the administrator's
                          commands for a study (register recordings, progress, export)
  electroclean-agreement  inter-rater agreement of saved annotations (an Annotated_Events folder)
  electroclean-admin      reference sets, competency criteria and the training programme
  electroclean-activity   tables and learning curves from the interaction logs

Each command explains itself with --help, for example: electroclean-web --help

To try the whole system on this computer, with simulated recordings and a real study server,
start the demonstration and open the address it prints (http://localhost:8000/) in a web browser:

  electroclean-web demo

The guides are in the docs folder of the source code and at
https://github.com/faisalmushtaq/ElectroClean
"""


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if args and args[0] in ("--version", "-V"):
        print(f"{APP_NAME} {__version__}")
        return 0
    print(HELP, end="")
    if args and args[0] not in ("-h", "--help"):
        print(f"\n'{args[0]}' is not something python -m electroclean can do; use one of the commands above.",
              file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
