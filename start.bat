@echo off
setlocal
rem ============================================================
rem  Mapbox Heightmap Importer - launcher
rem  Installs dependencies on first run, then starts dev mode.
rem  Keeps the window open on error so messages stay visible.
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

echo Starting app... [keep this window open]
call npm run dev
echo.
echo [EXIT] App closed. If an error is shown above, please check it.

:hold
echo.
pause
endlocal
