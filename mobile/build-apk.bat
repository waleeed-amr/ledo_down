@echo off
echo ===========================================
echo  Ledo Downloader Mobile - Build APK
echo ===========================================
echo.

cd /d "%~dp0"

REM Set Android SDK paths
set ANDROID_HOME=C:\Android
set JAVA_HOME=C:\Android\jdk-21.0.11
set PATH=%JAVA_HOME%\bin;%ANDROID_HOME%\platform-tools;%PATH%

REM Check requirements
echo [1/5] Checking Java...
java -version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Java not found. Set JAVA_HOME to a JDK 17+ installation.
    pause
    exit /b 1
)

echo [2/5] Checking Android SDK...
if not exist "%ANDROID_HOME%\platform-tools\adb.exe" (
    echo ERROR: Android SDK not found at %ANDROID_HOME%
    pause
    exit /b 1
)

echo.
echo [3/5] Installing npm dependencies...
call npm install --legacy-peer-deps
if errorlevel 1 (
    echo ERROR: npm install failed
    pause
    exit /b 1
)

echo.
echo [4/5] Syncing web assets to Android...
call npm run sync
if errorlevel 1 (
    echo ERROR: Sync failed
    pause
    exit /b 1
)

echo.
echo [5/5] Building APK (this may take 5-10 minutes on first run)...
cd android
call gradlew.bat assembleDebug --no-daemon
if errorlevel 1 (
    echo ERROR: Gradle build failed
    pause
    exit /b 1
)

echo.
echo ===========================================
echo  BUILD SUCCESSFUL!
echo ===========================================
echo.
echo APK Location:
echo   android\app\build\outputs\apk\debug\app-debug.apk
echo.
echo To install on connected device:
echo   adb install -r android\app\build\outputs\apk\debug\app-debug.apk
echo.
echo To build release APK (unsigned):
echo   cd android ^&^& gradlew assembleRelease
echo.
pause
