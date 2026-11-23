@echo off
"%~dp0runtime\node.exe" "%~dp0server\dist\start.mjs"
if errorlevel 1 pause
