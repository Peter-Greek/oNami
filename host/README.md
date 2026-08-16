# oNami Sync Host

Small Node.js relay service for paired-device sync. It does not require phone numbers, Google sign-in, or user accounts. Devices pair into a sync group, prove possession of their local device key, then push and pull event batches.

The host uses the same deployment style as Orbit Server: Node.js, Prisma, and PostgreSQL. It uses its own database (`onami_sync`) and database user (`onami_user`), separate from Orbit.

## Run Locally

```powershell
cd host
npm install --include=dev
npm run prisma:generate
npm run prisma:push -- --accept-data-loss
npm start
```

Default URL after `setup.bat`:

```text
http://127.0.0.1:41730
```

Health check:

```powershell
Invoke-RestMethod http://127.0.0.1:41730/health
```

## Android APK download

Build and atomically publish the latest Android APK from the repository root:

```powershell
npm run android:publish
```

The build script bootstraps JDK 17 and the required Android SDK packages when
they are missing. The host serves the last successful build at:

```text
http://147.135.31.128:41729/downloads/onami-latest.apk
```

Build metadata, including version, commit, size, and SHA-256, is available at:

```text
http://147.135.31.128:41729/downloads/android.json
```

Every build receives a timestamp-based Android version code. Android builds
made on this server share its persistent debug signing key, so later remote
builds can update earlier remote builds in place.

## PM2 on the Server

First run setup once:

```bat
setup.bat
```

That creates:

```text
database: onami_sync
user:     onami_user
env:      host/.env
```

From this folder:

```bat
start-host.bat
```

The script deletes any old `onami-host` PM2 process, starts the current host through `ecosystem.config.cjs`, and saves the PM2 process list.
It also installs host dependencies if needed, runs Prisma generate/db push, and checks `http://127.0.0.1:<ONAMI_HOST_PORT>/health` before reporting success.

To stop:

```bat
stop-host.bat
```

## Port Forwarding

The host binds to `127.0.0.1:41730` after `setup.bat`. To expose public `41729` on Windows with `netsh portproxy`, run `start-host.bat` from an elevated administrator prompt with:

```bat
set ONAMI_ENABLE_PORTPROXY=1
set ONAMI_PUBLIC_PORT=41729
set ONAMI_HOST_PORT=41730
start-host.bat
```

This resets:

```text
0.0.0.0:41729 -> 127.0.0.1:41730
```

Do not forward `41729` to `127.0.0.1:41729`. On Windows that can create a portproxy loop where requests connect, immediately close, and fill `netstat` with thousands of `TIME_WAIT` rows.

If `netsh` says the requested operation requires elevation, close the prompt and reopen Command Prompt with "Run as administrator".

If PM2 says the process is online but health fails, run:

```bat
pm2 logs onami-host --lines 80 --nostream
netstat -ano | findstr ":41730"
powershell -NoProfile -Command "Invoke-RestMethod http://127.0.0.1:41730/health"
```

For production, put HTTPS in front of the host. Portproxy is useful for a simple OVH Windows setup, but TLS should be handled by a reverse proxy or edge service before real data is synced.

## Environment

```text
ONAMI_HOST_BIND=127.0.0.1
ONAMI_HOST_PORT=41730
ONAMI_HOST_CORS_ORIGIN=*
DATABASE_URL=postgresql://onami_user:<password>@localhost:5432/onami_sync?schema=public
ONAMI_PAIRING_TTL_MS=600000
ONAMI_DEVICE_TOKEN_TTL_MS=604800000
ONAMI_MAX_JSON_BYTES=1048576
ONAMI_MAX_GLOBAL_DECK_JSON_BYTES=8388608
ONAMI_MAX_BLOB_BYTES=67108864
ONAMI_MAX_BLOB_CHUNK_BYTES=16777216
ONAMI_BLOB_SWEEP_ENABLED=0
ONAMI_MEDIA_DIR=./media-store
```

`ONAMI_MAX_BLOB_BYTES` caps a single full-data snapshot or media upload; `ONAMI_MEDIA_DIR` is where content-addressed media blobs are written on disk. See the blob store section for the chunk and sweep settings.

## API Shape

```text
GET  /health
GET  /global-decks?search=<text>&sort=hearts&installationId=<id>
GET  /global-decks/:id?installationId=<id>
POST /global-decks
POST /global-decks/:id/heart
POST /global-decks/media/check
POST /global-decks/media/:sha256
GET  /global-decks/media/:sha256
POST /blobs/check
HEAD /blob/:sha256
PATCH /blob/:sha256
GET  /blob/:sha256
POST /devices/bootstrap
POST /pairing/start
POST /pairing/join
POST /pairing/confirm
POST /devices/token
GET  /sync/events?after=<cursor>&limit=<n>
POST /sync/events
POST /sync/ack
POST /sync/snapshot
GET  /sync/snapshot
POST /sync/snapshot/ack
POST /media
GET  /media/:sha256
```

