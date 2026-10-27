#!/usr/bin/env python3
"""Build the stand-alone ElectroClean applications for this computer and test them.

    python packaging/build.py            # fresh build environment, build, self-test
    python packaging/build.py --zip      # ... and make dist/ElectroClean-<os>-<arch>.zip

Steps:

1. create a fresh virtual environment (``build/freeze-venv``) and install
   ``packaging/requirements-build.txt`` into it (pinned run-time requirements,
   pybv and PyInstaller), so nothing else installed on the computer ends up in
   the applications;
2. run PyInstaller with ``packaging/electroclean.spec`` (output in ``dist/``);
3. run the frozen ``ElectroClean --self-test`` and the two command-line tools'
   ``--help``, and fail if any of them fails;
4. optionally zip the result.

It works the same on Windows, macOS and Linux, needs only Python 3.12 or 3.13
and internet access for the first install, and is what the GitHub Actions
workflow (``.github/workflows/build-apps.yml``) runs. PyInstaller cannot
cross-compile: each operating system's applications are built on that system.
"""

from __future__ import annotations

import argparse
import os
import platform
import shutil
import stat
import subprocess
import sys
import time
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SPEC = HERE / "electroclean.spec"
REQUIREMENTS = HERE / "requirements-build.txt"
DIST = ROOT / "dist"
WORK = ROOT / "build"
APP = "ElectroClean"
CONSOLE_TOOLS = ("electroclean-agreement", "electroclean-admin")
IS_WINDOWS = sys.platform == "win32"
IS_MACOS = sys.platform == "darwin"


