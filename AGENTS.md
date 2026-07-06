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
