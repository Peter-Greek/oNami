# Repository Guidelines

## Project Structure & Module Organization

oNami is an Electron, React, and TypeScript desktop app. Renderer code lives in `src/`; shared DTOs and IPC-facing types are in `src/shared/types.ts`. Electron main, preload, and domain code live in `electron/`. Core services and colocated `*.test.ts` files are under `electron/domain/`. Static assets are in `public/`, build resources in `build/`, generated renderer output in `dist/`, Electron output in `dist-electron/`, and packaged installers in `release/`.

## Build, Test, and Development Commands

- `npm run dev` - starts Vite, builds Electron with tsup, then launches the app.
- `npm run build` - typechecks, builds Electron main/preload, then builds the Vite renderer.
- `npm test` - runs Vitest once. Example: `npx vitest run electron/domain/scheduler.test.ts`.
- `npm run lint` - runs ESLint across TypeScript and TSX files.
- `npm run build:win` / `npm run build:mac` / `npm run dist` - package desktop builds with electron-builder.

If `better-sqlite3` ABI errors appear after packaging, run `npm run rebuild:native` for Node/test/dev use or `npm run rebuild:electron` for Electron runtime use.

## Coding Style & Naming Conventions

Use TypeScript throughout. Follow the existing 2-space indentation, semicolon-free style, single quotes, and trailing commas. Components and classes use `PascalCase`; functions, variables, and methods use `camelCase`; tests are named `*.test.ts`. Path aliases map `@` to `src` and `@shared` to `src/shared`.

Keep process boundaries explicit: renderer code must not import from `electron/`, and cross-process contracts belong in `src/shared/types.ts`.

## Testing Guidelines

Vitest is the test runner. Add focused unit tests next to the implementation, especially for scheduling, import, database, and domain behavior in `electron/domain/`. Prefer deterministic tests that do not depend on app window state. Run `npm test` before opening a PR; run targeted files while iterating.

## Commit & Pull Request Guidelines

The history is minimal and has no formal commit convention. Use short, imperative subjects such as `Add APKG import validation` or `Fix scheduler reset state`. Keep unrelated changes in separate commits.

Pull requests should include a concise summary, test results (`npm test`, `npm run lint`, or reasons skipped), linked issues when applicable, and screenshots for UI changes. Call out native-module rebuild or packaging impact.

## Agent-Specific Instructions

When changing IPC-backed features, update all related pieces together: `src/shared/types.ts`, the relevant `AppServices` method, `electron/main.ts` IPC handler, and `electron/preload.ts` bridge entry. Preserve local-only data handling and avoid exposing secrets, especially OpenAI API keys, to the renderer.

## Mandatory Android Remote Deployment

After completing any change that affects the oNami app, deploy it unless the
user explicitly says not to deploy. Do not stop after editing or testing. The
required outcome is: commit the change, push it to `origin/main`, fast-forward
the remote checkout, build and publish the Android APK on the remote host,
verify the public download, and return the download link to the user.

Use the `main-server-ssh` skill and treat the remote host as production.

- SSH: `admin@147.135.31.128` on port `2222`
- Identity: `C:\Users\xerxe\.ssh\id_ed25519`
- Remote oNami checkout: `C:\Users\admin\Desktop\oNami`
- Production branch: `main`
- Remote publish command: `npm run android:publish`
- Stable APK URL: `http://147.135.31.128:41729/downloads/onami-latest.apk`
- Metadata URL: `http://147.135.31.128:41729/downloads/android.json`
- Health URL: `http://147.135.31.128:41729/health`

Follow this sequence every time:

1. Inspect local status and preserve unrelated work. Run the relevant tests,
   `npm test`, `npm run lint`, and `npm run build` in proportion to the change.
2. Commit only the intended files with a short imperative commit message.
3. Push the exact commit to `origin/main`, normally with
   `git push origin HEAD:main`, and record the full pushed SHA.
4. Before changing the remote checkout, run `git status -sb`,
   `git branch --show-current`, `git remote -v`, and `git rev-parse HEAD` in
   `C:\Users\admin\Desktop\oNami`. Refuse to overwrite unrelated dirty state.
5. Run `git pull --ff-only origin main`. The server's GitHub credential helper
   may fail for this private repository. If it does, use the verified bundle
   fallback below; never reset, force-checkout, or copy source files over the
   checkout.
6. Verify remote `HEAD` exactly equals the pushed full SHA and that the remote
   worktree is clean.
7. Run `npm run android:publish` in the remote checkout. This installs locked
   dependencies, builds the renderer and Android app, and atomically publishes
   `release\android\onami-latest.apk` plus `android.json`.
8. Do not replace, remove, display, or transmit the remote Android signing key
   at `C:\Users\admin\.android\debug.keystore`. It is deliberately persistent
   so downloaded builds can update existing matching installations.
9. Restart `onami-host` with `pm2 restart onami-host --update-env` only when
   host code or download-serving behavior changed. A normal app-only APK build
   does not require a host restart because publishing replaces the served file
   atomically.
10. Verify the metadata reports the expected `gitSha`, `gitDirty: false`, a
    nonzero size, and a SHA-256. Verify the APK URL returns `200`, and a request
    with `Range: bytes=0-1023` returns `206` with exactly 1024 bytes. Verify the
    health URL still returns `ok: true`.
11. Return a clickable cache-busting link such as
    `http://147.135.31.128:41729/downloads/onami-latest.apk?v=<versionCode>`
    using the published `versionCode`, plus the version and commit SHA. Tell the
    user to cancel any older stuck Chrome download before tapping the new link.

### Verified Git-bundle fallback

Use this only when the remote host cannot authenticate to GitHub:

1. Independently confirm `git ls-remote origin refs/heads/main` equals the
   exact commit just pushed.
2. Create a complete bundle from the updated local tracking ref with
   `git bundle create <temp-bundle> origin/main`, then run
   `git bundle verify <temp-bundle>`.
3. Copy the bundle over SSH to a specific temporary file under
   `C:\Users\admin\AppData\Local\Temp` without exposing the SSH key.
4. In the remote checkout, fetch only
   `refs/remotes/origin/main:refs/remotes/origin/main` from that bundle.
5. Confirm remote `refs/remotes/origin/main` equals the exact pushed SHA, then
   run `git merge --ff-only refs/remotes/origin/main`.
6. Confirm remote `HEAD` equals the pushed SHA, report status, and remove only
   the specific temporary bundle file.
