import fs from 'node:fs'
import path from 'node:path'

const VERSIONED_APK_PATH = /^\/downloads\/onami-(\d+)\.apk$/

export const parseByteRange = (rangeHeader, size) => {
  if (!rangeHeader) return null

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
  if (!match || (!match[1] && !match[2])) return { invalid: true }

  let start
  let end
  if (!match[1]) {
    const suffixLength = Number(match[2])
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { invalid: true }
    start = Math.max(size - suffixLength, 0)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Number(match[2]) : size - 1
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start >= size ||
      end < start
    ) {
      return { invalid: true }
    }
    end = Math.min(end, size - 1)
  }

  return { start, end }
}

const readReleaseMetadata = (releaseDir) => {
  const metadataPath = path.join(releaseDir, 'android.json')
  if (!fs.existsSync(metadataPath)) return null

  try {
    const source = fs.readFileSync(metadataPath, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(source)
  } catch {
    return null
  }
}

export const resolveAndroidDownload = (pathname, releaseDir) => {
  const versionMatch = VERSIONED_APK_PATH.exec(pathname)
  if (pathname !== '/downloads/onami-latest.apk' && !versionMatch) return null

  const metadata = readReleaseMetadata(releaseDir)
  const currentVersion = metadata?.versionCode == null ? null : String(metadata.versionCode)
  if (versionMatch && versionMatch[1] !== currentVersion) {
    return { stale: true, currentVersion }
  }

  const downloadVersion = currentVersion ?? 'latest'
  return {
    stale: false,
    currentVersion,
    filePath: path.join(releaseDir, 'onami-latest.apk'),
    downloadName: `oNami-${downloadVersion}.apk`,
    etag: typeof metadata?.sha256 === 'string' ? `"sha256-${metadata.sha256}"` : null,
  }
}
