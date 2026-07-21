@echo off
setlocal EnableExtensions

pushd "%~dp0"
call npm run android:build
set "EXIT_CODE=%ERRORLEVEL%"
popd

exit /b %EXIT_CODE%
