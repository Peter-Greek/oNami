# Android Version Plan

## Goal

Create an Android version of oNami that preserves the current desktop app's core loop: import or receive decks, study cards offline, schedule reviews with FSRS, track progress, and sync progress between devices. Desktop and Android should both remain local-first. The host service should coordinate sync, not become the main app backend.

## Current Sideloadable MVP

The repository now has a first Android debug build path under `android/`. This is intentionally a WebView shell around the existing Vite renderer, backed by a browser-local `OnamiApi` implementation in `src/browserOnami.ts`.

This MVP is meant for phone testing before the larger React Native/shared-core migration. It supports:

- launching as a native Android app package;
- creating decks and cards locally on the phone;
- studying cards offline with the same FSRS library used by desktop;
- persisting decks, cards, review state, review logs, settings, and stats in WebView local storage;
- rebuilding the APK with `npm run android:build`.

The generated sideload artifact is:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

Known MVP limits:

- APKG import is not implemented on Android yet.
- Sync is not implemented yet.
- AI card generation is not implemented on Android yet.
- Storage uses WebView local storage, not Android SQLite.
- This is a debug APK signed by the default debug key, suitable for sideload testing only.

## Recommended Direction

Use React Native for the Android app, with a shared TypeScript core extracted from the existing Electron app. A simple WebView wrapper would reuse more UI initially, but it would make SQLite access, media storage, file import, offline behavior, and long-term mobile UX harder. React Native gives better access to local storage, file pickers, audio, notifications, and Android lifecycle events.

The current sideloadable MVP deliberately uses the WebView wrapper path to get a working phone build quickly. Keep the React Native direction for the durable Android app once the local-first storage, import, media, and sync contracts are ready to extract.

Keep Electron for desktop. Do not try to run Electron code on Android. Instead, split reusable logic out of the current desktop process boundary.

## Target Repository Shape

Long term, move toward this structure:

```text
apps/
  desktop/              # current Electron + Vite app
  android/              # React Native Android app
  host/                 # optional sync host service
packages/
  shared/               # DTOs, zod schemas, sync events, constants
  scheduler/            # FSRS wrapper and queue selection logic
  storage-contracts/    # repository interfaces and migrations
```

This does not need to happen in one commit. Start by extracting `src/shared/types.ts` and pure domain code from `electron/domain/scheduler.ts`.

## Current Desktop Areas to Reuse

- `src/shared/types.ts`: DTOs and public app contract.
- `electron/domain/scheduler.ts`: scheduling and card selection behavior.
- Import concepts from `electron/domain/apkgImporter.ts`, though Android file handling will need platform-specific work.
- Database schema concepts from `electron/domain/database.ts`: `decks`, `notes`, `cards`, `review_state`, `review_state_seed`, `review_log`, `media`, and `settings`.

## Android App Architecture

Use these app layers:

- UI: React Native screens for Study, Create, Import, Stats, and Settings.
- App services: Android equivalent of `AppServices`, with no Electron dependencies.
- Local storage: SQLite on device, with migrations matching the shared schema.
- Media storage: app-private file directory keyed by `media.id` or content hash.
- Sync client: push local changes, pull remote changes, apply in deterministic order.
- Native integrations: Android document picker for `.apkg`, audio playback, secure key storage, notifications for due cards.

The Android app should call a local `OnamiApi`-style service directly rather than using IPC. Keep the method names close to the desktop API so UI behavior remains comparable.

## Sync Model

Use event-based sync instead of raw database replacement. Each device keeps its own SQLite database and appends local changes to a `sync_outbox` table. The host stores events and delivers them to the other devices in the same sync group.

Recommended local additions:

```text
sync_devices(device_id, name, platform, created_at, last_seen_at)
sync_outbox(event_id, device_id, sequence, entity_type, entity_id, event_type, payload_json, created_at, pushed_at)
sync_inbox(event_id, source_device_id, applied_at)
sync_cursors(device_id, host_cursor, updated_at)
entity_tombstones(entity_type, entity_id, deleted_at, deleted_by_event_id)
```

Stable UUIDs are required for decks, notes, cards, media, and review events. Avoid autoincrement IDs for synced entities.

## Sync Event Types

Minimum event set:

- `deck.upsert`
- `deck.delete`
- `note.upsert`
- `card.upsert`
- `card.delete`
- `review.answer`
- `review.resetScheduling`
- `media.put`
- `settings.update`

