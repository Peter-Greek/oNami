import { describe, expect, it } from 'vitest'

import { getAvailableSnapshotMedia, selectAvailableMediaBatch } from './snapshotTransfer'
import type { SyncMediaRecord } from './types'

const media = ['a', 'b', 'c', 'd'].map(
  (sha256, index): SyncMediaRecord => ({
    id: `media-${index}`,
    sha256,
    mimeType: 'image/png',
    byteSize: 1,
    originalName: `${sha256}.png`,
  })
)

describe('progressive snapshot media transfer', () => {
  it('downloads only the currently available media in bounded batches', () => {
    expect(
      selectAvailableMediaBatch(media, new Set(['a']), new Set(['a', 'b', 'c']), 2).map((item) => item.sha256)
    ).toEqual(['b', 'c'])
  })

  it('does not expose media before an incomplete manifest reports it available', () => {
    expect(
      getAvailableSnapshotMedia(
        { snapshot: null, sourceDeviceId: null, uploadComplete: false },
        media
      )
    ).toEqual(new Set())
  })

  it('treats legacy manifests as fully available', () => {
    expect(getAvailableSnapshotMedia({ snapshot: null, sourceDeviceId: null }, media)).toEqual(
      new Set(['a', 'b', 'c', 'd'])
    )
  })
})
