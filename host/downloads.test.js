import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { parseByteRange, resolveAndroidDownload, resolveWindowsDownload } from './downloads.js'

const temporaryDirectories = []

const createReleaseDirectory = (versionCode = 1234, metadataFile = 'android.json') => {
  const releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onami-downloads-'))
  temporaryDirectories.push(releaseDir)
  fs.writeFileSync(
    path.join(releaseDir, metadataFile),
    `\uFEFF${JSON.stringify({ versionCode, sha256: 'a'.repeat(64) })}`,
  )
  return releaseDir
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('parseByteRange', () => {
  it('parses normal, open-ended, and suffix ranges', () => {
    expect(parseByteRange('bytes=0-1023', 4096)).toEqual({ start: 0, end: 1023 })
    expect(parseByteRange('bytes=2048-', 4096)).toEqual({ start: 2048, end: 4095 })
    expect(parseByteRange('bytes=-512', 4096)).toEqual({ start: 3584, end: 4095 })
  })

  it('rejects invalid and multiple ranges', () => {
    expect(parseByteRange('bytes=4096-', 4096)).toEqual({ invalid: true })
    expect(parseByteRange('bytes=0-1,4-5', 4096)).toEqual({ invalid: true })
  })
})

describe('resolveAndroidDownload', () => {
  it('gives the latest route a version-specific Android download filename', () => {
    const releaseDir = createReleaseDirectory()
    expect(resolveAndroidDownload('/downloads/onami-latest.apk', releaseDir)).toMatchObject({
      stale: false,
      currentVersion: '1234',
      downloadName: 'oNami-1234.apk',
      etag: `"sha256-${'a'.repeat(64)}"`,
    })
  })

  it('accepts only the currently published versioned route', () => {
    const releaseDir = createReleaseDirectory()
    expect(resolveAndroidDownload('/downloads/onami-1234.apk', releaseDir)?.stale).toBe(false)
    expect(resolveAndroidDownload('/downloads/onami-999.apk', releaseDir)).toEqual({
      stale: true,
      currentVersion: '1234',
    })
  })
})

describe('resolveWindowsDownload', () => {
  it('serves the published installer under a version-specific download name', () => {
    const releaseDir = createReleaseDirectory(1234, 'windows.json')
    expect(resolveWindowsDownload('/downloads/onami-latest-setup.exe', releaseDir)).toMatchObject({
      stale: false,
      currentVersion: '1234',
      filePath: path.join(releaseDir, 'onami-latest-setup.exe'),
      downloadName: 'oNami-1234-Setup.exe',
      etag: `"sha256-${'a'.repeat(64)}"`,
    })
  })

  it('accepts only the currently published versioned route', () => {
    const releaseDir = createReleaseDirectory(1234, 'windows.json')
    expect(resolveWindowsDownload('/downloads/onami-1234-setup.exe', releaseDir)?.stale).toBe(false)
    expect(resolveWindowsDownload('/downloads/onami-999-setup.exe', releaseDir)).toEqual({
      stale: true,
      currentVersion: '1234',
    })
  })

  it('matches the installer route regardless of case', () => {
    const releaseDir = createReleaseDirectory(1234, 'windows.json')
    expect(resolveWindowsDownload('/downloads/oNami-1234-Setup.exe', releaseDir)?.stale).toBe(false)
  })

  it('ignores routes belonging to the Android build', () => {
    const releaseDir = createReleaseDirectory(1234, 'windows.json')
    expect(resolveWindowsDownload('/downloads/onami-latest.apk', releaseDir)).toBeNull()
  })
})
