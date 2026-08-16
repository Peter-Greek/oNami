param(
  [switch] $InstallDependencies,
  [switch] $Publish
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = Split-Path -Parent $PSScriptRoot

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

# The installed app has no way back to package.json, so the build stamps a
# monotonic version code the updater can compare. Android does the same, which
# keeps one comparison rule across both clients.
$buildTimeUtc = [DateTimeOffset]::UtcNow
$package = Get-Content -Raw (Join-Path $repoRoot 'package.json') | ConvertFrom-Json
if (-not $env:ONAMI_VERSION_CODE) {
  $env:ONAMI_VERSION_CODE = [string] $buildTimeUtc.ToUnixTimeSeconds()
}
if (-not $env:ONAMI_VERSION_NAME) {
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

  npm run build:win
  if ($LASTEXITCODE -ne 0) {
    throw "Windows build failed with exit code $LASTEXITCODE."
  }

  $installerPath = Join-Path $repoRoot "release\$($package.productName)-$($package.version)-Setup.exe"
  if (-not (Test-Path $installerPath)) {
    throw "Windows build completed without producing $installerPath."
  }

  if ($Publish) {
    $publishDir = Join-Path $repoRoot 'release\windows'
    $publishedInstaller = Join-Path $publishDir 'onami-latest-setup.exe'
    $temporaryInstaller = "$publishedInstaller.tmp"
    $metadataPath = Join-Path $publishDir 'windows.json'
    $temporaryMetadata = "$metadataPath.tmp"
    New-Item -ItemType Directory -Force $publishDir | Out-Null

    # Copy then move, so a client polling mid-publish never sees a partial
    # installer under the name the metadata already points at.
    Copy-Item -Force -LiteralPath $installerPath -Destination $temporaryInstaller
    Move-Item -Force -LiteralPath $temporaryInstaller -Destination $publishedInstaller

    $gitSha = (git rev-parse HEAD).Trim()
    $gitDirty = -not [string]::IsNullOrWhiteSpace((git status --porcelain --untracked-files=no | Out-String))
    $metadata = [ordered]@{
      app = 'oNami'
      platform = 'win32'
      arch = 'x64'
      versionCode = [long] $env:ONAMI_VERSION_CODE
      versionName = $env:ONAMI_VERSION_NAME
      builtAt = $buildTimeUtc.ToString('o')
      gitSha = $gitSha
      gitDirty = $gitDirty
      sha256 = Get-FileSha256 $publishedInstaller
      sizeBytes = (Get-Item -LiteralPath $publishedInstaller).Length
      downloadUrl = "/downloads/onami-$($env:ONAMI_VERSION_CODE)-setup.exe?v=$($env:ONAMI_VERSION_CODE)"
    }
    $metadata | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $temporaryMetadata
    Move-Item -Force -LiteralPath $temporaryMetadata -Destination $metadataPath

    Write-Output "Published installer: $publishedInstaller"
    Write-Output "Version: $($metadata.versionName) ($($metadata.versionCode))"
    Write-Output "SHA-256: $($metadata.sha256)"
    Write-Output "Size: $($metadata.sizeBytes) bytes"
  } else {
    Write-Output "Built installer: $installerPath"
  }
} finally {
  Pop-Location
}
