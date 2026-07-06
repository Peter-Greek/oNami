@echo off
setlocal

if "%ONAMI_PM2_NAME%"=="" set "ONAMI_PM2_NAME=onami-host"
if "%ONAMI_PUBLIC_PORT%"=="" set "ONAMI_PUBLIC_PORT=41729"
if "%ONAMI_PUBLIC_LISTEN%"=="" set "ONAMI_PUBLIC_LISTEN=0.0.0.0"
if "%ONAMI_DISABLE_PORTPROXY%"=="" set "ONAMI_DISABLE_PORTPROXY=0"

where pm2 >nul 2>nul
if errorlevel 1 (
  echo pm2 was not found on PATH.
  exit /b 1
)

echo Stopping %ONAMI_PM2_NAME%...
call pm2 delete "%ONAMI_PM2_NAME%"
call pm2 save

if "%ONAMI_DISABLE_PORTPROXY%"=="1" (
  echo Removing portproxy %ONAMI_PUBLIC_LISTEN%:%ONAMI_PUBLIC_PORT%...
  netsh interface portproxy delete v4tov4 listenaddress=%ONAMI_PUBLIC_LISTEN% listenport=%ONAMI_PUBLIC_PORT%
  netsh advfirewall firewall delete rule name="oNami Host %ONAMI_PUBLIC_PORT%"
)

endlocal
