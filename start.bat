@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js 18 or newer is required.
    echo Download it from https://nodejs.org/
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo Installing npm dependencies...
    call npm install
    if errorlevel 1 (
        echo Dependency installation failed.
        pause
        exit /b 1
    )
)

echo Starting the tournament server...
start "" "http://localhost:3000/control"
node server.js
if errorlevel 1 pause
