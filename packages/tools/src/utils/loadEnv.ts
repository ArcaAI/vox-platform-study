/**
 * Environment Loading Utility for Tools Package
 *
 * Shared utility for loading environment variables from the correct
 * .env file based on NODE_ENV.
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
import fs from 'fs';
import path from 'path';

/**
 * Maps NODE_ENV values to their corresponding .env file names
 */
const ENV_FILE_MAP: Record<string, string> = {
  development: '.env.dev',
  test: '.env.test',
  production: '.env.production',
  staging: '.env.staging',
};

/**
 * Find the monorepo root by looking for package.json with "hope-monorepo"
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
 */
export function loadToolsEnv(): { loaded: boolean; path?: string } {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const isCI = process.env.CI === 'true' || process.env.CI === '1';

  // In CI or production, skip loading env files
  if (isCI || nodeEnv === 'production') {
    return { loaded: false };
  }

  const rootDir = findMonorepoRoot();
  if (!rootDir) {
    return { loaded: false };
  }

  // Try environment-specific file first
  const envFileName = ENV_FILE_MAP[nodeEnv] || '.env.dev';
  let envFilePath = path.join(rootDir, envFileName);

  // Fall back to .env for development
  if (!fs.existsSync(envFilePath) && nodeEnv === 'development') {
    envFilePath = path.join(rootDir, '.env');
    if (!fs.existsSync(envFilePath)) {
      return { loaded: false };
    }
  }

  if (!fs.existsSync(envFilePath)) {
    return { loaded: false };
  }

  // Don't override in test mode
  const override = nodeEnv !== 'test';
  const result = dotenv.config({ path: envFilePath, override });

  if (result.error) {
    return { loaded: false };
  }

  return { loaded: true, path: envFilePath };
}

// Auto-load when imported
loadToolsEnv();
