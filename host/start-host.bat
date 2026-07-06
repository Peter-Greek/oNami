@echo off
setlocal

cd /d "%~dp0"

if "%ONAMI_PM2_NAME%"=="" set "ONAMI_PM2_NAME=onami-host"
if "%ONAMI_HOST_PORT%"=="" set "ONAMI_HOST_PORT=41729"
if "%ONAMI_HOST_BIND%"=="" set "ONAMI_HOST_BIND=127.0.0.1"
if "%ONAMI_PUBLIC_PORT%"=="" set "ONAMI_PUBLIC_PORT=41729"
if "%ONAMI_PUBLIC_LISTEN%"=="" set "ONAMI_PUBLIC_LISTEN=0.0.0.0"
if "%ONAMI_ENABLE_PORTPROXY%"=="" set "ONAMI_ENABLE_PORTPROXY=0"

where pm2 >nul 2>nul
if errorlevel 1 (
  echo pm2 was not found on PATH.
  echo Install it with: npm install -g pm2
  exit /b 1
)

echo Stopping old %ONAMI_PM2_NAME% process if it exists...
call pm2 delete "%ONAMI_PM2_NAME%" >nul 2>nul

if "%ONAMI_ENABLE_PORTPROXY%"=="1" (
  echo Resetting portproxy %ONAMI_PUBLIC_LISTEN%:%ONAMI_PUBLIC_PORT% -^> %ONAMI_HOST_BIND%:%ONAMI_HOST_PORT%
  netsh interface portproxy delete v4tov4 listenaddress=%ONAMI_PUBLIC_LISTEN% listenport=%ONAMI_PUBLIC_PORT% >nul 2>nul
  netsh interface portproxy add v4tov4 listenaddress=%ONAMI_PUBLIC_LISTEN% listenport=%ONAMI_PUBLIC_PORT% connectaddress=%ONAMI_HOST_BIND% connectport=%ONAMI_HOST_PORT%
  if errorlevel 1 (
    echo Failed to configure portproxy. Run this batch file from an elevated administrator prompt.
    exit /b 1
  )

  echo Opening Windows Firewall for TCP %ONAMI_PUBLIC_PORT%...
  netsh advfirewall firewall delete rule name="oNami Host %ONAMI_PUBLIC_PORT%" >nul 2>nul
  netsh advfirewall firewall add rule name="oNami Host %ONAMI_PUBLIC_PORT%" dir=in action=allow protocol=TCP localport=%ONAMI_PUBLIC_PORT%
  if errorlevel 1 (
    echo Failed to configure Windows Firewall. Run this batch file from an elevated administrator prompt.
    exit /b 1
  )
)

echo Starting %ONAMI_PM2_NAME% with PM2...
call pm2 start ecosystem.config.cjs --only "%ONAMI_PM2_NAME%" --update-env
if errorlevel 1 exit /b 1

call pm2 save
call pm2 status "%ONAMI_PM2_NAME%"

echo.
echo Checking local health endpoint...
for /l %%i in (1,1,20) do (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:%ONAMI_HOST_PORT%/health' -TimeoutSec 2; if ($r.ok) { exit 0 } } catch { exit 1 }"
  if not errorlevel 1 goto :healthy
  timeout /t 1 /nobreak >nul
)

echo.
echo oNami host did not respond on http://127.0.0.1:%ONAMI_HOST_PORT%/health.
echo PM2 logs:
call pm2 logs "%ONAMI_PM2_NAME%" --lines 50 --nostream
echo.
echo Listening ports matching %ONAMI_HOST_PORT%:
netstat -ano | findstr ":%ONAMI_HOST_PORT%"
exit /b 1

:healthy
echo oNami host is healthy on http://127.0.0.1:%ONAMI_HOST_PORT%.
if "%ONAMI_ENABLE_PORTPROXY%"=="1" echo Public portproxy is listening on %ONAMI_PUBLIC_LISTEN%:%ONAMI_PUBLIC_PORT%.

endlocal
