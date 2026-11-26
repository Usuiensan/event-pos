@echo off
"%~dp0runtime\node.exe" "%~dp0server\dist\start.mjs"
set "RC=%ERRORLEVEL%"
if %RC% NEQ 0 pause
if %RC% NEQ 0 exit /b %RC%
echo.
echo 終了しました。このウィンドウは10秒後に閉じます（何かキーを押すとすぐ閉じます）。
timeout /t 10 2>nul
exit /b 0
