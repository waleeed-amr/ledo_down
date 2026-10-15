@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo [ERROR] Python virtual environment not found: .venv\Scripts\python.exe
    echo Run build.bat once to create it and install backend dependencies.
    if /I not "%~1"=="/nopause" pause
    exit /b 1
)

echo Building backend with PyInstaller...
pushd "backend"
call "..\.venv\Scripts\python.exe" -m PyInstaller --noconfirm --clean --onefile --windowed --noupx main.py
set "BUILD_RESULT=%ERRORLEVEL%"
popd

if not "%BUILD_RESULT%"=="0" (
    echo [ERROR] Backend build failed.
    if /I not "%~1"=="/nopause" pause
    exit /b %BUILD_RESULT%
)

if not exist "backend\dist\main.exe" (
    echo [ERROR] backend\dist\main.exe was not created.
    if /I not "%~1"=="/nopause" pause
    exit /b 1
)

echo [OK] Backend built: backend\dist\main.exe
if /I not "%~1"=="/nopause" pause
exit /b 0
