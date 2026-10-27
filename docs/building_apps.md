# Building the stand-alone applications

Annotators do not need to install Python to use ElectroClean. For each of Windows, macOS and Linux we build a self-contained folder with PyInstaller that holds the application, its own copy of Python and every library it uses. The folder contains three programs that share those libraries: `ElectroClean`, the desktop application, and the two command-line tools `electroclean-agreement` and `electroclean-admin`. On macOS the folder is wrapped as `ElectroClean.app`, and the two command-line tools are inside it, in `ElectroClean.app/Contents/MacOS/`.

Everything needed for the build is in the `packaging/` folder. The PyInstaller recipe is `packaging/electroclean.spec`; `packaging/build.py` runs it and tests the result; `packaging/requirements-build.txt` lists the exact versions used to build; and `packaging/launcher.py` and `packaging/pyi_rth_electroclean.py` are the small start-up scripts shared by the three programs.

## Building on your own computer

PyInstaller cannot cross-compile, so the Windows build has to be made on Windows, the macOS build on a Mac and the Linux build on Linux. With Python 3.13 (or 3.12) installed, run this from the repository folder:

```
python packaging/build.py --zip
```

The script creates a fresh virtual environment in `build/freeze-venv`, installs the pinned requirements, pybv and PyInstaller into it, runs PyInstaller, and then runs the finished application's self-test and the two command-line tools' `--help` to make sure they work. Because the environment is new each time, nothing else installed on your computer can find its way into the build. The first run needs an internet connection and takes a few minutes; `--reuse-venv` keeps the environment from the previous run and is quicker. The result is in `dist/ElectroClean/` (on macOS also `dist/ElectroClean.app`), and with `--zip` the script also writes `dist/ElectroClean-<system>-<processor>.zip`, for example `ElectroClean-windows-x64.zip`. The last lines of the output say where everything is and how large it is.

On Linux, Qt needs a few system libraries to start. On Ubuntu and Debian they can be installed with `sudo apt install libegl1 libgl1 libxkbcommon0 libxkbcommon-x11-0 libfontconfig1 libdbus-1-3 libxcb-cursor0 libxcb-icccm4 libxcb-image0 libxcb-keysyms1 libxcb-render-util0 libxcb-util1`; when the xcb libraries are present on the build machine, PyInstaller copies them into the application, so the people who use it do not need them.

## Builds on GitHub

The workflow `.github/workflows/build-apps.yml` builds the applications for every push to main, for pull requests into main, when a version tag such as `v1.1.0` is pushed, and when it is started by hand from the repository's Actions tab with "Run workflow". Pushes to other branches only run the test-suite on Linux, which is quicker. (The repository is public, so GitHub's standard runners cost nothing; should it become private again, GitHub only starts jobs while the account has Actions minutes or a spending limit available, and every job then fails within seconds without a log.) A build runs `packaging/build.py --zip` on the latest Windows runner, on the latest macOS runner (Apple silicon) and on Ubuntu 22.04. Ubuntu 22.04 is used rather than the newest Ubuntu because a Linux application only runs on systems at least as new as the one it was built on, so building on an older release lets it run on more computers. If the self-test of a build fails, that build fails. Separately, the workflow runs the test-suite (`python -m pytest -q`) on the same three systems, which is the regular check that ElectroClean behaves correctly on Windows and macOS.

## Downloading a build

Released versions are on the repository's Releases page on GitHub (https://github.com/faisalmushtaq/ElectroClean/releases). Each release has `ElectroClean-windows-x64.zip`, `ElectroClean-macos-arm64.zip` and `ElectroClean-linux-x64.zip`, kept permanently and downloadable without a GitHub account, and `SHA256SUMS.txt` with a checksum of each zip file.

The latest build of the main branch, and of any run started by hand, is on the Actions tab: choose the "Build applications" workflow and the run you want. The same three files are listed under Artifacts at the bottom of the run's summary page. Downloading them requires signing in to GitHub, and they are kept for 30 days. A build-logs artifact for each system holds the self-test output and PyInstaller's list of warnings, which help if something goes wrong.

## Making a release

1. Set the new version in `electroclean/__init__.py` (`__version__ = "1.2.0"`) and add a section `## 1.2.0` at the top of `CHANGELOG.md`; that section becomes the text of the release.
2. Commit, push to main and wait for the workflow to pass.
3. Tag the commit and push the tag: `git tag v1.2.0` and `git push origin v1.2.0`.

The workflow then runs the tests and builds on all three systems and, only if every one passes, the `release` job checks that the tag matches `__version__`, takes the notes from `CHANGELOG.md`, checks the three zip files and creates the release with them attached. If anything fails, no release is made; fix the problem, move the tag to the corrected commit (`git tag -f v1.2.0` and `git push -f origin v1.2.0`) and the workflow runs again.

