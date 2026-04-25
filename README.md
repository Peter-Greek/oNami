# oNami

oNami is a desktop flashcard learner built with Electron, React, TypeScript, SQLite, and FSRS scheduling. It imports Anki `.apkg` decks, stores cards locally, supports rich manual and AI-assisted card creation, and packages into one-file installers.

## Development

```bash
npm install
npm run dev
```

The dev command starts Vite and launches Electron against the local renderer.

## Verification

```bash
npm run lint
npm test
npm run build
```

The tests cover scheduler queue behavior, legacy APKG parsing with media, and duplicate-aware APKG import through the SQLite service layer.

## Packaging

```bash
build-windows.bat
```

or:

```bash
npm run build:win
npm run build:mac
```

Windows artifacts are written to `release/`, including `oNami-0.1.0-Setup.exe`. macOS artifacts are built on macOS, normally through GitHub Actions.

The packaging scripts rebuild `better-sqlite3` for Electron before creating installers, then rebuild it back for local Node-based tests and tooling.

## Release

Push a version tag like `v0.1.0` or run the `Release` workflow manually. The workflow builds Windows and macOS installers and publishes them to GitHub Releases using `GITHUB_TOKEN`.

Code signing and notarization are intentionally left optional for now. Unsigned local builds work; production releases should add platform certificates before broad distribution.
