@echo off
setlocal

echo Building oNami Windows installer...
call npm install
if errorlevel 1 exit /b %errorlevel%

call npm run build:win
if errorlevel 1 exit /b %errorlevel%

echo.
echo Done. Installer output is in the release folder.
endlocal
