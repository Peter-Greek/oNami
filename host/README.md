# oNami Sync Host

Small Node.js relay service for paired-device sync. It does not require phone numbers, Google sign-in, or user accounts. Devices pair into a sync group, prove possession of their local device key, then push and pull event batches.

## Run Locally

```powershell
npm run host
```

Default URL:

```text
http://127.0.0.1:41729
```

Health check:

```powershell
Invoke-RestMethod http://127.0.0.1:41729/health
```

## PM2 on the Server

From this folder:

```bat
start-host.bat
```

The script deletes any old `onami-host` PM2 process, starts the current host through `ecosystem.config.cjs`, and saves the PM2 process list.

To stop:

```bat
stop-host.bat
```

## Port Forwarding

The host binds to `127.0.0.1:41729` by default. To expose a public port on Windows with `netsh portproxy`, run `start-host.bat` from an elevated prompt with:

```bat
set ONAMI_ENABLE_PORTPROXY=1
set ONAMI_PUBLIC_PORT=41729
set ONAMI_HOST_PORT=41729
start-host.bat
```

This resets:

```text
0.0.0.0:41729 -> 127.0.0.1:41729
```

For production, put HTTPS in front of the host. Portproxy is useful for a simple OVH Windows setup, but TLS should be handled by a reverse proxy or edge service before real data is synced.

## Environment

```text
ONAMI_HOST_BIND=127.0.0.1
ONAMI_HOST_PORT=41729
ONAMI_HOST_DATA_DIR=./data
ONAMI_HOST_CORS_ORIGIN=*
ONAMI_PAIRING_TTL_MS=600000
ONAMI_DEVICE_TOKEN_TTL_MS=604800000
ONAMI_MAX_JSON_BYTES=1048576
```

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
```

`/sync/*` endpoints require:

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

## Data

SQLite data is stored in:

```text
host/data/onami-host.sqlite
```

Back this directory up if the host has real synced events. The app remains local-first, but the host is the relay for newly paired devices and cross-device delivery.
