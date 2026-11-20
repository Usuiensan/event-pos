@echo off
setlocal
cd /d %~dp0
if not exist "%~dp0update-usb-kit.ps1" if exist "%~dp0update-usb-kit.ps1.prev" move /y "%~dp0update-usb-kit.ps1.prev" "%~dp0update-usb-kit.ps1" >nul
if exist "%~dp0update-usb-kit.ps1.new" (
  if exist "%~dp0update-usb-kit.ps1" move /y "%~dp0update-usb-kit.ps1" "%~dp0update-usb-kit.ps1.prev" >nul
  move /y "%~dp0update-usb-kit.ps1.new" "%~dp0update-usb-kit.ps1" >nul
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-usb-kit.ps1" %*
if errorlevel 1 pause