def platform_tag() -> str:
    osname = "windows" if IS_WINDOWS else "macos" if IS_MACOS else "linux" if sys.platform.startswith("linux") else ""
    osname = osname or sys.platform
    machine = platform.machine().lower()
    arch = {"amd64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(machine, machine)
    return f"{osname}-{arch}"


def step(text: str) -> None:
    print(f"\n=== {text}", flush=True)


def run(cmd: list[str | Path], **kw) -> subprocess.CompletedProcess:  # noqa: ANN003
    print("$ " + " ".join(str(c) for c in cmd), flush=True)
    return subprocess.run([str(c) for c in cmd], check=True, **kw)


def venv_python(venv: Path) -> Path:
    return venv / ("Scripts/python.exe" if IS_WINDOWS else "bin/python")


def make_environment(venv: Path, base_python: str, reuse: bool) -> Path:
    py = venv_python(venv)
    if reuse and py.exists():
        print(f"Reusing {venv}")
    else:
        if venv.exists():
            shutil.rmtree(venv)
        run([base_python, "-m", "venv", venv])
    run([py, "-m", "pip", "install", "--disable-pip-version-check", "-r", REQUIREMENTS])
    return py


def app_paths() -> tuple[Path, Path, Path]:
    """(thing to distribute, folder holding the executables, GUI executable)."""
    if IS_MACOS:
        bundle = DIST / f"{APP}.app"
        exe_dir = bundle / "Contents" / "MacOS"
        return bundle, exe_dir, exe_dir / APP
    folder = DIST / APP
    return folder, folder, folder / (APP + (".exe" if IS_WINDOWS else ""))


def tree_size(path: Path) -> int:
    return sum(p.lstat().st_size for p in path.rglob("*") if p.is_file() or p.is_symlink())


def self_test(exe_dir: Path, gui: Path, timeout: float) -> None:
    log = WORK / f"selftest-{platform_tag()}.log"
    log.unlink(missing_ok=True)
    env = dict(os.environ, QT_QPA_PLATFORM="offscreen")
    # The windowed Windows executable has no console, so the self-test also writes its output to a file.
    t0 = time.monotonic()
    proc = subprocess.run([str(gui), "--self-test", str(log)], env=env, timeout=timeout, cwd=WORK)
    text = log.read_text(encoding="utf-8", errors="replace") if log.exists() else "(no log written)"
    if IS_WINDOWS:  # the output is otherwise invisible
        print(text)
    if proc.returncode != 0 or "self-test passed" not in text:
        raise SystemExit(f"Frozen self-test FAILED (exit code {proc.returncode}); log: {log}")
    print(f"Frozen self-test passed in {time.monotonic() - t0:.1f} s; log: {log}")
    for tool in CONSOLE_TOOLS:
        exe = exe_dir / (tool + (".exe" if IS_WINDOWS else ""))
        out = subprocess.run([str(exe), "--help"], env=env, timeout=timeout, capture_output=True, text=True)
        if out.returncode != 0 or "usage:" not in out.stdout:
            raise SystemExit(f"{exe.name} --help failed (exit code {out.returncode}):\n{out.stdout}\n{out.stderr}")
        print(f"{exe.name} --help: OK")


def _zip_tree(src: Path, zip_path: Path) -> None:
    """Zip a folder, keeping symbolic links as links and the executable bits (Linux)."""
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for path in sorted(src.rglob("*")):
            arc = path.relative_to(src.parent).as_posix()
            if path.is_symlink():
                info = zipfile.ZipInfo(arc)
                info.create_system = 3  # Unix, so unzip restores the link
                info.external_attr = (stat.S_IFLNK | 0o777) << 16
                zf.writestr(info, os.readlink(path))
            elif path.is_file():
                zf.write(path, arc)


def make_zip(target: Path) -> Path:
    zip_path = DIST / f"{APP}-{platform_tag()}.zip"
    zip_path.unlink(missing_ok=True)
    if IS_MACOS:  # ditto keeps the bundle's symbolic links, permissions and extended attributes
        run(["ditto", "-c", "-k", "--keepParent", target, zip_path])
    else:
        _zip_tree(target, zip_path)
    return zip_path


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--venv", type=Path, default=WORK / "freeze-venv", help="Build environment (default: %(default)s)")
    ap.add_argument("--python", default=sys.executable, help="Python used to create the build environment")
    ap.add_argument("--reuse-venv", action="store_true", help="Keep an existing build environment (faster, less clean)")
    ap.add_argument("--no-venv", action="store_true",
                    help="Build with the current Python instead (requirements-build.txt must be installed)")
    ap.add_argument("--skip-self-test", action="store_true")
    ap.add_argument("--zip", action="store_true", help=f"Also write dist/{APP}-<os>-<arch>.zip")
    ap.add_argument("--timeout", type=float, default=900, help="Seconds allowed for the self-test")
    args = ap.parse_args(argv)

    t_start = time.monotonic()
    WORK.mkdir(exist_ok=True)
    if args.no_venv:
        py = Path(sys.executable)
    else:
        step(f"Creating the build environment in {args.venv}")
        py = make_environment(args.venv.resolve(), args.python, args.reuse_venv)

    step("Building with PyInstaller")
    t0 = time.monotonic()
    run([py, "-m", "PyInstaller", "--noconfirm", "--clean", "--distpath", DIST, "--workpath", WORK / "pyinstaller",
         SPEC], cwd=ROOT)
    build_s = time.monotonic() - t0
    target, exe_dir, gui = app_paths()
    if not gui.exists():
        raise SystemExit(f"PyInstaller finished but {gui} does not exist")
    if not IS_MACOS:
        # Also put the licence and notices next to the executables, where people look for them.
        for name in ("LICENSE.md", "THIRD_PARTY_NOTICES.md"):
            shutil.copy2(ROOT / name, exe_dir / name)

    if not args.skip_self_test:
        step("Testing the frozen applications")
        self_test(exe_dir, gui, args.timeout)

    zip_path = None
    if args.zip:
        step("Zipping")
        zip_path = make_zip(target)

    step("Done")
    print(f"Applications: {target} ({tree_size(target) / 2**20:.0f} MB, PyInstaller took {build_s:.0f} s, "
          f"{time.monotonic() - t_start:.0f} s in all)")
    print(f"Run:          {gui}" + (f"   (or: open {target})" if IS_MACOS else ""))
    if zip_path:
        print(f"Zip:          {zip_path} ({zip_path.stat().st_size / 2**20:.0f} MB)")
    if os.environ.get("GITHUB_OUTPUT"):  # let the CI workflow upload exactly these files
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as fh:
            fh.write(f"app={target}\ntag={platform_tag()}\n" + (f"zip={zip_path}\n" if zip_path else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
