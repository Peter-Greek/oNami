/**
 * Metadata the host publishes for the packaged Windows build, and the rules for
 * trusting it. The Android client reads a fixed update server; the desktop app
 * reads whichever host the user paired with, so the base URL is a parameter and
 * every download link is pinned back to that same origin.
 */
export const DESKTOP_UPDATE_METADATA_PATH = '/downloads/windows.json'

export interface DesktopUpdateMetadata {
  versionCode: number
  versionName: string
  sha256: string
  sizeBytes: number
  downloadUrl: string
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/i

export const desktopUpdateMetadataUrl = (hostUrl: string): string =>
  new URL(DESKTOP_UPDATE_METADATA_PATH, `${hostUrl.replace(/\/+$/, '')}/`).toString()

export const parseDesktopUpdateMetadata = (value: unknown, hostUrl: string): DesktopUpdateMetadata => {
  if (!value || typeof value !== 'object') throw new Error('The update response is invalid.')

  const record = value as Record<string, unknown>
  const versionCode = Number(record.versionCode)
  if (!Number.isSafeInteger(versionCode) || versionCode <= 0) {
    throw new Error('The update response has an invalid version.')
  }

  if (typeof record.versionName !== 'string' || !record.versionName.trim()) {
    throw new Error('The update response has no version name.')
  }

  if (typeof record.sha256 !== 'string' || !SHA256_PATTERN.test(record.sha256)) {
    throw new Error('The update response has no installer checksum.')
  }

  const sizeBytes = Number(record.sizeBytes)
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error('The update response has an invalid installer size.')
  }

  if (typeof record.downloadUrl !== 'string' || !record.downloadUrl.trim()) {
    throw new Error('The update response has no download link.')
  }

  const metadataUrl = new URL(desktopUpdateMetadataUrl(hostUrl))
  const downloadUrl = new URL(record.downloadUrl, metadataUrl)
  if (downloadUrl.origin !== metadataUrl.origin || !/^https?:$/.test(downloadUrl.protocol)) {
    throw new Error('The update download link is not trusted.')
  }

  return {
    versionCode,
    versionName: record.versionName.trim(),
    sha256: record.sha256.toLowerCase(),
    sizeBytes,
    downloadUrl: downloadUrl.toString(),
  }
}

/**
 * An unpublished build reports version code 0. Treating that as "older than
 * everything" would push the host's installer over a developer's local build,
 * so it never counts as out of date.
 */
export const isDesktopUpdateAvailable = (installedVersionCode: number, latestVersionCode: number): boolean =>
  Number.isSafeInteger(installedVersionCode) && installedVersionCode > 0 && latestVersionCode > installedVersionCode
