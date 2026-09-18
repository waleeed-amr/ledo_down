@echo off
set "ROOT_DIR=%~dp0"
cd /d "%ROOT_DIR%"
setlocal enabledelayedexpansion

echo ========================================================
echo   Ledo Downloader - Standalone Setup Build Script
echo ========================================================

:: Detect Python & PyInstaller
set "PYTHON_EXE=python"
set "PYINSTALLER_EXE=pyinstaller"

if exist "%ROOT_DIR%.venv\Scripts\python.exe" (
    echo [*] Virtual environment detected: .venv. Using it...
    set "PYTHON_EXE=%ROOT_DIR%.venv\Scripts\python.exe"
    set "PIP_EXE=%ROOT_DIR%.venv\Scripts\pip.exe"
    if exist "%ROOT_DIR%.venv\Scripts\pyinstaller.exe" (
        set "PYINSTALLER_EXE=%ROOT_DIR%.venv\Scripts\pyinstaller.exe"
    ) else (
        echo [*] Installing PyInstaller in virtual environment...
        call "!PIP_EXE!" install pyinstaller
        set "PYINSTALLER_EXE=%ROOT_DIR%.venv\Scripts\pyinstaller.exe"
    )
) else (
    echo [*] Checking system PyInstaller...
    where pyinstaller >nul 2>&1
    if errorlevel 1 (
        echo [*] Installing requirements and PyInstaller...
        pip install -r backend\requirements.txt
        pip install pyinstaller
    )
)

echo.
echo [1/3] Building Python Backend with PyInstaller...
cd /d "%ROOT_DIR%backend" || (
    echo [!] ERROR: Could not find 'backend' folder!
    pause
    exit /b 1
)
if exist "dist\main.exe" del /f /q "dist\main.exe"
echo Compiling backend into standalone executable...
call "!PYINSTALLER_EXE!" --noconfirm --onefile --windowed --noupx main.py
if errorlevel 1 (
    echo [!] ERROR: PyInstaller failed to compile the backend!
    cd /d "%ROOT_DIR%"
    pause
    exit /b 1
)
cd /d "%ROOT_DIR%"

if not exist "%ROOT_DIR%backend\dist\main.exe" (
    echo [!] ERROR: backend\dist\main.exe was not created!
    pause
    exit /b 1
)
echo [OK] Backend compiled successfully: backend\dist\main.exe

echo.
echo [2/3] Checking Node Dependencies...
if not exist "node_modules\" (
    echo Installing Node dependencies...
    call npm install
) else (
    echo Node dependencies already installed. Skipping...
)

echo.
echo [3/3] Packaging Standalone Setup Installer (Electron + NSIS)...
if exist "dist\" (
    echo Cleaning previous dist folder...
    rmdir /s /q "dist" 2>nul
)
call npm run build
if errorlevel 1 (
    echo [!] ERROR: Electron build failed!
    pause
    exit /b 1
)

echo.
echo ========================================================
echo   BUILD SUCCESSFUL!
echo ========================================================
echo.
echo Standalone Setup file is generated in the "dist" folder:
echo.
for %%F in (dist\*Setup*.exe) do (
    echo   ==^> dist\%%~nxF - Size: %%~zF bytes
)
echo.
echo You can now send this single Setup file to anyone.
echo It installs everything completely with zero extra requirements!
echo ========================================================
echo.
pause
exit /b 0
