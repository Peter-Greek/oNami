import { describe, expect, it } from 'vitest'

import {
  desktopUpdateMetadataUrl,
  isDesktopUpdateAvailable,
  parseDesktopUpdateMetadata,
} from './desktopUpdates'

const HOST_URL = 'http://host.test:41729'

const metadata = {
  versionCode: 1_786_500_123,
  versionName: '0.1.0-20260812.1630',
  sha256: 'a'.repeat(64),
  sizeBytes: 92_000_000,
  downloadUrl: '/downloads/onami-1786500123-setup.exe?v=1786500123',
}

describe('desktop updates', () => {
  it('builds the metadata URL from a host URL with or without a trailing slash', () => {
    expect(desktopUpdateMetadataUrl(HOST_URL)).toBe(`${HOST_URL}/downloads/windows.json`)
    expect(desktopUpdateMetadataUrl(`${HOST_URL}/`)).toBe(`${HOST_URL}/downloads/windows.json`)
  })

  it('parses the published metadata and resolves its relative download link', () => {
    expect(parseDesktopUpdateMetadata(metadata, HOST_URL)).toEqual({
      versionCode: 1_786_500_123,
      versionName: '0.1.0-20260812.1630',
      sha256: 'a'.repeat(64),
      sizeBytes: 92_000_000,
      downloadUrl: `${HOST_URL}/downloads/onami-1786500123-setup.exe?v=1786500123`,
    })
  })

  it('rejects download links hosted outside the paired host', () => {
    expect(() =>
      parseDesktopUpdateMetadata({ ...metadata, downloadUrl: 'https://example.com/onami-setup.exe' }, HOST_URL)
    ).toThrow('not trusted')
  })

  it('rejects metadata missing a usable checksum or size', () => {
    expect(() => parseDesktopUpdateMetadata({ ...metadata, sha256: 'nope' }, HOST_URL)).toThrow('checksum')
    expect(() => parseDesktopUpdateMetadata({ ...metadata, sizeBytes: 0 }, HOST_URL)).toThrow('size')
  })

  it('only reports an update for a newer version code', () => {
    expect(isDesktopUpdateAvailable(100, 101)).toBe(true)
    expect(isDesktopUpdateAvailable(100, 100)).toBe(false)
    expect(isDesktopUpdateAvailable(101, 100)).toBe(false)
  })

  it('never offers an update to an unpublished development build', () => {
    expect(isDesktopUpdateAvailable(0, 1_786_500_123)).toBe(false)
  })
})
