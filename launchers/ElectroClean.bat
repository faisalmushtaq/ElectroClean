@echo off
rem Double-click this file to start ElectroClean on Windows.
rem On first use it creates a private Python environment in ElectroClean\.venv and
rem installs the pinned dependencies (from .\wheels if present, otherwise from the
rem internet). Afterwards it works offline. When requirements.txt changes (an update
rem of ElectroClean), or an earlier installation was interrupted, the dependencies
rem are installed again at the next start, in this window, so that any problem can
rem be seen.
setlocal
cd /d "%~dp0.."

if not exist ".venv\Scripts\python.exe" goto setup
".venv\Scripts\python.exe" launchers\check_environment.py check
if not errorlevel 1 goto run
echo Updating ElectroClean's Python environment...
".venv\Scripts\python.exe" -c "import sys" >nul 2>nul
if errorlevel 1 rmdir /s /q .venv
if exist ".venv\Scripts\python.exe" goto install

:setup
echo Setting up ElectroClean for first use...
if exist .venv rmdir /s /q .venv
set "PYCMD="
where py >nul 2>nul
if errorlevel 1 goto trypython
py -3.13 -c "import sys" >nul 2>nul
if not errorlevel 1 set "PYCMD=py -3.13"
if defined PYCMD goto makevenv
py -3.12 -c "import sys" >nul 2>nul
if not errorlevel 1 set "PYCMD=py -3.12"
if defined PYCMD goto makevenv
:trypython
python -c "import sys; sys.exit(0 if sys.version_info[:2] in ((3, 12), (3, 13)) else 1)" >nul 2>nul
if not errorlevel 1 set "PYCMD=python"
if not defined PYCMD goto nopython
:makevenv
%PYCMD% -m venv .venv
if errorlevel 1 goto failed

:install
if exist wheels goto installwheels
".venv\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 goto failed
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto failed
goto installed
:installwheels
".venv\Scripts\python.exe" -m pip install --no-index --find-links wheels -r requirements.txt
if errorlevel 1 goto failed
:installed
".venv\Scripts\python.exe" launchers\check_environment.py check-packages
if errorlevel 1 goto failed
".venv\Scripts\python.exe" launchers\check_environment.py write
if errorlevel 1 goto failed

:run
rem Run from the ElectroClean folder, so the package does not need to be installed.
start "" ".venv\Scripts\pythonw.exe" -m electroclean %*
exit /b 0

:nopython
echo Python 3.12 or 3.13 was not found.
echo Install it from https://www.python.org/downloads/ (tick "Add python.exe to PATH") and try again.
pause
exit /b 1

:failed
echo.
echo Installation failed. The partly installed environment has been removed, so the next
echo start tries again from the beginning. If it keeps failing, please send the messages
echo above to the study administrator.
if exist .venv rmdir /s /q .venv
pause
exit /b 1
