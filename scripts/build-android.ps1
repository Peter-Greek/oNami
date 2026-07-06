$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$defaultSdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'

if (-not $env:ANDROID_HOME -and (Test-Path $defaultSdk)) {
  $env:ANDROID_HOME = $defaultSdk
}

if (-not $env:ANDROID_SDK_ROOT -and $env:ANDROID_HOME) {
  $env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
}

if (-not $env:ANDROID_HOME) {
  throw 'ANDROID_HOME is not set and the default SDK path was not found.'
}

function Get-JavaMajor([string] $javaHome) {
  if (-not $javaHome) {
    return $null
  }

  $javaExe = Join-Path $javaHome 'bin\java.exe'
  if (-not (Test-Path $javaExe)) {
    return $null
  }

  $previousErrorAction = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $versionText = (& $javaExe -version 2>&1 | Out-String)
  $ErrorActionPreference = $previousErrorAction
  if ($versionText -match 'version "(\d+)') {
    return [int] $Matches[1]
  }

  return $null
}

$javaMajor = Get-JavaMajor $env:JAVA_HOME

if ($javaMajor -ne 17) {
  $jdkZip = Join-Path $env:TEMP 'onami-temurin-jdk17.zip'
  $jdkDir = Join-Path $env:TEMP 'onami-temurin-jdk17'

  if (-not (Test-Path $jdkZip)) {
    Invoke-WebRequest `
      -Uri 'https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk' `
      -OutFile $jdkZip
  }

  if (-not (Test-Path $jdkDir)) {
    New-Item -ItemType Directory -Force $jdkDir | Out-Null
    Expand-Archive -LiteralPath $jdkZip -DestinationPath $jdkDir -Force
  }

  $downloadedJdk = Get-ChildItem -Directory $jdkDir | Select-Object -First 1
  if (-not $downloadedJdk) {
    throw 'Could not locate the downloaded JDK 17 directory.'
  }

  $env:JAVA_HOME = $downloadedJdk.FullName
}

Push-Location $repoRoot
try {
  npm run build:renderer
  npm run android:sync-assets

  Push-Location (Join-Path $repoRoot 'android')
  try {
    & .\gradlew.bat assembleDebug
  } finally {
    Pop-Location
  }
} finally {
  Pop-Location
}
