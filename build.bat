@echo off
setlocal
cd /d "%~dp0"
title Ledo Downloader - Full Build

echo ========================================
echo   Building Ledo Downloader (Backend + Frontend)
echo ========================================
echo.

if not exist ".venv\Scripts\python.exe" (
    echo [1/4] Creating Python virtual environment...
    where py >nul 2>&1
    if not errorlevel 1 (
        py -3 -m venv .venv
    ) else (
        where python >nul 2>&1
        if errorlevel 1 goto :python_missing
        python -m venv .venv
    )
    if errorlevel 1 goto :failed
)

echo [2/4] Installing/verifying backend build dependencies...
call ".venv\Scripts\python.exe" -m pip install -r "backend\requirements.txt" pyinstaller
if errorlevel 1 goto :failed

echo.
echo [3/4] Building backend...
call "back build.bat" /nopause
if errorlevel 1 goto :failed

if not exist "node_modules" (
    echo Installing frontend build dependencies...
    call npm install
    if errorlevel 1 goto :failed
)

echo.
echo [4/4] Building frontend and packaging the application...
call "front build.bat"
if errorlevel 1 goto :failed

echo.
echo ========================================
echo   FULL BUILD COMPLETED SUCCESSFULLY
echo ========================================
echo Backend: backend\dist\main.exe
echo Installer: dist\Ledo-Downloader-Setup-*.exe
pause
exit /b 0

:python_missing
echo [ERROR] Python 3 was not found. Install Python and try again.
goto :failed

:failed
echo.
echo [ERROR] Build failed. Review the messages above.
pause
exit /b 1
