/**
 * Blob storage maintenance.
 *
 * The host previously reclaimed media only when a receiving device acknowledged
 * a full snapshot. Every transfer that crashed before its ack left its bytes
 * behind permanently. Collection here is driven by reference counting instead,
 * so nothing depends on a client finishing anything.
 *
 * Run by hand:
 *
 *   node host/gc.js              report what would be reclaimed, change nothing
 *   node host/gc.js --apply      delete what the report lists
 *
 * The server can also run `sweepBlobs` on a timer once ONAMI_BLOB_SWEEP_ENABLED=1.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BLOB_GRACE, isBlobCollectable, normalizeSha256 } from './blobs.js'
import { loadEnvFile } from './env.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const resolveMediaDir = () =>
  process.env.ONAMI_MEDIA_DIR ?? path.join(__dirname, 'media-store')

const formatBytes = (bytes) => {
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

/**
 * Gives every blob already on disk a row and the references it has earned.
 *
 * Published deck media is unambiguously live. Sync media is only ever consumed
 * through a snapshot under the old protocol, so a `media_objects` row whose
 * hash no pending snapshot mentions is already garbage by that protocol's own
 * rules — that is exactly how the stranded bytes accumulated.
 *
 * Always safe to run: it only creates rows and references.
 */
export const backfillBlobs = async ({ prisma, mediaDir }) => {
  const summary = { files: 0, rowsCreated: 0, publishedRefs: 0, syncRefs: 0, missingFiles: 0 }

  const [publishedMedia, snapshots] = await Promise.all([
    prisma.globalDeckMedia.findMany({ select: { deckId: true, sha256: true, mimeType: true, byteSize: true } }),
    prisma.syncSnapshot.findMany({ select: { syncGroupId: true, payloadJson: true } }),
  ])

  // Hashes a still-pending snapshot needs, grouped by the sync group owning it.
  const liveSyncHashes = new Map()
  for (const snapshot of snapshots) {
    const media = Array.isArray(snapshot.payloadJson?.media) ? snapshot.payloadJson.media : []
    for (const item of media) {
      const sha256 = normalizeSha256(item?.sha256)
      if (!sha256) continue
      if (!liveSyncHashes.has(sha256)) liveSyncHashes.set(sha256, new Set())
      liveSyncHashes.get(sha256).add(snapshot.syncGroupId)
    }
  }

  const metadataByHash = new Map()
  for (const media of publishedMedia) {
    const sha256 = normalizeSha256(media.sha256)
    if (sha256) metadataByHash.set(sha256, { mimeType: media.mimeType, byteSize: media.byteSize })
  }
  for (const media of await prisma.mediaObject.findMany({ select: { sha256: true, mimeType: true, byteSize: true } })) {
    const sha256 = normalizeSha256(media.sha256)
    if (sha256 && !metadataByHash.has(sha256)) {
      metadataByHash.set(sha256, { mimeType: media.mimeType, byteSize: media.byteSize })
    }
  }

  const entries = fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir) : []
  for (const entry of entries) {
    if (entry.endsWith('.part')) continue
    const sha256 = normalizeSha256(entry)
    if (!sha256) continue

    const filePath = path.join(mediaDir, entry)
    const byteSize = fs.statSync(filePath).size
    summary.files += 1

    const existing = await prisma.blob.findUnique({ where: { sha256 }, select: { sha256: true } })
    if (!existing) {
      await prisma.blob.create({
        data: {
          sha256,
          byteSize,
          receivedBytes: byteSize,
          mimeType: metadataByHash.get(sha256)?.mimeType ?? 'application/octet-stream',
          complete: true,
        },
      })
      summary.rowsCreated += 1
    }
  }

  for (const media of publishedMedia) {
    const sha256 = normalizeSha256(media.sha256)
    if (!sha256) continue
    if (!fs.existsSync(path.join(mediaDir, sha256))) {
      summary.missingFiles += 1
      continue
    }
    await prisma.blobRef.upsert({
      where: { sha256_scopeKind_scopeId: { sha256, scopeKind: 'published-deck', scopeId: media.deckId } },
      update: {},
      create: { sha256, scopeKind: 'published-deck', scopeId: media.deckId },
    })
    summary.publishedRefs += 1
  }

  for (const [sha256, syncGroupIds] of liveSyncHashes) {
    if (!fs.existsSync(path.join(mediaDir, sha256))) continue
    for (const syncGroupId of syncGroupIds) {
      await prisma.blobRef.upsert({
        where: { sha256_scopeKind_scopeId: { sha256, scopeKind: 'sync-group', scopeId: syncGroupId } },
        update: {},
        create: { sha256, scopeKind: 'sync-group', scopeId: syncGroupId },
      })
      summary.syncRefs += 1
    }
  }

  return summary
}

/**
 * Deletes blobs nothing references and uploads nobody resumed. Reports without
 * changing anything unless `apply` is set.
 */
export const sweepBlobs = async ({ prisma, mediaDir, apply = false, now = Date.now(), grace = BLOB_GRACE }) => {
  const blobs = await prisma.blob.findMany({
    select: {
      sha256: true,
      byteSize: true,
      complete: true,
      updatedAt: true,
      _count: { select: { refs: true } },
    },
  })

  const collectable = blobs.filter((blob) =>
    isBlobCollectable({
      complete: blob.complete,
      refCount: blob._count.refs,
      updatedAt: blob.updatedAt,
      now,
      grace,
    })
  )

  const summary = {
    scanned: blobs.length,
    collectable: collectable.length,
    bytes: collectable.reduce((total, blob) => total + blob.byteSize, 0),
    deleted: 0,
    applied: apply,
  }

  if (!apply) return summary

  for (const blob of collectable) {
    fs.rmSync(path.join(mediaDir, blob.sha256), { force: true })
    fs.rmSync(path.join(mediaDir, `${blob.sha256}.part`), { force: true })
    // The legacy per-sync-group rows point at bytes that are now gone.
    await prisma.mediaObject.deleteMany({ where: { sha256: blob.sha256 } })
    await prisma.blob.delete({ where: { sha256: blob.sha256 } })
    summary.deleted += 1
  }

  return summary
}

const main = async () => {
  loadEnvFile(path.join(__dirname, '.env'))
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required. Run host/setup.bat or create host/.env.')
    process.exit(1)
  }

  const { PrismaClient } = await import('@prisma/client')
  const prisma = new PrismaClient()
  const mediaDir = resolveMediaDir()
  const apply = process.argv.includes('--apply')

  try {
    console.log(`Media directory: ${mediaDir}`)
    const backfill = await backfillBlobs({ prisma, mediaDir })
    console.log(
      `Backfill: ${backfill.files} files on disk, ${backfill.rowsCreated} blob rows created, ` +
        `${backfill.publishedRefs} published-deck refs, ${backfill.syncRefs} sync-group refs` +
        (backfill.missingFiles ? `, ${backfill.missingFiles} referenced files missing` : '')
    )

    const sweep = await sweepBlobs({ prisma, mediaDir, apply })
    console.log(
      `Sweep: ${sweep.scanned} blobs scanned, ${sweep.collectable} collectable (${formatBytes(sweep.bytes)})`
    )
    console.log(
      apply
        ? `Deleted ${sweep.deleted} blobs, reclaiming ${formatBytes(sweep.bytes)}.`
        : 'Dry run — nothing was deleted. Re-run with --apply to reclaim.'
    )
  } finally {
    await prisma.$disconnect()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
