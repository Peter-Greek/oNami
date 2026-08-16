/**
 * End-to-end tests for the release endpoints the desktop client updates from.
 *
 * These drive the real server because what matters is the contract the app
 * relies on: metadata it can trust, a versioned installer URL, resumable bytes,
 * and a clear answer when the build it asked for has been replaced.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onami-release-routes-'))
const emptyReleaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onami-release-empty-'))
const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onami-release-media-'))

const INSTALLER = Buffer.from('MZ fake installer bytes'.repeat(32))
const VERSION_CODE = 1_786_500_123

vi.mock('@prisma/client', () => ({
  PrismaClient: class {
    constructor() {
      return { $queryRaw: async () => [{ '?column?': 1 }], $disconnect: async () => undefined }
    }
  },
}))

let baseUrl = ''
let server

const publishWindowsBuild = (versionCode = VERSION_CODE) => {
  fs.writeFileSync(path.join(releaseDir, 'onami-latest-setup.exe'), INSTALLER)
  fs.writeFileSync(
    path.join(releaseDir, 'windows.json'),
    JSON.stringify({
      app: 'oNami',
      platform: 'win32',
      versionCode,
      versionName: '0.1.0-20260812.1630',
      sha256: createHash('sha256').update(INSTALLER).digest('hex'),
      sizeBytes: INSTALLER.length,
      downloadUrl: `/downloads/onami-${versionCode}-setup.exe?v=${versionCode}`,
    }),
  )
}

beforeAll(async () => {
  process.env.DATABASE_URL = 'postgresql://stub'
  process.env.ONAMI_MEDIA_DIR = mediaDir
  process.env.ONAMI_WINDOWS_RELEASE_DIR = releaseDir
  // Nothing published for Android here, which is how the "no build yet" case
  // is exercised without deleting files the server may still be streaming.
  process.env.ONAMI_ANDROID_RELEASE_DIR = emptyReleaseDir
  process.env.ONAMI_HOST_PORT = '0'
  process.env.ONAMI_HOST_BIND = '127.0.0.1'
  process.env.ONAMI_LOG_REQUESTS = '0'

  publishWindowsBuild()

  const module = await import('./server.js')
  server = module.server
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(releaseDir, { recursive: true, force: true })
  fs.rmSync(emptyReleaseDir, { recursive: true, force: true })
  fs.rmSync(mediaDir, { recursive: true, force: true })
})

describe('Windows release endpoints', () => {
  it('serves the published metadata unauthenticated, so a device can check before pairing', async () => {
    const response = await fetch(`${baseUrl}/downloads/windows.json`)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      versionCode: VERSION_CODE,
      sizeBytes: INSTALLER.length,
      downloadUrl: `/downloads/onami-${VERSION_CODE}-setup.exe?v=${VERSION_CODE}`,
    })
  })

  it('serves the installer named for the version the metadata advertises', async () => {
    const response = await fetch(`${baseUrl}/downloads/onami-${VERSION_CODE}-setup.exe`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toContain(`oNami-${VERSION_CODE}-Setup.exe`)
    expect(Buffer.from(await response.arrayBuffer()).equals(INSTALLER)).toBe(true)
  })

  it('resumes an interrupted installer download from a byte offset', async () => {
    const response = await fetch(`${baseUrl}/downloads/onami-latest-setup.exe`, {
      headers: { range: `bytes=100-` },
    })

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe(`bytes 100-${INSTALLER.length - 1}/${INSTALLER.length}`)
    expect(Buffer.from(await response.arrayBuffer()).equals(INSTALLER.subarray(100))).toBe(true)
  })

  it('tells a client asking for a replaced build where the current one lives', async () => {
    const response = await fetch(`${baseUrl}/downloads/onami-999-setup.exe`)

    expect(response.status).toBe(410)
    expect(await response.json()).toMatchObject({
      currentDownloadUrl: `/downloads/onami-${VERSION_CODE}-setup.exe?v=${VERSION_CODE}`,
    })
  })

  it('reports a platform with nothing published rather than serving an empty file', async () => {
    const response = await fetch(`${baseUrl}/downloads/onami-latest.apk`)

    expect(response.status).toBe(404)
  })
})
