@echo off
setlocal enabledelayedexpansion

echo ===================================================
echo   Ledo Downloader - GitHub Auto-Update Publisher
echo ===================================================
echo.

:: Check if GH_TOKEN is set
if "%GH_TOKEN%"=="" (
    echo [ERROR] GH_TOKEN environment variable is not set.
    echo Please set it using: set GH_TOKEN=your_github_token
    echo Or paste your token below:
    set /p INPUT_TOKEN="GitHub Token: "
    if "!INPUT_TOKEN!"=="" (
        echo [ERROR] No token provided. Exiting.
        pause
        exit /b 1
    )
    set GH_TOKEN=!INPUT_TOKEN!
)

echo.
echo [1/3] Updating patch version in package.json...
call npm version patch -m "Bump version to %s for auto-update release"
if errorlevel 1 (
    echo [ERROR] Failed to bump version. Are your git working directory clean?
    pause
    exit /b 1
)

echo.
echo [2/3] Pushing changes to GitHub...
git push
git push --tags
if errorlevel 1 (
    echo [ERROR] Failed to push to GitHub.
    pause
    exit /b 1
)

echo.
echo [3/3] Building and publishing to GitHub Releases...
echo This will generate the executable and .blockmap for differential updates.
call npx electron-builder --win --publish always
if errorlevel 1 (
    echo [ERROR] Electron Builder failed.
    pause
    exit /b 1
)

echo.
echo ===================================================
echo   SUCCESS! Release published successfully!
echo   Users will now get this update automatically.
echo ===================================================
pause
