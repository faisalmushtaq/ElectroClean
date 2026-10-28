# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the stand-alone ElectroClean applications.

Build from the repository root (or anywhere; every path is relative to this file):

    python -m PyInstaller --noconfirm --clean packaging/electroclean.spec

or, more conveniently, ``python packaging/build.py``, which also runs the
frozen self-test. The result is one folder, ``dist/ElectroClean/``, holding
three executables that share one copy of Python, Qt and the scientific libraries:

``ElectroClean``            the desktop application (windowed)
``electroclean-agreement``  inter-rater agreement analysis (console)
``electroclean-admin``      study administration (console)

On macOS the same files are also wrapped in ``dist/ElectroClean.app``; the two
console tools are then in ``ElectroClean.app/Contents/MacOS/``.

The build environment needs requirements.txt, pybv and PyInstaller
(``packaging/requirements-build.txt``). ElectroClean itself is analysed from
this source tree, so it does not need to be installed.
"""

import importlib.util
import re
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata

HERE = Path(SPECPATH).resolve()  # noqa: F821  (SPECPATH is provided by PyInstaller)
ROOT = HERE.parent
APP_NAME = "ElectroClean"
GUI_EXE = "ElectroClean"
CONSOLE_EXES = ("electroclean-agreement", "electroclean-admin")  # see packaging/launcher.py
BUNDLE_ID = "uk.ac.leeds.electroclean"

# Analyse (and collect data files from) this source tree, not any installed copy.
sys.path.insert(0, str(ROOT))
for _mod in [m for m in sys.modules if m == "electroclean" or m.startswith("electroclean.")]:
    del sys.modules[_mod]
_spec = importlib.util.find_spec("electroclean")
if _spec is None or Path(_spec.origin).resolve().parent != ROOT / "electroclean":
    raise SystemExit(f"electroclean is not importable from {ROOT}: found {_spec and _spec.origin}")
VERSION = re.search(r'__version__\s*=\s*"([^"]+)"', (ROOT / "electroclean" / "__init__.py").read_text()).group(1)

# pybv writes the synthetic BrainVision files used by --self-test and the demo tools.
if importlib.util.find_spec("pybv") is None:
    raise SystemExit("pybv is not installed in the build environment: pip install -r packaging/requirements-build.txt")


def _wanted_mne_module(name: str) -> bool:
    # MNE resolves most of its API lazily (lazy_loader + .pyi stubs), so PyInstaller cannot see which
    # submodules are used; collect them all, except tests and the 3-D GUI code that needs PyVista/VTK.
    parts = name.split(".")
    if "tests" in parts or name == "mne.conftest":
        return False
    return not name.startswith(("mne.gui", "mne.viz._brain", "mne.viz.backends._pyvista", "mne.commands"))


def _licence_files():
    """ElectroClean's licence, the third-party notices and each bundled package's own licence files."""
    from importlib import metadata

    names = []
    for line in (ROOT / "requirements.txt").read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line and not line.startswith("-"):
            names.append(re.split(r"[=<>!~;\[ ]", line, maxsplit=1)[0])
    out = [(str(ROOT / "LICENSE.md"), "."), (str(ROOT / "THIRD_PARTY_NOTICES.md"), ".")]
    out += [(str(f), "licenses") for f in sorted((ROOT / "licenses").glob("*.txt"))]
    for name in names + ["pybv"]:
        try:
            dist = metadata.distribution(name)
        except metadata.PackageNotFoundError:
            continue
        for f in dist.files or []:
            path = str(f).replace("\\", "/")
            upper = f.name.upper()
            if ".dist-info/" in path and (upper.startswith(("LICEN", "COPYING", "NOTICE", "AUTHORS")) or "/licenses/" in path):
                src = Path(dist.locate_file(f))
                if src.is_file():
                    out.append((str(src), f"licenses/{dist.metadata['Name']}"))
    return out


def _desktop_module(name):
    """Everything except electroclean.web: the browser version's server and Firebase functions run
    elsewhere and need packages (FastAPI, Firebase) that the desktop application does not include."""
    return name != "electroclean.web" and not name.startswith("electroclean.web.")


hiddenimports = (
    collect_submodules("electroclean", filter=_desktop_module)
    + collect_submodules("mne", filter=_wanted_mne_module, on_error="ignore")
    + ["pybv", "mne_qt_browser._pg_figure"]  # MNE also loads its browser backend by name
)

datas = (
    # ElectroClean's own data: config/*.json (label catalogue, default settings, HED-SCORE snapshot)
    # and any future non-Python files listed under package-data in pyproject.toml.
    collect_data_files("electroclean", excludes=["web", "web/**", "web/**/*"])
    # MNE: the .pyi stubs that lazy_loader reads at import time, plus icons, HTML templates,
    # montages and other data under mne/.
    + collect_data_files("mne", include_py_files=False, excludes=["**/tests/**", "**/__pycache__/**"])
    # mne-qt-browser's toolbar icons (SVG, read from disk next to the package).
    + collect_data_files("mne_qt_browser")
    # Packages that read their own version from installed metadata (mne_qt_browser's version is
    # checked by ElectroClean, and every session records library versions).
    + copy_metadata("mne")
    + copy_metadata("mne_qt_browser")
    + copy_metadata("pybv")
    # Licence and source details of Qt for Python (LGPL), kept with the separate Qt libraries.
    + copy_metadata("PySide6-Essentials")
    + copy_metadata("shiboken6")
    # Licences: ElectroClean's, the third-party notices, LGPL/GPL texts and every package's own files.
    + _licence_files()
)

excludes = [
    # Other Qt bindings and toolkits; ElectroClean uses PySide6 through qtpy only.
    "PyQt5", "PyQt6", "PySide2", "tkinter", "_tkinter",
    # Optional MNE dependencies that are not needed (3-D plotting, notebooks, testing).
    "pyvista", "pyvistaqt", "vtk", "vtkmodules", "IPython", "ipywidgets", "jupyter_client",
    "pytest", "_pytest", "numba", "sphinx",
    # The browser version (see _desktop_module).
    "electroclean.web",
]

a = Analysis(  # noqa: F821
    [str(HERE / "launcher.py")],
    pathex=[str(ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={"matplotlib": {"backends": ["Agg", "QtAgg"]}},  # report figures and mne-qt-browser
    runtime_hooks=[str(HERE / "pyi_rth_electroclean.py")],
    excludes=excludes,
    noarchive=False,
    optimize=0,  # keep docstrings and asserts: MNE and SciPy rely on them
)

# ElectroClean does not install Qt translators, so Qt's own translation files are never used.
a.datas = [entry for entry in a.datas if "/translations/" not in entry[0].replace("\\", "/")]


def _drop_gtk_platform_theme(binaries):
    """Linux: leave out Qt's GTK 3 theme plug-in and the libraries that only it needs.

    The plug-in would bring the build machine's whole GTK stack (about 25 MB) into the bundle, and a
    bundled GTK mixed with the user's own GTK modules, themes and settings schemas is a common cause of
    start-up failures on other distributions. Without it Qt draws its own widgets and file dialogs.
    """
    import os

    from PyInstaller.depend.bindepend import get_imports

    def deps(path):
        return {os.path.realpath(p) for _, p in get_imports(path) if p}

    plugin = [e for e in binaries if e[0].replace("\\", "/").endswith("platformthemes/libqgtk3.so")]
    if not plugin:
        return binaries
    rest = [e for e in binaries if e not in plugin]
    # Candidates: system libraries collected into the top level of _internal that the plug-in needs.
    plugin_deps = deps(plugin[0][1])
    candidates = {e for e in rest if "/" not in e[0] and os.path.realpath(e[1]) in plugin_deps}
    needed = set()
    for e in rest:
        if e not in candidates and e[2] in ("BINARY", "EXTENSION"):
            needed |= deps(e[1])
    drop = {e for e in candidates if os.path.realpath(e[1]) not in needed}
    print(f"electroclean.spec: leaving out libqgtk3.so and {len(drop)} libraries only it needs: "
          + ", ".join(sorted(e[0] for e in drop)))
    return [e for e in rest if e not in drop]


if sys.platform.startswith("linux"):
    a.binaries = _drop_gtk_platform_theme(a.binaries)

pyz = PYZ(a.pure)  # noqa: F821


def _exe(name, console):
    return EXE(  # noqa: F821
        pyz,
        a.scripts,
        [],
        exclude_binaries=True,
        name=name,
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,  # UPX damages Qt libraries
        console=console,
        disable_windowed_traceback=False,
        argv_emulation=False,
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
        contents_directory="_internal",
    )


console_exes = [_exe(name, True) for name in CONSOLE_EXES]
gui_exe = _exe(GUI_EXE, False)

coll = COLLECT(  # noqa: F821
    # The GUI executable goes last: on macOS the bundle inherits "console" from the last EXE.
    *console_exes,
    gui_exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name=APP_NAME,
)

if sys.platform == "darwin":
    app = BUNDLE(  # noqa: F821
        coll,
        name=f"{APP_NAME}.app",
        icon=None,
        bundle_identifier=BUNDLE_ID,
        version=VERSION,
        info_plist={
            "CFBundleName": APP_NAME,
            "CFBundleDisplayName": APP_NAME,
            "CFBundleExecutable": GUI_EXE,
            "CFBundleVersion": VERSION,
            "LSBackgroundOnly": False,
            "NSHighResolutionCapable": True,
            "LSMinimumSystemVersion": "14.0",  # PySide6 6.12 wheels need macOS 14 (Sonoma) or later
            "NSHumanReadableCopyright": "ElectroClean contributors",
        },
    )
