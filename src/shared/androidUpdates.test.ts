import { describe, expect, it } from 'vitest'

import {
  isAndroidUpdateAvailable,
  parseAndroidUpdateMetadata,
} from './androidUpdates'

describe('Android updates', () => {
  it('parses the published metadata and resolves its relative download link', () => {
    expect(
      parseAndroidUpdateMetadata({
        versionCode: 1_786_500_123,
        versionName: '0.1.0-20260812.1630',
        downloadUrl: '/downloads/onami-1786500123.apk?v=1786500123',
      })
    ).toEqual({
      versionCode: 1_786_500_123,
      versionName: '0.1.0-20260812.1630',
      downloadUrl: 'http://147.135.31.128:41729/downloads/onami-1786500123.apk?v=1786500123',
    })
  })

  it('only reports an update for a newer version code', () => {
    expect(isAndroidUpdateAvailable(100, 101)).toBe(true)
    expect(isAndroidUpdateAvailable(100, 100)).toBe(false)
    expect(isAndroidUpdateAvailable(101, 100)).toBe(false)
  })

  it('rejects download links hosted outside the update server', () => {
    expect(() =>
      parseAndroidUpdateMetadata({
        versionCode: 101,
        versionName: '0.1.1',
        downloadUrl: 'https://example.com/onami.apk',
      })
    ).toThrow('not trusted')
  })
})
