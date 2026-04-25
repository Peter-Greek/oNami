import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    main: 'electron/main.ts',
    preload: 'electron/preload.ts',
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
