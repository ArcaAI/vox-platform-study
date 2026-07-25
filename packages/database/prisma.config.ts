/**
 * Prisma CLI config for `@arcaai/database` (migrate / generate / studio).
 *
 * Env loading is delegated to the dependency-free `planEnvFileLoad()` in
 * `packages/applications/src/common/env` — the ONE declaration of the
 * NODE_ENV -> file map, the CI/production skip and the host-env-wins
 * precedence. It is imported by SOURCE PATH (like `./src/migration-url.ts`
 * above it) because this config is executed by the Prisma CLI before the
 * workspace is built; it is not a package dependency and never becomes one
 * (`@arcaai/applications` depends on `@arcaai/database`, not the reverse).
 */
import dotenv from 'dotenv'
import path from 'node:path'
import { defineConfig } from 'prisma/config'

import { planEnvFileLoad } from '../applications/src/common/env/env-file-resolution.ts'
import { resolveMigrationUrl } from './src/migration-url.ts'

const plan = planEnvFileLoad({ rootDir: path.resolve(__dirname, '..', '..') })
if (plan.envFilePath) {
  dotenv.config({ path: plan.envFilePath, override: plan.override })
}

// Prefer DIRECT_URL for migrations so that
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
  const hint = plan.isCI
    ? `Ensure CI_DATABASE_URL is configured in GitLab CI/CD Variables.`
    : !plan.shouldLoad
      ? `NODE_ENV=${plan.nodeEnv} reads the host environment only — no env file is loaded.`
      : plan.envFilePath
        ? `Ensure ${plan.envFilePath} defines DATABASE_URL (and optionally DIRECT_URL).`
        : `No env file was found for NODE_ENV=${plan.nodeEnv} (${plan.reason}).`
  throw new Error(
    `${original} Environment: NODE_ENV=${plan.nodeEnv}, CI=${plan.isCI}. ${hint}`,
  )
}

export default defineConfig({
  schema: 'src/prisma/db_main',
  datasource: {
    url: migrationUrl,
  },
})