To install, unzip the file anywhere the annotator can write to, such as their home folder or Documents. On Windows, start `ElectroClean.exe` in the `ElectroClean` folder; the folder must stay together, because the programs load everything from the `_internal` folder next to them. On macOS, move `ElectroClean.app` to Applications if you wish and open it. On Linux, run `ElectroClean/ElectroClean`. Use a tool that keeps symbolic links when unzipping on Linux (the `unzip` command and the usual desktop archive managers do).

## Opening an application that is not signed

We do not have code-signing certificates, so the operating systems warn the first time the application is opened. This is expected, and once it has been allowed the warning does not come back for that copy.

On macOS, Gatekeeper will say that the application cannot be checked for malicious software. On macOS 14, right-click (or Control-click) `ElectroClean.app`, choose Open and confirm. On macOS 15 and later that shortcut no longer works: try to open the application once, then go to System Settings, Privacy & Security, and click "Open Anyway" next to the message about ElectroClean. Alternatively, in Terminal, remove the quarantine flag that the browser added to the download, which works on every version:

```
xattr -dr com.apple.quarantine /Applications/ElectroClean.app
```

On Windows, Microsoft Defender SmartScreen may say that it protected your PC. Click "More info" and then "Run anyway". Some institutional computers do not allow this; IT staff can then add an exception for the folder.

On Linux nothing needs to be allowed, although the files must keep their permission to be executed, which unzipping normally preserves.

## Checking an installation

The application has a self-test that needs no data and no display. It creates a small synthetic recording in a temporary folder, loads and filters it, opens the annotation window invisibly, has two pretend annotators each mark and save an artifact through the window's own controls, runs the agreement analysis on what they saved, and then removes the temporary files. It reports each step and ends with "ElectroClean self-test passed" (exit code 0) or with the error that stopped it (exit code 1). It is useful after installing on a new computer, or when someone reports that something does not work.

On macOS and Linux, run it from a terminal, for example `ElectroClean.app/Contents/MacOS/ElectroClean --self-test`. On Windows the desktop application has no console window, so give it a file for the report and wait for it to finish:

```
start /wait ElectroClean.exe --self-test selftest.txt
type selftest.txt
```

The same check works from a normal Python installation with `python -m electroclean --self-test`.

## Size

The Linux build is about 385 MB when unpacked and 185 MB as a zip file. The Windows and macOS builds are of a similar size; the exact figures are printed at the end of each build. Most of the space is taken by Qt (about 100 MB), SciPy, NumPy and their numerical libraries (about 115 MB), pandas, matplotlib and MNE. Each of the three programs also carries its own copy of the compiled Python code, about 24 MB each.

## Supported systems

The Windows build needs 64-bit Windows 10 (version 1809 or later) or Windows 11. The macOS build needs macOS 14 (Sonoma) or later on a Mac with Apple silicon, because the version of Qt for Python we use (PySide6 6.12) requires macOS 14; a build for Intel Macs would need an Intel macOS runner. The Linux build needs a 64-bit Intel or AMD computer with a system at least as new as Ubuntu 22.04 (glibc 2.35), such as Ubuntu 22.04 or later, Debian 12 or later or a recent Fedora, running X11 or Wayland with the usual graphics libraries.

## Licences

ElectroClean itself is free for research, teaching and other non-commercial use under the PolyForm Noncommercial License 1.0.0, which is in `LICENSE.md` next to the programs. The applications also include Qt and Qt for Python (PySide6), which are used under the GNU Lesser General Public License version 3. The LGPL allows them to be distributed with ElectroClean provided that recipients can replace these libraries with their own versions. The one-folder build keeps Qt as separate shared libraries (in `_internal/PySide6`, or `Contents/Frameworks/PySide6` on macOS) rather than merging them into the programs, so a user can swap in a compatible build of Qt. Every build contains `THIRD_PARTY_NOTICES.md`, which lists each bundled library with its version and licence and says where the Qt source code is, and a `licenses` folder (inside `_internal`) with the LGPL and GPL texts and every bundled package's own licence files. After changing dependencies, regenerate the notices with `python scripts/third_party_notices.py`.

## Changing the build

If ElectroClean starts reading a new kind of data file, add it under `[tool.setuptools.package-data]` in `pyproject.toml` as usual; the spec already collects every non-Python file inside the `electroclean` package. New Python modules are found automatically. A new third-party dependency usually needs nothing more than adding it to `requirements.txt`, but if it loads parts of itself by name or reads files from its own folder, the self-test or the annotators will find out, and the spec may need an extra hidden import or data entry. After changing dependencies or the spec, build locally or push to a branch and check that the self-test still passes on all three systems.
