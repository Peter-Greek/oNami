export const ANDROID_UPDATE_METADATA_URL = 'http://147.135.31.128:41729/downloads/android.json'

export interface AndroidUpdateMetadata {
  versionCode: number
  versionName: string
  downloadUrl: string
}

export const parseAndroidUpdateMetadata = (value: unknown): AndroidUpdateMetadata => {
  if (!value || typeof value !== 'object') throw new Error('The update response is invalid.')

  const record = value as Record<string, unknown>
  const versionCode = Number(record.versionCode)
  if (!Number.isSafeInteger(versionCode) || versionCode <= 0) {
    throw new Error('The update response has an invalid version.')
  }

  if (typeof record.versionName !== 'string' || !record.versionName.trim()) {
    throw new Error('The update response has no version name.')
  }

  if (typeof record.downloadUrl !== 'string' || !record.downloadUrl.trim()) {
    throw new Error('The update response has no download link.')
  }

  const metadataUrl = new URL(ANDROID_UPDATE_METADATA_URL)
  const downloadUrl = new URL(record.downloadUrl, metadataUrl)
  if (downloadUrl.origin !== metadataUrl.origin || !/^https?:$/.test(downloadUrl.protocol)) {
    throw new Error('The update download link is not trusted.')
  }

  return {
    versionCode,
    versionName: record.versionName.trim(),
    downloadUrl: downloadUrl.toString(),
  }
}

export const isAndroidUpdateAvailable = (installedVersionCode: number, latestVersionCode: number): boolean =>
  Number.isSafeInteger(installedVersionCode) && latestVersionCode > installedVersionCode
