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
 * ## Environment loading
 *
 * The NODE_ENV -> file map, the CI/production skip and the host-env-wins
 * precedence are NOT declared here — they come from the dependency-free
 * `planEnvFileLoad()` in `packages/applications/src/common/env`.
 *
 * It is imported by SOURCE PATH on purpose: this config is executed by the
 * Prisma CLI before anything in the workspace is built, so it cannot resolve
 * the `@arcaai/applications` package entry point. The imported module has no
 * dependencies beyond `node:fs` / `node:path`, so the CLI's TS loader can
 * transpile it standalone.
 */

import dotenv from 'dotenv';
import path from 'node:path';
import { defineConfig, env } from 'prisma/config';

import { planEnvFileLoad } from './packages/applications/src/common/env/env-file-resolution';

const plan = planEnvFileLoad({ rootDir: __dirname });
if (plan.envFilePath) {
  dotenv.config({ path: plan.envFilePath, override: plan.override });
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
