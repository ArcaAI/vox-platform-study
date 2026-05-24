import dotenv from 'dotenv'
import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'prisma/config'

import { resolveMigrationUrl } from './src/migration-url.ts'

const monorepoRoot = path.resolve(__dirname, '..', '..')

const ENV_FILE_MAP: Record<string, string> = {
  development: '.env.dev',
  test: '.env.test',
  production: '.env.production',
  staging: '.env.staging',
}

const nodeEnv = process.env.NODE_ENV || 'development'
const isCI = process.env.CI === 'true' || process.env.CI === '1'

if (!isCI && nodeEnv !== 'production') {
  const envFileName = ENV_FILE_MAP[nodeEnv] || '.env.dev'
  let envFilePath = path.join(monorepoRoot, envFileName)

  if (!fs.existsSync(envFilePath) && nodeEnv === 'development') {
    envFilePath = path.join(monorepoRoot, '.env')
  }

  if (fs.existsSync(envFilePath)) {
    dotenv.config({ path: envFilePath, override: nodeEnv !== 'test' })
  }
}

// TASK-302 Stream C Phase 2A: prefer DIRECT_URL for migrations so that
// Prisma Migrate's per-session advisory locks survive — those locks break
// under PgBouncer transaction-mode pooling. Falls back to DATABASE_URL
// for backwards compatibility when DIRECT_URL is unset (local dev).
let migrationUrl: string
try {
  migrationUrl = resolveMigrationUrl(process.env)
} catch (err) {
  // Re-wrap with the original environment context so existing CI/dev
  // error breadcrumbs stay useful.
  const original = err instanceof Error ? err.message : String(err)
  throw new Error(
    `${original} ` +
      `Environment: NODE_ENV=${nodeEnv}, CI=${isCI}. ` +
      (isCI
        ? `Ensure CI_DATABASE_URL is configured in GitLab CI/CD Variables.`
        : `Ensure .env.${nodeEnv === 'development' ? 'dev' : nodeEnv} exists at ${monorepoRoot} with DATABASE_URL (and optionally DIRECT_URL) defined.`),
  )
}

export default defineConfig({
  schema: 'src/prisma/db_main',
  datasource: {
    url: migrationUrl,
  },
})
