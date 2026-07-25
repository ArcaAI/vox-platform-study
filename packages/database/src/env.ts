/**
 * Environment loading for `@arcaai/database` (seeds, scripts, the Prisma client).
 *
 * ## Why this is a second copy
 *
 * The canonical declaration of HOPE's env-file contract lives in
 * `packages/applications/src/common/env/env-file-resolution.ts`. This package
 * CANNOT import it: `@arcaai/applications` depends on `@arcaai/database`, so a
 * package edge would be circular, and a relative source import would emit
 * applications sources into this package's `dist`. The policy below is
 * therefore mirrored by hand and pinned by `__tests__/env.test.ts`. Any change
 * to the contract must be made in BOTH places.
 *
 * This module matters more than it looks: importing `@arcaai/database` runs
 * `loadDatabaseEnv()` at module scope, so in `apps/api` this is the FIRST
 * loader to execute (via `@arcaai/applications`' barrel, before `bootstrap()`).
 *
 * ## The contract
 * - Precedence: **host env > env file > schema default** — the file NEVER
 *   overrides a variable already present in `process.env`.
 * - One file per `NODE_ENV` (see {@link ENV_FILE_MAP}); no `.env` fallback —
 *   the root `.env` is docker-compose interpolation input, not app config.
 * - Nothing is read when `CI=true` or `NODE_ENV=production`.
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

export type Environment = 'development' | 'test' | 'production' | 'staging';

/**
 * Maps NODE_ENV values to their corresponding .env file names
 * Exported for testing purposes
 */
export const ENV_FILE_MAP: Record<Environment, string> = {
  development: '.env.dev',
  test: '.env.test',
  production: '.env.production',
  staging: '.env.staging',
};

/**
 * Check if running in a CI environment
 * Exported for testing purposes
 */
export function isCI(): boolean {
  return process.env.CI === 'true' || process.env.CI === '1';
}

/**
 * Get the current NODE_ENV with fallback to 'development'
 * Exported for testing purposes
 */
export function getNodeEnv(): Environment {
  const env = process.env.NODE_ENV as Environment;
  if (env && ['development', 'test', 'production', 'staging'].includes(env)) {
    return env;
  }
  return 'development';
}

/**
 * Find the monorepo root directory by searching for package.json with "hope-monorepo"
 * Exported for testing purposes
 */
export function findMonorepoRoot(startDir?: string): string | null {
  let currentDir = startDir || process.cwd();
  const maxDepth = 10;
  let depth = 0;

  while (depth < maxDepth) {
    const packageJsonPath = path.join(currentDir, 'package.json');

    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        if (packageJson.name === 'hope-monorepo') {
          return currentDir;
        }
      } catch {
        // Ignore JSON parse errors
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }

    currentDir = parentDir;
    depth++;
  }

  return null;
}

/**
 * Load environment variables from the appropriate .env file
 *
 * This function is automatically called when this module is imported,
 * but can also be called manually if needed.
 */
export function loadDatabaseEnv(): { loaded: boolean; path?: string } {
  const nodeEnv = getNodeEnv();
  const ciEnv = isCI();

  // In CI or production, skip loading env files
  if (ciEnv || nodeEnv === 'production') {
    return { loaded: false };
  }

  const rootDir = findMonorepoRoot();
  if (!rootDir) {
    return { loaded: false };
  }

  // Exactly one candidate file per NODE_ENV. There is deliberately no `.env`
  // fallback — the root `.env` is docker-compose interpolation input.
  const envFilePath = path.join(rootDir, ENV_FILE_MAP[nodeEnv]);
  if (!fs.existsSync(envFilePath)) {
    return { loaded: false };
  }

  // `override: false` is the precedence contract, not a tunable: host
  // environment variables always win over the file. This also makes the call
  // idempotent, which matters because `apps/api` loads env again in
  // `bootstrap()` and once more in `ConfigService`.
  const result = dotenv.config({ path: envFilePath, override: false });

  if (result.error) {
    return { loaded: false };
  }

  return { loaded: true, path: envFilePath };
}

// Auto-load on import. Unconditional: because the file never overrides host
// env, values injected by `dotenv-cli` in the test suites still win, so the
// former `NODE_ENV !== 'test' || !DATABASE_URL` guard no longer has an effect.
loadDatabaseEnv();
