# Sync Host Architecture

## Purpose

The host is a small relay service for oNami sync. It should hold sync-group data until another paired device requests it, then deliver only events that device has not seen. The host should not run scheduling, render cards, or become the source of truth for day-to-day app behavior. Desktop and Android remain local-first.

## Core Design

A keyed, versioned record store:

```text
Device A local DB -> push records -> Host record store -> pull records -> Device B local DB
```

Each device writes local changes first, queues them in a keyed outbox, and pushes when online. The host keeps **one row per thing** — a deck, a card, a media reference — so re-saving a card replaces its row rather than appending another. The store stays the size of the library, not the size of its edit history.

Each device pulls everything after the version it last saw. **A brand new device pulls from version 0 through the same endpoint every other device uses**, so hydration and ongoing sync are one code path. There is no snapshot, no source or target device, and nothing to acknowledge.

Conflicts resolve on `mergeRank` before timestamps. For a card that is its review count: device clocks disagree, and last-writer-wins lets a desktop closed for a week overwrite reviews done on a phone that morning. Ranking by reviews first means the device that has studied more never loses. Deletions compare on time alone, so a studied card stays deletable. The host enforces this rather than trusting clients.

Reviews are genuinely append-only and drive stats and streaks, so they have their own cursor-pulled stream.

## Service Components

- API server: HTTPS JSON API for device pairing, device registration, event push, event pull, and media upload/download.
- Database: stores sync groups, devices, pairings, event metadata, cursors, and media metadata.
- Object storage: stores encrypted or private media blobs for imported deck assets.
- Background jobs: cleanup expired pairing sessions, compact old acknowledged events, and remove unreferenced media.

## Suggested Host Tables

```text
sync_groups(id, created_at, updated_at)
devices(id, sync_group_id, name, platform, public_key, created_at, last_seen_at, revoked_at)
pairing_sessions(id, initiator_device_id, code_hash, confirmation_code, expires_at, approved_at, created_at)
sync_events(id, sync_group_id, source_device_id, sequence, entity_type, entity_id, event_type, payload_json, created_at)
device_cursors(sync_group_id, device_id, last_event_id, updated_at)
media_objects(id, sync_group_id, sha256, byte_size, mime_type, storage_key, created_at)
device_tokens(id, device_id, token_hash, expires_at, created_at)
```

`devices.sync_group_id` is nullable until the device is paired. After pairing, the host only accepts sync and media requests from active, non-revoked devices in that sync group.

For a privacy-first version, `payload_json` can be replaced with `payload_ciphertext`, `nonce`, and `key_version`. The host can still route events by sync group and device without reading card content.

## API Endpoints

```text
POST /devices/bootstrap
POST /pairing/start
POST /pairing/join
POST /pairing/confirm
POST /devices/token
POST /devices
GET  /sync/events?after=<cursor>&limit=<n>
POST /sync/events
POST /sync/ack
POST /media
GET  /media/:id
```

`POST /sync/events` should accept batches. Each event must include `event_id`, `source_device_id`, `sequence`, `entity_type`, `entity_id`, `event_type`, `payload`, and `created_at`. The host must reject duplicate `(source_device_id, sequence)` pairs and treat repeated `event_id` pushes as idempotent success.

## Sync Protocol

1. Device creates or restores a stable `device_id` and device key pair.
2. User pairs two devices through a short code, QR code, or USB-assisted exchange.
3. Host creates or updates a `sync_group_id` and records both devices as active members.
4. Device proves possession of its private key and receives a short-lived device token bound to its `device_id`.
5. Device pushes pending outbox events in sequence order.
6. Host stores accepted events and returns the highest accepted sequence.
7. Device pulls host events after its stored cursor.
8. Device skips events from itself unless it needs server confirmation.
9. Device applies remote events in host order inside a local transaction.
10. Device acknowledges the latest applied host cursor.

If applying an event fails, the device must not advance its cursor. The same event should be retried after the app updates or the local conflict issue is resolved.

## Pairing Protocol

Manual pairing:

1. Initiating device calls `POST /pairing/start` with its `device_id`, public key, device name, and platform.
2. Host returns a short-lived pairing code and a human-readable confirmation code.
3. Joining device calls `POST /pairing/join` with the pairing code, its `device_id`, public key, device name, and platform.
4. Both devices display the same confirmation code.
5. User confirms on both devices.
6. Host creates a new sync group or adds the joining device to the initiator's existing sync group.
7. Devices choose copy source or merge mode before the first event exchange.

USB-assisted pairing should exchange the same payload directly between devices and then call the same host confirmation endpoint. It is a faster transport for pairing data, not a separate trust model.

Pairing codes must be short-lived, single-use, rate-limited, and stored only as hashes on the host.

## Payload Rules

The host should validate envelope shape, not app-specific card HTML. App clients own domain validation through shared schemas.

Required event envelope:

```json
{
  "eventId": "uuid",
  "sourceDeviceId": "uuid",
  "sequence": 42,
  "entityType": "card",
  "entityId": "uuid",
  "eventType": "card.upsert",
  "payload": {},
  "createdAt": "2026-07-06T12:00:00.000Z"
}
```

## Media Handling

Media should not be embedded in normal sync events. Use `media.put` events for metadata and upload the blob separately. Store blobs by SHA-256 hash or generated media id. Clients should download media lazily when a deck/card references it.

For large files, add resumable upload later. MVP can start with single-request uploads and a conservative file-size limit.

## Security Requirements

- Require HTTPS in all environments except local development.
- Store only public device keys; private keys stay on the device.
- Use short-lived device tokens and bind them to `device_id`.
- Require device-key proof before issuing device tokens.
- Require active sync-group membership for all sync and media endpoints.
- Revoke device tokens when a device is removed from a sync group.
- Do not sync OpenAI API keys.
- Do not log card HTML, note fields, media contents, pairing codes, or device tokens.
- Rate-limit pairing and sync endpoints.

End-to-end encryption can be added by generating a sync-group key on the client and encrypting event payloads before upload. This is recommended before hosting real card content outside a trusted private deployment.

## Retention and Compaction

The simplest host keeps all events forever. That is easiest for new-device hydration but will grow over time. After MVP, add compaction:

- Keep append-only `review.answer` events for audit and rebuilds.
- Collapse older deck/note/card upserts into latest snapshots.
- Keep tombstones long enough for inactive devices to learn deletes.
- Remove media only after no active event or snapshot references it.

## MVP Implementation Stack

Any stack is acceptable if it keeps the API small and testable. A practical TypeScript path is:

- Node API service with Fastify or Express.
- PostgreSQL for sync groups, devices, pairing sessions, events, and cursors.
- S3-compatible object storage for media.
- Zod schemas shared with app packages for envelope validation.

Local development can use Docker Compose for PostgreSQL and object storage, plus a seeded paired-device fixture.

## Host Definition of Done

- A desktop device can push deck, card, and review events.
- An Android device can pair, pull those events, and hydrate a local database.
- Duplicate pushes are idempotent.
- Pull cursors prevent repeated delivery after acknowledgement.
- The host never receives or returns OpenAI API keys.
- Basic integration tests cover two devices syncing in both directions.
