/**
 * Prisma Configuration File (Prisma 7+)
 *
 * Global configuration for the HOPE monorepo.
 *
 * This file provides configuration for Prisma CLI commands like:
 * - prisma db push
 * - prisma migrate dev
 * - prisma migrate deploy
 * - prisma db seed
 *
 * The datasource URL is loaded from the DATABASE_URL environment variable.
 *
 * ## Environment File Convention:
 * - `.env.dev` → Local development (NODE_ENV=development)
 * - `.env.test` → Local testing (NODE_ENV=test)
 * - `.env.production` → Production reference (NODE_ENV=production uses host env)
 *
 * ## CI/CD & Production:
 * - In CI (CI=true) or production, only host environment variables are used
 */

import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, env } from 'prisma/config';

// Map NODE_ENV to env file names
const ENV_FILE_MAP: Record<string, string> = {
  development: '.env.dev',
  test: '.env.test',
  production: '.env.production',
  staging: '.env.staging',
};

// Determine current environment
const nodeEnv = process.env.NODE_ENV || 'development';
const isCI = process.env.CI === 'true' || process.env.CI === '1';

// Only load env file in local development (not CI or production)
if (!isCI && nodeEnv !== 'production') {
  const envFileName = ENV_FILE_MAP[nodeEnv] || '.env.dev';
  let envFilePath = path.resolve(__dirname, envFileName);

  // Fall back to .env if env-specific file doesn't exist (backwards compatibility)
  if (!fs.existsSync(envFilePath) && nodeEnv === 'development') {
    envFilePath = path.resolve(__dirname, '.env');
  }

  if (fs.existsSync(envFilePath)) {
    // Don't override in test mode (dotenv-cli sets vars first)
    const override = nodeEnv !== 'test';
    dotenv.config({ path: envFilePath, override });
  }
}

export default defineConfig({
    // Path to the schema directory (multi-file schema)
    schema: path.join('packages', 'database', 'src', 'prisma', 'db_main'),

    // Migrations configuration
    migrations: {
        path: path.join('packages', 'database', 'src', 'prisma', 'db_main', 'migrations'),
    },

    // Database connection URL from environment
    datasource: {
        url: env('DATABASE_URL'),
    },
});
