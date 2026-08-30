@echo off
title Ledo Mobile - Build APK (Local)
color 0A

echo ================================================
echo   LEDO DOWNLOADER - MOBILE APK LOCAL BUILDER
echo ================================================
echo.

cd /d "%~dp0"

echo [1/4] Syncing web files to www/...
node sync.js
if %errorlevel% neq 0 (
    echo [ERROR] Sync failed!
    pause
    exit /b 1
)

echo [2/4] Capacitor sync to Android project...
call npx cap sync android
if %errorlevel% neq 0 (
    echo [ERROR] Capacitor sync failed!
    pause
    exit /b 1
)

echo [3/4] Building APK with Gradle...
echo Setting environment variables for C:\Android...
set ANDROID_HOME=C:\Android
set JAVA_HOME=C:\Android\jdk-21.0.11
set PATH=%JAVA_HOME%\bin;%PATH%

cd android
call gradlew assembleDebug
if %errorlevel% neq 0 (
    echo [ERROR] Gradle build failed!
    cd ..
    pause
    exit /b 1
)
cd ..

echo [4/4] Copying APK to mobile folder...
copy "android\app\build\outputs\apk\debug\app-debug.apk" "LedoDownloader-Mobile.apk" >nul

echo ================================================
echo ? SUCCESS! 
echo The APK has been built and saved as:
echo LedoDownloader-Mobile.apk
echo ================================================
pause
