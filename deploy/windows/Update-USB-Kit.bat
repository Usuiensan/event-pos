@echo off
setlocal
if exist "%~dp0Update-USB-Kit.bat.new" (
  move /y "%~dp0Update-USB-Kit.bat.new" "%~dp0Update-USB-Kit.bat" >nul
  "%~dp0Update-USB-Kit.bat" %*
  exit /b %ERRORLEVEL%
)
cd /d %~dp0
if not exist "%~dp0update-usb-kit.ps1" if exist "%~dp0update-usb-kit.ps1.prev" move /y "%~dp0update-usb-kit.ps1.prev" "%~dp0update-usb-kit.ps1" >nul
if exist "%~dp0update-usb-kit.ps1.new" (
  if exist "%~dp0update-usb-kit.ps1" move /y "%~dp0update-usb-kit.ps1" "%~dp0update-usb-kit.ps1.prev" >nul
  move /y "%~dp0update-usb-kit.ps1.new" "%~dp0update-usb-kit.ps1" >nul
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-usb-kit.ps1" %*
set "RC=%ERRORLEVEL%"
if %RC% NEQ 0 pause
if %RC% NEQ 0 exit /b %RC%
echo.
echo 終了しました。このウィンドウは10秒後に閉じます（何かキーを押すとすぐ閉じます）。
timeout /t 10 2>nul
exit /b 0