The global deck endpoints are public and use a stable anonymous installation
id for publishing and hearts. A published snapshot contains only its deck name
and card content; it never includes review history, scheduling, sync secrets,
or OpenAI settings. Re-publishing the same local deck from the same installation
updates its existing global entry.

Global deck media is content-addressed by SHA-256. Clients call the media check
endpoint before publishing and upload only hashes that are not already present,
including blobs previously uploaded through device sync. Downloaded cards remap
the publisher's media ids to ids in the receiving device's local media store.

`/sync/*` and `/media` endpoints require:

```text
Authorization: Bearer <device token>
```

Device tokens are issued by `POST /devices/token`. The request must include `deviceId`, `timestamp`, and a base64 signature over:

```text
<deviceId>.<timestamp>
```

The host verifies the signature against the paired device's stored public key.

## Pairing Flow

1. Device A calls `/pairing/start`.
2. Device B calls `/pairing/join` with the pairing code.
3. Both devices show the same confirmation code.
4. Both devices call `/pairing/confirm`.
5. Host creates or updates the sync group and identifies the full-snapshot source
   and target. For merge, Device A is the source; explicit desktop/phone copy
   modes follow the selected platform direction.
6. Each device requests a device token.
7. Devices push local outbox events, pull remote events, and ack the cursor.

## Blob Store

All binary content — device sync media and published deck media alike — belongs
in one content-addressed store. A blob is named by the SHA-256 of its bytes, so
the same audio file is stored once no matter how many sync groups or decks use
it.

Uploads are resumable, which is the point:

```text
POST  /blobs/check              { "sha256": [...] }
                                -> { present, partial: [{sha256, offset}], missing }
HEAD  /blob/:sha256             -> Upload-Offset, Upload-Complete
PATCH /blob/:sha256             raw bytes, Content-Range: bytes <start>-<end>/<total>
                                -> { sha256, offset, complete }
GET   /blob/:sha256             raw bytes, Accept-Ranges: bytes, honours Range
```

A client that is interrupted asks `HEAD` where the host stopped and continues
from that byte. It never restarts a file. A `PATCH` at the wrong offset answers
`409` carrying the correct offset, so a confused client corrects itself in one
round trip. A `PATCH` for a blob that is already complete answers `200` so a
retry after a lost response costs nothing. The host verifies the assembled bytes
hash to the requested name before publishing them; a mismatch discards the
upload.

`PATCH`, `HEAD`, and `POST /blobs/check` require a device token. `GET` is public
only for blobs referenced by a published deck; sync media still requires a token.

`ONAMI_MAX_BLOB_CHUNK_BYTES` caps one chunk (default 16 MiB) and
`ONAMI_MAX_BLOB_BYTES` caps a whole blob.

### Storage reclaim

A blob lives as long as something references it, tracked in `blob_refs` with a
scope of `sync-group` or `published-deck`. Nothing depends on a client
acknowledging anything, which is what previously stranded media whenever a
transfer crashed before its ack.

Report what could be reclaimed, changing nothing:

```powershell
node host/gc.js
```

Reclaim it:

```powershell
node host/gc.js --apply
```

Both runs first backfill `blobs` and `blob_refs` from what is already on disk:
published deck media is referenced, and sync media is referenced only where a
pending snapshot still needs it. A complete blob is deleted 24 hours after it
loses its last reference; an upload nobody resumes is abandoned after 7 days.

Set `ONAMI_BLOB_SWEEP_ENABLED=1` to also run the sweep hourly inside the server.
It is off by default so the first reclaim on an existing host is a deliberate,
reviewed `gc.js` run.

## Full Snapshot Handoff

When a fresh device pairs, the source device first publishes a one-time full-data
manifest (decks, cards with their current review state, the entire review-log
history that drives stats/streak, and media metadata) via `POST /sync/snapshot`.
It then uploads referenced media blobs in bounded parallel batches via
`POST /media` (content-addressed by SHA-256), and marks the manifest complete.
The target polls `GET /sync/snapshot`, applies cards as soon as the manifest
exists, and downloads each available media batch while the source is still
uploading. There is no fixed polling-attempt limit; durable client checkpoints
resume the process after an interruption. Once the source is complete and every
blob is stored, the target calls `POST /sync/snapshot/ack`, which deletes the
snapshot row **and its media blobs** from the host. A snapshot is addressed to
the newly paired target so an existing third device cannot consume it. All later
changes flow through the incremental `/sync/events` log. There is one pending
snapshot per sync group; a device never receives its own snapshot.

Redeploying with `start-host.bat` runs `prisma generate` + `prisma db push`, which
creates the new `sync_snapshots` table automatically — no manual migration needed.

## Data

State is stored in PostgreSQL:

```text
database: onami_sync
schema:   public
```

Back up the `onami_sync` database if the host has real synced events. The app remains local-first, but the host is the relay for newly paired devices and cross-device delivery.
