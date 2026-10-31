@echo off
setlocal
cd /d "%~dp0"
rem Windows Firewall for Commercia: one inbound rule for the shop network. Usage: firewall.bat allow ^| remove ^| status  (add -Tailscale to allow)
set ACTION=%1
if "%ACTION%"=="" set ACTION=status
net session >nul 2>&1
if %errorlevel% neq 0 (
  if /i "%ACTION%"=="status" goto :run
  echo Asking Windows for permission to change the firewall...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
  exit /b
)
:run
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0firewall.ps1" -Action %ACTION% %2 %3
echo.
pause
