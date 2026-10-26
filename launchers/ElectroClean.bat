@echo off
rem Double-click this file to start ElectroClean on Windows.
rem On first use it creates a private Python environment in ElectroClean\.venv and
rem installs the pinned dependencies (from .\wheels if present, otherwise from the
rem internet). Afterwards it works offline.
setlocal
cd /d "%~dp0.."

if exist ".venv\Scripts\python.exe" goto run

echo Setting up ElectroClean for first use...
set "PYCMD="
where py >nul 2>nul
if not errorlevel 1 (
  py -3.13 -c "import sys" >nul 2>nul && set "PYCMD=py -3.13"
  if not defined PYCMD py -3.12 -c "import sys" >nul 2>nul && set "PYCMD=py -3.12"
)
if not defined PYCMD (
  python -c "import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)" >nul 2>nul && set "PYCMD=python"
)
if not defined PYCMD goto nopython

%PYCMD% -m venv .venv
if errorlevel 1 goto failed
if exist wheels (
  ".venv\Scripts\python.exe" -m pip install --no-index --find-links wheels -r requirements.txt
) else (
  ".venv\Scripts\python.exe" -m pip install --upgrade pip
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
)
if errorlevel 1 goto failed
".venv\Scripts\python.exe" -m pip install --no-deps -e .
if errorlevel 1 goto failed

:run
start "" ".venv\Scripts\pythonw.exe" -m electroclean %*
exit /b 0

:nopython
echo Python 3.12 or newer was not found.
echo Install it from https://www.python.org/downloads/ (tick "Add python.exe to PATH") and try again.
pause
exit /b 1

:failed
echo Installation failed. Please send the messages above to the study administrator.
pause
exit /b 1
