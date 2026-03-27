import dotenv from 'dotenv'
import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'prisma/config'

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

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error(
    `DATABASE_URL is not set. ` +
    `Environment: NODE_ENV=${nodeEnv}, CI=${isCI}. ` +
    (isCI
      ? `Ensure CI_DATABASE_URL is configured in GitLab CI/CD Variables.`
      : `Ensure .env.${nodeEnv === 'development' ? 'dev' : nodeEnv} exists at ${monorepoRoot} with DATABASE_URL defined.`)
  )
}

export default defineConfig({
  schema: 'src/prisma/db_main',
  datasource: {
    url: databaseUrl,
  },
})
