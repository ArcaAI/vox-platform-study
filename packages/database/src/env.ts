/**
 * Environment Loading Utility for Database Package
 *
 * Standalone utility for loading environment variables from the correct
 * .env file based on NODE_ENV.
 *
 * ## Environment File Convention:
 * - `.env.dev` → Local development (NODE_ENV=development)
 * - `.env.test` → Local testing (NODE_ENV=test)
 * - `.env.production` → Production reference (NODE_ENV=production uses host env)
 *
 * ## Loading Priority:
 * 1. Host environment variables (always have highest priority)
 * 2. Environment-specific .env file (if exists and not in CI/production)
 *
 * ## CI/CD & Production:
 * - In CI (CI=true) or production, only host environment variables are used
 * - No .env files are loaded to ensure security and consistency
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

  // Try environment-specific file first
  const envFileName = ENV_FILE_MAP[nodeEnv];
  let envFilePath = path.join(rootDir, envFileName);

  if (!fs.existsSync(envFilePath)) {
    // Fall back to .env for development (backwards compatibility)
    if (nodeEnv === 'development') {
      envFilePath = path.join(rootDir, '.env');
      if (!fs.existsSync(envFilePath)) {
        return { loaded: false };
      }
    } else {
      return { loaded: false };
    }
  }

  // Don't override in test environment (env vars set by dotenv-cli take priority)
  const override = nodeEnv !== 'test';
  const result = dotenv.config({ path: envFilePath, override });

  if (result.error) {
    return { loaded: false };
  }

  return { loaded: true, path: envFilePath };
}

// Auto-load when module is imported (unless in test mode where dotenv-cli handles it)
// In test mode, we only load if DATABASE_URL is not already set
const shouldAutoLoad = process.env.NODE_ENV !== 'test' || !process.env.DATABASE_URL;
if (shouldAutoLoad) {
  loadDatabaseEnv();
}
