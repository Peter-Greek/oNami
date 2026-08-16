import fs from 'node:fs'

/**
 * Minimal `.env` reader shared by the server and the maintenance scripts, so a
 * script run by hand resolves the same database and media directory the running
 * host uses. Real environment variables always win.
 */
export const loadEnvFile = (filePath) => {
  if (!fs.existsSync(filePath)) return

  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) continue
    const [, key, rawValue] = match
    if (process.env[key] !== undefined) continue
    process.env[key] = rawValue.trim().replace(/^"(.*)"$/, '$1')
  }
}
