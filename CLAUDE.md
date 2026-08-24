# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

oNami is a desktop flashcard app (Electron + React + TypeScript) for importing Anki `.apkg` decks and studying them with FSRS spaced repetition. All data is local, stored in SQLite under the Electron `userData` directory. See `README.md` for the end-user feature tour.

## Commands

- `npm run dev` — runs renderer (Vite, port 5173) and Electron concurrently. `dev:electron` waits on the Vite server, rebuilds the Electron bundle with tsup, then launches Electron pointed at the dev URL.
- `npm run build` — typecheck (`tsc -b`), build Electron main/preload (tsup → `dist-electron/*.cjs`), then build renderer (Vite → `dist/`).
- `npm run lint` — ESLint over the repo.
- `npm test` — Vitest (`vitest run`). Tests live next to sources as `*.test.ts` (currently `electron/domain/*.test.ts`). Run a single file: `npx vitest run electron/domain/scheduler.test.ts`. Watch a single test by name: `npx vitest -t "name"`.
- `npm run build:win` / `build:mac` / `dist` — package with electron-builder into `release/`.
- `npm run windows:publish` — `build:win`, then publish the installer plus `windows.json` metadata into `release/windows/` for the host to serve as an in-app update.

### Native module gotcha (better-sqlite3)

`better-sqlite3` is a native addon and must be compiled against the right ABI:
- Packaging scripts run `rebuild:electron` (`electron-rebuild`) **before** electron-builder to target Electron's ABI, then `rebuild:native` (`npm rebuild better-sqlite3`) **after** to restore the Node ABI so `npm test` / `npm run dev` work again.
- If tests or dev crash with a Node/native version mismatch after building, run `npm run rebuild:native`. If Electron crashes loading the DB, run `npm run rebuild:electron`.

## Architecture

Two separate build pipelines produce one app:
- **Renderer** (`src/`): React 18 SPA, bundled by Vite. Path aliases `@` → `src`, `@shared` → `src/shared`.
- **Main + preload** (`electron/`): bundled by tsup to CommonJS `.cjs` (Electron entry is `dist-electron/main.cjs`). `electron` and `better-sqlite3` are kept external.

### Process boundary and the IPC contract

`src/shared/types.ts` is the single source of truth shared by both sides. It defines all DTOs **and** the `OnamiApi` interface. Data flows:

```
React (src/App.tsx)  →  window.onami.*  →  preload.ts (contextBridge)
   →  ipcRenderer.invoke('channel')  →  main.ts ipcMain.handle  →  AppServices method
```

When adding or changing a feature that crosses the boundary, update **all four** in lockstep: the type/DTO in `shared/types.ts`, the `AppServices` method, the `ipcMain.handle` channel in `electron/main.ts`, and the `preload.ts` bridge entry. Context isolation is on and `nodeIntegration` is off, so the renderer only ever touches `window.onami`.

### Main-process domain layer (`electron/domain/`)

`main.ts` is thin: it creates the window, registers IPC handlers, and delegates everything to `AppServices`. `AppServices` is the orchestration layer and owns three collaborators:

- **`OnamiDatabase` (`database.ts`)** — all persistence via synchronous `better-sqlite3`. Owns the schema (created inline; tables: `decks`, `notes`, `cards`, `review_state`, `review_state_seed`, `review_log`, `media`, `settings`) and media file storage on disk. Imports run inside a transaction (`importTransaction`).
- **`SchedulerService` (`scheduler.ts`)** — wraps `ts-fsrs`. `answer()` advances a card's FSRS state, writes `review_state`, and appends to `review_log`. `selectCardsForMode()` (pure, unit-tested) picks the card queue for each `StudyMode` (`learn-new`, `review-due`, `mixed`, `unit-test`).
- **`ApkgImporter` (`apkgImporter.ts`)** — unzips `.apkg`, reads the embedded Anki SQLite collection, and returns decks/notes/cards/media for `AppServices.importApkg` to persist and de-duplicate.

### Concepts worth knowing

- **Scheduling reset / seed baseline**: `review_state_seed` is a snapshot of scheduling captured at import time (when "preserve scheduling" is on). "Reset scheduling" restores `review_state` from the seed — it does not touch overall streak/time-studied history. Study sessions are cleared on reset.
- **Study sessions are in-memory only**: `AppServices.sessions` is a `Map` of `StudySessionRuntime`; sessions are not persisted and are lost on app restart (or deck reset). The renderer must close the session it opened — `study.endSession` on finish, exit, deck/mode change, or unmount — because an open session holds back automatic syncing (a sync mid-session drops the transfer banner into the layout and used to clear the session out from under the next answer). `answer` closes the session itself on the last card.
- **Media serving**: imported media is served through a custom `onami-media://<mediaId>` protocol registered in `main.ts`. On import, `AppServices.rewriteMedia` rewrites `[sound:...]` and `src=` references (including Anki cloze/audio) to point at this protocol. Renderer HTML is sanitized with DOMPurify before display.
- **AI generation is optional**: `generateCards` calls OpenAI with a JSON-object response and validates it with a Zod schema (`aiDraftSchema`). The API key is encrypted at rest with Electron `safeStorage` and stored in the `settings` table; it never reaches the renderer (only `hasApiKey` is exposed).
- **Frameless window**: the window is frameless/transparent; window controls (minimize/maximize/close) are custom and driven over `window:*` IPC channels.
- **Self-update (Windows)**: the packaged app updates itself from the configured sync host. `scripts/build-windows.ps1 -Publish` stamps a timestamp `versionCode` into the Electron bundle (via `tsup.config.ts` `env`) and publishes the installer plus `release/windows/windows.json`; the host serves both under `/downloads/`. `AppServices.checkForUpdate` / `downloadUpdate` compare version codes, download the installer as an `app-update` transfer (resumable, checksum-verified against the metadata), and `updates:install` spawns it detached before quitting. Unpackaged and non-Windows builds report version code `0` and the updater reports `unsupported`.

## Conventions

- Strict TypeScript with `noUnusedLocals`/`noUnusedParameters`; keep imports and params used.
- The renderer must not import from `electron/` and the main process must not import renderer-only modules — cross-process sharing goes through `src/shared/types.ts` only.
