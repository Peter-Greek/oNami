@echo off
setlocal enabledelayedexpansion
title oNami Host Setup
color 0B

echo.
echo  ==================================================
echo  oNami HOST - POSTGRES SETUP
echo  ==================================================
echo.

(
echo const c = require("crypto"^);
echo const mode = process.argv[2];
echo if (mode === "pass"^) console.log(c.randomBytes(24^).toString("hex"^)^);
) > _onami_gen.cjs

echo [1/5] Checking Node.js ...
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found on PATH.
  del /q _onami_gen.cjs >nul 2>&1
  pause
  exit /b 1
)

echo [2/5] Locating PostgreSQL ...
set "PSQL_CMD="
where psql >nul 2>&1
if not errorlevel 1 (
  set "PSQL_CMD=psql"
  goto :psql_found
)

for %%d in (
  "C:\Program Files\PostgreSQL"
  "C:\Program Files (x86)\PostgreSQL"
  "%ProgramFiles%\PostgreSQL"
) do (
  if exist %%d (
    for /d %%v in (%%d\*) do (
      if exist "%%v\bin\psql.exe" (
        set "PSQL_CMD=%%v\bin\psql.exe"
        goto :psql_found
      )
    )
  )
)

echo [ERROR] PostgreSQL psql.exe was not found.
del /q _onami_gen.cjs >nul 2>&1
pause
exit /b 1

:psql_found
echo Found psql: %PSQL_CMD%
echo.

echo [3/5] PostgreSQL credentials
set /p "PG_SUPER_PASS=Enter postgres superuser password: "
set "PGPASSWORD=%PG_SUPER_PASS%"
"%PSQL_CMD%" -U postgres -h localhost -c "SELECT 1;" >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Could not connect to PostgreSQL as postgres.
  del /q _onami_gen.cjs >nul 2>&1
  pause
  exit /b 1
)

echo [4/5] Creating oNami database/user ...
for /f "tokens=*" %%p in ('node _onami_gen.cjs pass') do set "ONAMI_DB_PASS=%%p"
if errorlevel 1 (
  echo [ERROR] Could not generate database password.
  del /q _onami_gen.cjs >nul 2>&1
  pause
  exit /b 1
)
if "%ONAMI_DB_PASS%"=="" (
  echo [ERROR] Generated database password was empty.
  del /q _onami_gen.cjs >nul 2>&1
  pause
  exit /b 1
)
del /q _onami_gen.cjs >nul 2>&1

"%PSQL_CMD%" -U postgres -h localhost -c "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'onami_user') THEN CREATE ROLE onami_user WITH LOGIN PASSWORD '%ONAMI_DB_PASS%'; ELSE ALTER ROLE onami_user WITH LOGIN PASSWORD '%ONAMI_DB_PASS%'; END IF; END $$;" >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Could not create or update onami_user.
  pause
  exit /b 1
)

"%PSQL_CMD%" -U postgres -h localhost -tc "SELECT 1 FROM pg_database WHERE datname = 'onami_sync';" 2>nul | findstr /c:"1" >nul 2>&1
if errorlevel 1 (
  "%PSQL_CMD%" -U postgres -h localhost -c "CREATE DATABASE onami_sync OWNER onami_user;" >nul 2>&1
  if errorlevel 1 (
    echo [ERROR] Could not create onami_sync database.
    pause
    exit /b 1
  )
) else (
  "%PSQL_CMD%" -U postgres -h localhost -c "ALTER DATABASE onami_sync OWNER TO onami_user;" >nul 2>&1
)

"%PSQL_CMD%" -U postgres -h localhost -c "GRANT ALL PRIVILEGES ON DATABASE onami_sync TO onami_user;" >nul 2>&1
"%PSQL_CMD%" -U postgres -h localhost -d onami_sync -c "GRANT ALL ON SCHEMA public TO onami_user;" >nul 2>&1
"%PSQL_CMD%" -U postgres -h localhost -d onami_sync -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO onami_user;" >nul 2>&1

(
echo DATABASE_URL="postgresql://onami_user:%ONAMI_DB_PASS%@localhost:5432/onami_sync?schema=public"
echo ONAMI_HOST_BIND="127.0.0.1"
echo ONAMI_HOST_PORT="41730"
echo ONAMI_HOST_CORS_ORIGIN="*"
) > .env

echo [5/5] Installing dependencies and creating tables ...
call npm install --include=dev
if errorlevel 1 (
  echo [ERROR] npm install failed.
  pause
  exit /b 1
)

call npm run prisma:generate
if errorlevel 1 (
  echo [ERROR] prisma generate failed.
  pause
  exit /b 1
)

call npm run prisma:push -- --accept-data-loss
if errorlevel 1 (
  echo [ERROR] prisma db push failed.
  pause
  exit /b 1
)

echo.
echo Setup complete.
echo Database: onami_sync
echo DB user:  onami_user
echo Host:     http://127.0.0.1:41730
echo.
pause
