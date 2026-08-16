import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import { downloadInstaller, installerFileName, isVerifiedInstaller } from './appUpdater'
import type { DesktopUpdateMetadata } from '../../src/shared/desktopUpdates'

const INSTALLER = Buffer.from('oNami installer payload, pretend this is 90MB'.repeat(64))

const release: DesktopUpdateMetadata = {
  versionCode: 1_786_500_123,
  versionName: '0.1.0-20260812.1630',
  sha256: createHash('sha256').update(INSTALLER).digest('hex'),
  sizeBytes: INSTALLER.length,
  downloadUrl: 'http://host.test/downloads/onami-1786500123-setup.exe',
}

const temporaryDirectories: string[] = []

const createTargetDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onami-updates-'))
  temporaryDirectories.push(dir)
  return dir
}

/** Serves INSTALLER, honouring Range unless told to ignore it. */
const createFetch = (options: { honourRange?: boolean; corrupt?: boolean } = {}) => {
  const requests: (string | undefined)[] = []
  const body = options.corrupt ? Buffer.concat([INSTALLER.subarray(0, INSTALLER.length - 1), Buffer.from('!')]) : INSTALLER
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string> | undefined)?.range
    requests.push(range)
    if (range && options.honourRange !== false) {
      const start = Number(/^bytes=(\d+)-/.exec(range)?.[1] ?? 0)
      return new Response(body.subarray(start), { status: 206 })
    }
    return new Response(body, { status: 200 })
  }) as typeof fetch
  return { fetchImpl, requests }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('downloadInstaller', () => {
  it('downloads the installer and reports progress up to its published size', async () => {
    const targetDir = createTargetDir()
    const progress: number[] = []
    const { fetchImpl, requests } = createFetch()

    const filePath = await downloadInstaller({
      release,
      targetDir,
      fetchImpl,
      onProgress: (downloaded) => progress.push(downloaded),
    })

    expect(filePath).toBe(path.join(targetDir, installerFileName(release.versionCode)))
    expect(fs.readFileSync(filePath).equals(INSTALLER)).toBe(true)
    expect(requests).toEqual([undefined])
    expect(progress.at(-1)).toBe(release.sizeBytes)
  })

  it('resumes a partial download instead of refetching what is already on disk', async () => {
    const targetDir = createTargetDir()
    const partPath = path.join(targetDir, `${installerFileName(release.versionCode)}.part`)
    fs.writeFileSync(partPath, INSTALLER.subarray(0, 100))
    const { fetchImpl, requests } = createFetch()

    const filePath = await downloadInstaller({ release, targetDir, fetchImpl, onProgress: () => undefined })

    expect(requests).toEqual(['bytes=100-'])
    expect(fs.readFileSync(filePath).equals(INSTALLER)).toBe(true)
    expect(fs.existsSync(partPath)).toBe(false)
  })

  it('starts over when the host answers a range request with the whole file', async () => {
    const targetDir = createTargetDir()
    const partPath = path.join(targetDir, `${installerFileName(release.versionCode)}.part`)
    fs.writeFileSync(partPath, INSTALLER.subarray(0, 100))
    const { fetchImpl } = createFetch({ honourRange: false })

    const filePath = await downloadInstaller({ release, targetDir, fetchImpl, onProgress: () => undefined })

    expect(fs.readFileSync(filePath).equals(INSTALLER)).toBe(true)
  })

  it('discards a part file longer than the published build', async () => {
    const targetDir = createTargetDir()
    const partPath = path.join(targetDir, `${installerFileName(release.versionCode)}.part`)
    fs.writeFileSync(partPath, Buffer.concat([INSTALLER, INSTALLER]))
    const { fetchImpl, requests } = createFetch()

    await downloadInstaller({ release, targetDir, fetchImpl, onProgress: () => undefined })

    expect(requests).toEqual([undefined])
  })

  it('rejects bytes that do not match the published checksum and keeps nothing behind', async () => {
    const targetDir = createTargetDir()
    const { fetchImpl } = createFetch({ corrupt: true })

    await expect(
      downloadInstaller({ release, targetDir, fetchImpl, onProgress: () => undefined })
    ).rejects.toThrow('did not match its published checksum')
    expect(fs.readdirSync(targetDir)).toEqual([])
  })

  it('reuses an installer that is already downloaded and verified', async () => {
    const targetDir = createTargetDir()
    const filePath = path.join(targetDir, installerFileName(release.versionCode))
    fs.writeFileSync(filePath, INSTALLER)
    const { fetchImpl, requests } = createFetch()

    await downloadInstaller({ release, targetDir, fetchImpl, onProgress: () => undefined })

    expect(requests).toEqual([])
  })

  it('prunes installers left by earlier updates', async () => {
    const targetDir = createTargetDir()
    fs.writeFileSync(path.join(targetDir, 'oNami-1000-Setup.exe'), 'old')
    fs.writeFileSync(path.join(targetDir, 'unrelated.txt'), 'keep')
    const { fetchImpl } = createFetch()

    await downloadInstaller({ release, targetDir, fetchImpl, onProgress: () => undefined })

    expect(fs.readdirSync(targetDir).sort()).toEqual([
      installerFileName(release.versionCode),
      'unrelated.txt',
    ])
  })
})

describe('isVerifiedInstaller', () => {
  it('accepts only a file whose size and hash match the published build', async () => {
    const targetDir = createTargetDir()
    const filePath = path.join(targetDir, installerFileName(release.versionCode))

    expect(await isVerifiedInstaller(filePath, release)).toBe(false)
    fs.writeFileSync(filePath, INSTALLER.subarray(0, 10))
    expect(await isVerifiedInstaller(filePath, release)).toBe(false)
    fs.writeFileSync(filePath, INSTALLER)
    expect(await isVerifiedInstaller(filePath, release)).toBe(true)
  })
})
