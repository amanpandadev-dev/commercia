@echo off
setlocal
cd /d "%~dp0"
title Commercia setup
echo.
echo   Commercia setup
echo   ===============
echo.

where node >nul 2>nul
if errorlevel 1 goto :nonode

for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
for /f %%v in ('node -v') do set NODE_VER=%%v
echo   Node.js %NODE_VER% found.
if %NODE_MAJOR% LSS 20 goto :oldnode
set /a NODE_ODD=%NODE_MAJOR% %% 2
if %NODE_ODD%==1 echo   Note: Node %NODE_MAJOR% is not an LTS release. If the install fails on better-sqlite3, install the LTS version from https://nodejs.org and run setup again.

echo.
echo   [1/3] Installing packages. The first time takes a few minutes...
echo.
call npm install --no-audit --no-fund
if errorlevel 1 goto :installfail

echo.
echo   [2/3] Building the app...
echo.
call npm run build
if errorlevel 1 goto :buildfail

echo.
echo   [3/3] Database
if exist "data\commercia.db" goto :keepdb
echo.
echo   No database yet. You can start with the demo shop - Sharma Kirana Store -
echo   to try things out, or start empty and create your own Admin account.
echo.
choice /c YN /n /m "  Load the demo shop? [Y/N] "
if errorlevel 2 goto :nodemo
call npm run seed:demo
if errorlevel 1 goto :seedfail
echo.
echo   Demo loaded. Log in as ramesh@shop.in or amit@shop.in, password demo1234.
echo   Before real use: Settings - Before go-live - wipes the demo data.
goto :done

:nodemo
echo   Starting empty. The first screen will ask for the shop name and the Admin account.
goto :done

:keepdb
echo   Existing database kept: data\commercia.db
goto :done

:done
echo.
echo   Setup finished. Double-click start.bat to open Commercia.
echo.
pause
exit /b 0

:nonode
echo   Node.js is not installed.
echo.
echo   Install the LTS version, either from https://nodejs.org
echo   or by running this in a terminal:   winget install OpenJS.NodeJS.LTS
echo.
echo   Then close this window and double-click setup.bat again.
echo.
pause
exit /b 1

:oldnode
echo.
echo   Commercia needs Node.js 20 or newer. Install the LTS version from
echo   https://nodejs.org, close this window and run setup.bat again.
echo.
pause
exit /b 1

:installfail
echo.
echo   The package install failed. Look at the red lines above:
echo.
echo   - better-sqlite3, node-gyp or prebuild: this Node version has no ready-made
echo     SQLite driver. Install Node.js LTS from https://nodejs.org, delete the
echo     node_modules folder, and run setup.bat again.
echo   - ECONNRESET, ETIMEDOUT or certificate errors: the network cut the download.
echo     Try again, or another network such as a phone hotspot, or pause the
echo     antivirus HTTPS scanning while installing.
echo   - EPERM or EBUSY: close editors and other terminals using this folder, then retry.
echo.
pause
exit /b 1

:buildfail
echo.
echo   The build failed. Copy the error above and send it to whoever maintains Commercia.
echo.
pause
exit /b 1

:seedfail
echo.
echo   Loading the demo failed. Copy the error above and send it on.
echo.
pause
exit /b 1
