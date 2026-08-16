import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    main: 'electron/main.ts',
    preload: 'electron/preload.ts',
  },
  // Baked in by scripts/build-windows.ps1 so a packaged app can tell the host
  // which build it is. A `0` code marks a build nobody published, and the
  // updater refuses to compare against it.
  env: {
    ONAMI_VERSION_CODE: process.env.ONAMI_VERSION_CODE ?? '0',
    ONAMI_VERSION_NAME: process.env.ONAMI_VERSION_NAME ?? '',
  },
  clean: true,
  dts: false,
  external: ['electron', 'better-sqlite3'],
  format: ['cjs'],
  minify: false,
  outDir: 'dist-electron',
  outExtension: () => ({ js: '.cjs' }),
  platform: 'node',
  shims: false,
  sourcemap: true,
  target: 'node20',
})
