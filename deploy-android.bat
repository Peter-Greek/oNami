@echo off
setlocal EnableExtensions

set "ROOT=%~dp0"
set "APK=%ROOT%android\app\build\outputs\apk\debug\app-debug.apk"
set "PACKAGE_NAME=app.onami.flashcards"

if defined ANDROID_HOME if exist "%ANDROID_HOME%\platform-tools\adb.exe" set "ADB=%ANDROID_HOME%\platform-tools\adb.exe"
if not defined ADB if defined ANDROID_SDK_ROOT if exist "%ANDROID_SDK_ROOT%\platform-tools\adb.exe" set "ADB=%ANDROID_SDK_ROOT%\platform-tools\adb.exe"
if not defined ADB if exist "%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe" set "ADB=%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe"
if not defined ADB (
  for /f "delims=" %%A in ('where adb 2^>nul') do (
    if not defined ADB set "ADB=%%A"
  )
)

if not defined ADB (
  echo [ERROR] Could not find adb.exe. Install Android SDK platform-tools or set ANDROID_HOME.
  exit /b 1
)

if not exist "%APK%" (
  echo [ERROR] APK not found:
  echo         "%APK%"
  echo Run build-android.bat first.
  exit /b 1
)

echo Using ADB: "%ADB%"
echo Checking connected devices...
"%ADB%" devices -l
"%ADB%" get-state >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] No authorized Android device is connected.
  echo Plug in the phone, unlock it, and accept the USB debugging prompt.
  exit /b 1
)

echo Installing "%APK%"...
"%ADB%" install -r "%APK%"
if errorlevel 1 exit /b 1

echo Launching %PACKAGE_NAME%...
"%ADB%" shell monkey -p %PACKAGE_NAME% -c android.intent.category.LAUNCHER 1 >nul
if errorlevel 1 (
  echo [ERROR] Install succeeded, but launch failed.
  exit /b 1
)

echo Done.
exit /b 0
