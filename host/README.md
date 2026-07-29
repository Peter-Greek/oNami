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
ONAMI_MAX_BLOB_BYTES=67108864
ONAMI_MEDIA_DIR=./media-store
```

`ONAMI_MAX_BLOB_BYTES` caps a single full-data snapshot or media upload; `ONAMI_MEDIA_DIR` is where content-addressed media blobs are written on disk.

## API Shape

```text
GET  /health
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
5. Host creates or updates the sync group.
6. Each device requests a device token.
7. Devices push local outbox events, pull remote events, and ack the cursor.

## Full Snapshot Handoff

When a fresh device pairs, the source device uploads a one-time full-data bundle
(decks, cards with their current review state, the entire review-log history that
drives stats/streak, and media metadata) via `POST /sync/snapshot`, and uploads
each referenced media blob via `POST /media` (content-addressed by SHA-256). The
fresh device pulls the bundle with `GET /sync/snapshot`, downloads blobs with
`GET /media/:sha256`, then calls `POST /sync/snapshot/ack`, which deletes the
snapshot row **and its media blobs** from the host. All later changes flow through
the incremental `/sync/events` log. There is one pending snapshot per sync group;
a device never receives its own snapshot.

Redeploying with `start-host.bat` runs `prisma generate` + `prisma db push`, which
creates the new `sync_snapshots` table automatically — no manual migration needed.

## Data

State is stored in PostgreSQL:

```text
database: onami_sync
schema:   public
```

Back up the `onami_sync` database if the host has real synced events. The app remains local-first, but the host is the relay for newly paired devices and cross-device delivery.