For reviews, treat `review_log` as append-only. Sync the review event and resulting `review_state` snapshot together so another device can show the same due state without replaying every FSRS detail immediately. Later, the app can validate or rebuild `review_state` from logs.

## Conflict Rules

- Review logs are append-only; never overwrite another device's review entry.
- `review_state` resolves by latest `reviewed_at`, then by event id for ties.
- Deck, note, and card edits use last-write-wins by `updated_at` for MVP.
- Deletes create tombstones and should win over older upserts.
- Media is content-addressed where possible; duplicate hashes should not upload twice.
- Settings should be split into user-level settings and device-level settings. Do not sync OpenAI API keys.

## Device Pairing and Sync Identity

Do not require a hosted account, phone number, Google sign-in, or email for sync MVP. Each app install should create and persist a local `device_id` plus a device key pair. The host uses a sync group to know which devices are allowed to exchange events.

Use "device key" in implementation and UI copy, not "passkey", to avoid confusion with platform WebAuthn passkeys.

MVP manual pairing flow:

1. Desktop and Android each create or restore a stable `device_id` and device key.
2. User opens sync settings on both devices.
3. One device starts pairing and receives a short pairing code from the host.
4. The other device enters or scans the code.
5. Both devices show a matching confirmation code so the user can verify they are pairing the intended devices.
6. User chooses one of:
   - copy desktop to phone;
   - copy phone to desktop;
   - merge both devices.
7. Host creates a `sync_group_id`, records both devices as members, and stores their public keys.
8. Devices push and pull sync events for that sync group.
9. Future app starts push pending events first, then pull remote events.

USB-assisted pairing can be added as a convenience path: if the phone is connected to the desktop, the desktop app can exchange the pairing payload directly and skip typing the code. The same host-side pairing and confirmation rules should still apply.

Pairing decisions:

- Copy mode should treat the chosen source as authoritative and replace or archive local synced entities on the target before applying source events.
- Merge mode should upload both devices' events and resolve conflicts through the normal sync rules.
- Device removal should revoke that device's membership in the sync group without deleting its local data.
- The app must still work offline without any paired device or host connection.

## Android Feature Milestones

### Phase 1: Shared Core

- Extract shared DTOs, validation schemas, and scheduler logic into reusable packages.
- Add tests for scheduler and sync event serialization.
- Keep the desktop app behavior unchanged.

### Phase 2: Local Android MVP

- Create the React Native Android app.
- Implement local SQLite schema and migrations.
- Build Study, deck list, card reveal, answer buttons, and basic Stats.
- Verify offline review scheduling matches desktop test cases.

### Phase 3: Sync MVP

- Add desktop sync outbox generation for deck/card/review mutations.
- Build host service described in `HOST.MD`.
- Implement Android push/pull and first-pair hydration.
- Add conflict tests for review answers, deletes, and card edits.

### Phase 4: Import and Media

- Add Android `.apkg` import through Android's document picker.
- Store imported media locally and sync media metadata/blobs through the host.
- Support audio playback for imported Anki media.

### Phase 5: Polish and Release

- Add due-card notifications.
- Add device pairing, device management, and sync status UI.
- Run large-deck performance tests.
- Prepare Android signing, release build, privacy policy, and store assets.

## Desktop Changes Required

- Add device pairing and sync settings UI.
- Add a sync service beside `AppServices`.
- Emit sync events from create, update, delete, import, answer, reset, and settings paths.
- Add migration support for sync metadata tables.
- Add background sync with clear status: idle, syncing, offline, failed, needs pairing.

## Key Risks

- Native modules: `better-sqlite3` is desktop-only; Android needs a different SQLite adapter behind the same storage contract.
- APKG import: Android file permissions and large deck memory use need separate testing.
- Media sync: large audio/image decks need chunking or resumable uploads.
- Conflict handling: review progress must be deterministic across devices.
- Secrets: API keys should stay device-local unless explicit encrypted backup is added later.

## Definition of Done

- A user can study on desktop, pair Android, and see the same decks and due progress.
- A user can answer cards offline on Android, later open desktop, and see the updated review state.
- Sync does not expose OpenAI API keys to the host or other devices.
- Tests cover scheduler parity, sync event application, tombstones, and duplicate event handling.
