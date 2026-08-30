@echo off
echo ===========================================
echo Ledo Downloader - Smart Build Script
echo ===========================================

echo.
echo [1/4] Checking Python Requirements...
pip show pyinstaller >nul 2>&1
IF ERRORLEVEL 1 (
    echo Installing Python dependencies...
    pip install -r backend\requirements.txt
    pip install pyinstaller
) ELSE (
    echo Python dependencies already installed. Skipping...
)

echo.
echo [2/4] Building Python Backend with PyInstaller...
cd backend
echo Compiling backend...
pyinstaller --noconfirm --onefile --windowed --noupx main.py
cd ..

echo.
echo [3/4] Checking Node Dependencies...
IF NOT EXIST "node_modules\" (
    echo Installing Node dependencies...
    call npm install
) ELSE (
    echo Node dependencies already installed. Skipping...
)

echo.
echo [4/4] Packaging Electron App...
call npm run build

echo.
echo [5/5] Copying Browser Extension to dist...
xcopy browser_extension dist\win-unpacked\browser_extension /E /I /Y

echo.
echo ===========================================
echo Build Complete!
echo You can find the installer in the "dist" folder.
echo ===========================================
pause
