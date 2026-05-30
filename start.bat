@echo off
setlocal
rem ============================================================
rem  Mapbox Heightmap Importer - launcher
rem  Installs dependencies on first run, then starts dev mode.
rem  The window closes automatically when the app exits normally.
rem  On setup/start errors it stays open so messages stay visible.
rem ============================================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Install it from https://nodejs.org/
    goto :hold
)

if not exist "node_modules" (
    echo [SETUP] Installing dependencies for the first time...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        goto :hold
    )
)

echo Starting app... [this window closes when the app exits]
call npm run dev
if errorlevel 1 (
    echo.
    echo [ERROR] The app exited with an error.
    goto :hold
)
rem Normal exit: close this window without pausing.
goto :done

:hold
echo.
pause

:done
endlocal
