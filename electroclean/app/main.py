"""Launch the ElectroClean desktop application.

Run ``electroclean`` (after installation), ``python -m electroclean``, or one
of the launch scripts in ``launchers/``.
"""

from __future__ import annotations

import argparse
import os
import sys
import traceback
from datetime import datetime
from pathlib import Path


def _crash_log_path() -> Path:
    base = Path(os.environ.get("ELECTROCLEAN_HOME", Path.home() / ".electroclean"))
    base.mkdir(parents=True, exist_ok=True)
    return base / "crash_log.txt"


def install_exception_hook() -> None:
    """Show unexpected errors to the user and log them, instead of exiting silently.

    No recording is ever marked complete by this hook: completion only happens
    inside Save and Finish after every output has been verified.
    """

    def hook(exc_type, exc, tb):  # noqa: ANN001
        text = "".join(traceback.format_exception(exc_type, exc, tb))
        try:
            with open(_crash_log_path(), "a", encoding="utf-8") as fh:
                fh.write(f"\n=== {datetime.now().isoformat()} ===\n{text}")
        except OSError:
            pass
        if sys.__stderr__ is not None:  # None in the windowed (frozen) Windows application
            sys.__stderr__.write(text)
        try:
            from qtpy.QtWidgets import QApplication, QMessageBox

            if QApplication.instance() is not None:
                box = QMessageBox(QMessageBox.Critical, "Unexpected error",
                                  "Something went wrong. Your current recording has not been marked complete.\n\n"
                                  f"{exc_type.__name__}: {exc}\n\nDetails were written to {_crash_log_path()}.")
                box.setDetailedText(text)
                box.exec()
        except Exception:
            pass

    sys.excepthook = hook


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="electroclean", description="ElectroClean EEG artifact annotation")
    p.add_argument("--dataset", type=Path, help="Dataset folder to pre-select")
    p.add_argument("--annotator", help="Annotator ID to pre-fill")
    p.add_argument("--version", action="store_true", help="Print the version and exit")
    p.add_argument("--self-test", nargs="?", const="", default=None, metavar="LOG_FILE",
                   help="Check this installation end to end without a display (synthetic data), optionally "
                        "copying the output to LOG_FILE, and exit with 0 if it passed")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    from electroclean import __version__

    if args.version:
        print(f"ElectroClean {__version__}")
        return 0
    if args.self_test is not None:
        from electroclean.app.selftest import run_self_test

        return run_self_test(args.self_test or None)
    os.environ.setdefault("QT_API", "pyside6")
    import mne
    import pyqtgraph as pg

    mne.set_log_level("error")
    app = pg.mkQApp("ElectroClean")
    app.setApplicationName("ElectroClean")
    app.setOrganizationName("ElectroClean")
    # Windows replace one another (start window, loading dialog, annotation window), so the
    # application must not quit when the last visible one closes; it quits when the user
    # closes the start window or chooses Quit.
    app.setQuitOnLastWindowClosed(False)
    install_exception_hook()

    from electroclean.app.gui.app_controller import AppController

    controller = AppController()
    controller.start_watchdog()
    sw = controller.start_window
    if args.dataset:
        sw.dataset.setText(str(args.dataset))
        sw.refresh()
    if args.annotator:
        sw.annotator.setEditText(args.annotator)
    sw.show()
    return int(app.exec())


if __name__ == "__main__":
    sys.exit(main())
