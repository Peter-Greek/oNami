import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'

import type { DesktopUpdateMetadata } from '../../src/shared/desktopUpdates'

/** How long the host has to answer the small metadata request. */
export const UPDATE_METADATA_TIMEOUT_MS = 20_000

export const installerFileName = (versionCode: number): string => `oNami-${versionCode}-Setup.exe`

/**
 * The version the build stamped into the bundle. Unpublished builds report 0,
 * which every comparison treats as "do not offer an update".
 */
export const installedVersionCode = (): number => {
  const parsed = Number(process.env.ONAMI_VERSION_CODE ?? '0')
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
}

export const installedVersionName = (fallback: string): string =>
  (process.env.ONAMI_VERSION_NAME ?? '').trim() || fallback

export const hashFile = (filePath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })

/** True when the file on disk is exactly the installer the host published. */
export const isVerifiedInstaller = async (filePath: string, release: DesktopUpdateMetadata): Promise<boolean> => {
  if (!fs.existsSync(filePath)) return false
  if (fs.statSync(filePath).size !== release.sizeBytes) return false
  return (await hashFile(filePath)) === release.sha256
}

/** Clears installers left by earlier updates so the folder holds one build. */
export const pruneInstallers = (targetDir: string, keepFileName: string): void => {
  if (!fs.existsSync(targetDir)) return
  for (const entry of fs.readdirSync(targetDir)) {
    if (entry === keepFileName || entry === `${keepFileName}.part`) continue
    if (!/^oNami-\d+-Setup\.exe(\.part)?$/i.test(entry)) continue
    try {
      fs.rmSync(path.join(targetDir, entry), { force: true })
    } catch {
      // A running installer can hold its own file open. It gets pruned later.
    }
  }
}

export interface DownloadInstallerOptions {
  release: DesktopUpdateMetadata
  targetDir: string
  onProgress: (downloadedBytes: number, totalBytes: number) => void
  fetchImpl?: typeof fetch
}

/**
 * Downloads the published installer, resuming a partial file rather than
 * restarting it, and only accepts bytes whose SHA-256 matches the metadata.
 *
 * The `.part` name matters: a half-downloaded file must never be reachable
 * under the name `install()` runs, so the rename to the final name is the last
 * thing that happens and only after the hash checks out.
 */
export const downloadInstaller = async (options: DownloadInstallerOptions): Promise<string> => {
  const { release, targetDir, onProgress } = options
  const doFetch = options.fetchImpl ?? fetch

  fs.mkdirSync(targetDir, { recursive: true })
  const fileName = installerFileName(release.versionCode)
  const filePath = path.join(targetDir, fileName)
  const partPath = `${filePath}.part`
  pruneInstallers(targetDir, fileName)

  if (await isVerifiedInstaller(filePath, release)) {
    onProgress(release.sizeBytes, release.sizeBytes)
    return filePath
  }
  fs.rmSync(filePath, { force: true })

  // A part longer than the published build belongs to a different build.
  let downloaded = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0
  if (downloaded > release.sizeBytes) {
    fs.rmSync(partPath, { force: true })
    downloaded = 0
  }

  if (downloaded < release.sizeBytes) {
    const response = await doFetch(release.downloadUrl, {
      headers: downloaded > 0 ? { range: `bytes=${downloaded}-` } : {},
      cache: 'no-store',
    })
    if (!response.ok) {
      throw new Error(`The update server returned ${response.status} for the installer.`)
    }
    if (!response.body) throw new Error('The update server sent an empty installer response.')

    // A host that ignores Range answers 200 with the whole file, so the part
    // file has to start over rather than have a second copy appended to it.
    if (downloaded > 0 && response.status !== 206) {
      fs.rmSync(partPath, { force: true })
      downloaded = 0
    }

    const target = fs.createWriteStream(partPath, { flags: downloaded > 0 ? 'a' : 'w' })
    try {
      for await (const chunk of Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])) {
        const buffer = chunk as Buffer
        if (!target.write(buffer)) {
          await new Promise<void>((resolve) => target.once('drain', () => resolve()))
        }
        downloaded += buffer.length
        onProgress(Math.min(downloaded, release.sizeBytes), release.sizeBytes)
      }
    } finally {
      await new Promise<void>((resolve, reject) => target.close((error) => (error ? reject(error) : resolve())))
    }
  }

  const actualSize = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0
  if (actualSize !== release.sizeBytes || (await hashFile(partPath)) !== release.sha256) {
    fs.rmSync(partPath, { force: true })
    throw new Error('The downloaded installer did not match its published checksum.')
  }

  fs.renameSync(partPath, filePath)
  onProgress(release.sizeBytes, release.sizeBytes)
  return filePath
}
