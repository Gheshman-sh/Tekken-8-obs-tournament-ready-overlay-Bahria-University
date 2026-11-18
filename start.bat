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

set "LAN_IP="
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.IPv4Address } | Sort-Object InterfaceMetric | Select-Object -First 1).IPv4Address.IPAddress"`) do set "LAN_IP=%%I"

if defined LAN_IP (
    netsh advfirewall firewall add rule name="Tekken Tournament Port 3000" dir=in action=allow protocol=TCP localport=3000 profile=private >nul 2>&1
    echo LAN control panel: http://%LAN_IP%:3000/control
    echo LAN overlay:       http://%LAN_IP%:3000/overlay
    start "" "http://%LAN_IP%:3000/control"
) else (
    echo Could not detect a LAN IPv4 address.
    echo Starting with localhost instead.
    start "" "http://localhost:3000/control"
)

curl.exe --silent --fail --max-time 2 http://127.0.0.1:3000/api/network >nul 2>&1
if not errorlevel 1 (
    echo The tournament server is already running.
    exit /b 0
)

echo Starting the tournament server...
node server.js
if errorlevel 1 pause
