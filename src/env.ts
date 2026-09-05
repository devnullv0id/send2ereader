import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

const rootDir = resolve(import.meta.dirname, '..')

function resolveEnvPath(): string {
  const configured = process.env.ENV_FILE
  if (configured) return isAbsolute(configured) ? configured : join(rootDir, configured)
  return join(rootDir, '.env')
}

export const envFile = resolveEnvPath()
export const envFileLoaded = (() => {
  if (!existsSync(envFile)) return false
  try {
    process.loadEnvFile(envFile)
    return true
  } catch (err) {
    console.warn(`Could not read ${envFile}: ${(err as Error).message}`)
    return false
  }
})()
