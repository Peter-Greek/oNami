param(
  [switch] $InstallDependencies,
  [switch] $Publish
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$defaultSdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'

if (-not $env:ANDROID_HOME) {
  $env:ANDROID_HOME = $defaultSdk
}

if (-not $env:ANDROID_SDK_ROOT -and $env:ANDROID_HOME) {
  $env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
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

function Invoke-ResumableDownload([string] $uri, [string] $destination) {
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if (-not $curl) {
    Invoke-WebRequest -Uri $uri -OutFile $destination
    return
  }

  $curlArguments = @('--fail', '--location', '--retry', '3', '--output', $destination)
  if ((Test-Path $destination) -and (Get-Item -LiteralPath $destination).Length -gt 0) {
    $curlArguments += @('--continue-at', '-')
  }
  $curlArguments += $uri
  & $curl.Source @curlArguments
  if ($LASTEXITCODE -eq 0) {
    return
  }

  if (Test-Path $destination) {
    Remove-Item -Force -LiteralPath $destination
  }
  & $curl.Source --fail --location --retry 3 --output $destination $uri
  if ($LASTEXITCODE -ne 0) {
    throw "Download failed with exit code ${LASTEXITCODE}: $uri"
  }
}

function Get-FileSha256([string] $filePath) {
  $stream = [IO.File]::OpenRead($filePath)
  try {
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
      return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
      $sha256.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

$javaMajor = Get-JavaMajor $env:JAVA_HOME

if ($javaMajor -ne 17) {
  $jdkZip = Join-Path $env:TEMP 'onami-temurin-jdk17.zip'
  $jdkDir = Join-Path $env:TEMP 'onami-temurin-jdk17'

  if (-not (Test-Path $jdkZip)) {
    Invoke-ResumableDownload `
      'https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk' `
      $jdkZip
  }

  $downloadedJdk = Get-ChildItem -Directory $jdkDir -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $downloadedJdk -or (Get-JavaMajor $downloadedJdk.FullName) -ne 17) {
    if (Test-Path $jdkDir) {
      Remove-Item -Recurse -Force -LiteralPath $jdkDir
    }
    New-Item -ItemType Directory -Force $jdkDir | Out-Null
    Expand-Archive -LiteralPath $jdkZip -DestinationPath $jdkDir -Force
  }

  $downloadedJdk = Get-ChildItem -Directory $jdkDir | Select-Object -First 1
  if (-not $downloadedJdk -or (Get-JavaMajor $downloadedJdk.FullName) -ne 17) {
    throw 'Could not locate the downloaded JDK 17 directory.'
  }

  $env:JAVA_HOME = $downloadedJdk.FullName
}

$sdkManager = Join-Path $env:ANDROID_HOME 'cmdline-tools\latest\bin\sdkmanager.bat'

if (-not (Test-Path $sdkManager)) {
  $commandLineToolsVersion = '15859902'
  $commandLineToolsSha256 = '90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a'
  $toolsZip = Join-Path $env:TEMP "onami-android-commandlinetools-$commandLineToolsVersion.zip"
  $toolsExtractDir = Join-Path $env:TEMP "onami-android-commandlinetools-$commandLineToolsVersion"
  $toolsInstallDir = Join-Path $env:ANDROID_HOME 'cmdline-tools\latest'

  if (-not (Test-Path $toolsZip)) {
    Invoke-ResumableDownload `
      "https://dl.google.com/android/repository/commandlinetools-win-$($commandLineToolsVersion)_latest.zip" `
      $toolsZip
  } else {
    $existingHash = Get-FileSha256 $toolsZip
    if ($existingHash -ne $commandLineToolsSha256) {
      Invoke-ResumableDownload `
        "https://dl.google.com/android/repository/commandlinetools-win-$($commandLineToolsVersion)_latest.zip" `
        $toolsZip
    }
  }

  $downloadHash = Get-FileSha256 $toolsZip
  if ($downloadHash -ne $commandLineToolsSha256) {
    throw "Android command-line tools checksum mismatch. Expected $commandLineToolsSha256, got $downloadHash."
  }

  if (Test-Path $toolsExtractDir) {
    Remove-Item -Recurse -Force -LiteralPath $toolsExtractDir
  }
  New-Item -ItemType Directory -Force $toolsExtractDir | Out-Null
  Expand-Archive -LiteralPath $toolsZip -DestinationPath $toolsExtractDir -Force
  New-Item -ItemType Directory -Force $toolsInstallDir | Out-Null
  Copy-Item -Recurse -Force (Join-Path $toolsExtractDir 'cmdline-tools\*') $toolsInstallDir
}

$requiredSdkPackages = @(
  'platform-tools',
  'platforms;android-30',
  'build-tools;34.0.0'
)

$licenseAnswers = Join-Path $env:TEMP 'onami-sdk-license-answers.txt'
1..100 | ForEach-Object { 'y' } | Set-Content -Encoding Ascii -LiteralPath $licenseAnswers
try {
  $licenseCommand = "`"$sdkManager`" --licenses < `"$licenseAnswers`" >NUL"
  & cmd.exe /d /c $licenseCommand
  if ($LASTEXITCODE -ne 0) {
    throw "Android SDK license acceptance failed with exit code $LASTEXITCODE."
  }
} finally {
  Remove-Item -Force -LiteralPath $licenseAnswers -ErrorAction SilentlyContinue
}
& $sdkManager $requiredSdkPackages
if ($LASTEXITCODE -ne 0) {
  throw "Android SDK package installation failed with exit code $LASTEXITCODE."
}

$buildTimeUtc = [DateTimeOffset]::UtcNow
if (-not $env:ONAMI_VERSION_CODE) {
  $env:ONAMI_VERSION_CODE = [string] $buildTimeUtc.ToUnixTimeSeconds()
}
if (-not $env:ONAMI_VERSION_NAME) {
  $package = Get-Content -Raw (Join-Path $repoRoot 'package.json') | ConvertFrom-Json
  $env:ONAMI_VERSION_NAME = "$($package.version)-$($buildTimeUtc.ToString('yyyyMMdd.HHmm'))"
}

Push-Location $repoRoot
try {
  if ($InstallDependencies) {
    npm ci
    if ($LASTEXITCODE -ne 0) {
      throw "npm ci failed with exit code $LASTEXITCODE."
    }
  }

  npm run build:renderer
  if ($LASTEXITCODE -ne 0) {
    throw "Renderer build failed with exit code $LASTEXITCODE."
  }
  npm run android:sync-assets
  if ($LASTEXITCODE -ne 0) {
    throw "Android asset sync failed with exit code $LASTEXITCODE."
  }

  Push-Location (Join-Path $repoRoot 'android')
  try {
    & .\gradlew.bat assembleDebug
    if ($LASTEXITCODE -ne 0) {
      throw "Android build failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }

  $apkPath = Join-Path $repoRoot 'android\app\build\outputs\apk\debug\app-debug.apk'
  if (-not (Test-Path $apkPath)) {
    throw "Android build completed without producing $apkPath."
  }

  if ($Publish) {
    $publishDir = Join-Path $repoRoot 'release\android'
    $publishedApk = Join-Path $publishDir 'onami-latest.apk'
    $temporaryApk = "$publishedApk.tmp"
    $metadataPath = Join-Path $publishDir 'android.json'
    $temporaryMetadata = "$metadataPath.tmp"
    New-Item -ItemType Directory -Force $publishDir | Out-Null

    Copy-Item -Force -LiteralPath $apkPath -Destination $temporaryApk
    Move-Item -Force -LiteralPath $temporaryApk -Destination $publishedApk

    $gitSha = (git rev-parse HEAD).Trim()
    $gitDirty = -not [string]::IsNullOrWhiteSpace((git status --porcelain --untracked-files=no | Out-String))
    $metadata = [ordered]@{
      app = 'oNami'
      packageName = 'app.onami.flashcards'
      versionCode = [long] $env:ONAMI_VERSION_CODE
      versionName = $env:ONAMI_VERSION_NAME
      builtAt = $buildTimeUtc.ToString('o')
      gitSha = $gitSha
      gitDirty = $gitDirty
      sha256 = Get-FileSha256 $publishedApk
      sizeBytes = (Get-Item -LiteralPath $publishedApk).Length
      downloadUrl = '/downloads/onami-latest.apk'
    }
    $metadata | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $temporaryMetadata
    Move-Item -Force -LiteralPath $temporaryMetadata -Destination $metadataPath

    Write-Output "Published APK: $publishedApk"
    Write-Output "Version: $($metadata.versionName) ($($metadata.versionCode))"
    Write-Output "SHA-256: $($metadata.sha256)"
  } else {
    Write-Output "Built APK: $apkPath"
  }
} finally {
  Pop-Location
}
