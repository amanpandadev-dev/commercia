@echo off
setlocal
cd /d "%~dp0"
title Commercia - keep this window open

where node >nul 2>nul
if errorlevel 1 goto :needsetup
if not exist "node_modules\tsx" goto :needsetup
if not exist "dist\index.html" call npm run build

rem Open the browser once the server has had a few seconds to start.
start "" /min cmd /c "timeout /t 5 /nobreak >nul & start "" http://localhost:8787"

echo.
echo   Keep this window open while Commercia is in use. Close it to stop.
echo   If Windows asks about the firewall, allow Private networks so phones
echo   on the shop Wi-Fi can open the address shown below.
echo.
call npm run serve --silent

echo.
echo   Commercia stopped. If you see EADDRINUSE above, it is already running
echo   in another window - just open http://localhost:8787
echo.
pause
exit /b 0

:needsetup
echo.
echo   Commercia is not set up on this computer yet. Double-click setup.bat first.
echo.
pause
exit /b 1
