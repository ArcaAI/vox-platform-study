/**
 * Environment Loading Utility for Applications Package
 *
 * Centralized utility for loading environment variables from the correct
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
import fs from 'fs';
import path from 'path';

// ============================================================================
// Types
// ============================================================================

export type Environment = 'development' | 'test' | 'production' | 'staging';

export interface LoadEnvOptions {
  /** Explicit path to env file (overrides auto-detection) */
  envFilePath?: string;
  /** Override existing environment variables (default: true for dev, false for test) */
  override?: boolean;
  /** Enable debug logging */
  debug?: boolean;
}

export interface LoadEnvResult {
  /** Whether an env file was loaded */
  loaded: boolean;
  /** Path to the loaded env file (if any) */
  envFilePath?: string;
  /** Current NODE_ENV value */
  nodeEnv: Environment;
  /** Whether running in CI environment */
  isCI: boolean;
  /** Error message if loading failed */
  error?: string;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Maps NODE_ENV values to their corresponding .env file names
 */
const ENV_FILE_MAP: Record<Environment, string> = {
  development: '.env.dev',
  test: '.env.test',
  production: '.env.production',
  staging: '.env.staging',
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if running in a CI environment
 */
export function isCI(): boolean {
  return process.env.CI === 'true' || process.env.CI === '1';
}

/**
 * Get the current NODE_ENV with fallback to 'development'
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

// ============================================================================
// Main Functions
// ============================================================================

/**
 * Load environment variables from the appropriate .env file
 *
 * @param options - Configuration options
 * @returns Result object with loading status and details
 *
 * @example
 * ```typescript
 * // Auto-detect based on NODE_ENV
 * const result = loadEnv();
 *
 * // Specify explicit file
 * const result = loadEnv({ envFilePath: '/path/to/.env.custom' });
 *
 * // In test mode with no override
 * const result = loadEnv({ override: false });
 * ```
 */
export function loadEnv(options: LoadEnvOptions = {}): LoadEnvResult {
  const nodeEnv = getNodeEnv();
  const ciEnv = isCI();
  const { envFilePath: explicitPath, override, debug } = options;

  // Base result
  const result: LoadEnvResult = {
    loaded: false,
    nodeEnv,
    isCI: ciEnv,
  };

  // In CI or production, skip loading env files (use host environment)
  if (ciEnv || nodeEnv === 'production') {
    if (debug) {
      console.log(`[loadEnv] Skipping env file load (CI: ${ciEnv}, NODE_ENV: ${nodeEnv})`);
    }
    return result;
  }

  // Determine env file path
  let envFilePath: string;

  if (explicitPath) {
    // Use explicit path if provided
    envFilePath = explicitPath;
  } else {
    // Auto-detect based on NODE_ENV
    const rootDir = findMonorepoRoot();
    if (!rootDir) {
      result.error = 'Could not find monorepo root';
      return result;
    }

    const envFileName = ENV_FILE_MAP[nodeEnv];
    envFilePath = path.join(rootDir, envFileName);

    // Fall back to .env for development (backwards compatibility)
    if (!fs.existsSync(envFilePath) && nodeEnv === 'development') {
      const fallbackPath = path.join(rootDir, '.env');
      if (fs.existsSync(fallbackPath)) {
        envFilePath = fallbackPath;
      }
    }
  }

  // Check if file exists
  if (!fs.existsSync(envFilePath)) {
    if (debug) {
      console.log(`[loadEnv] Env file not found: ${envFilePath}`);
    }
    result.error = `Env file not found: ${envFilePath}`;
    return result;
  }

  // Determine override behavior
  // Default: override=true for development, override=false for test
  const shouldOverride = override !== undefined ? override : nodeEnv !== 'test';

  if (debug) {
    console.log(`[loadEnv] Loading ${envFilePath} (override: ${shouldOverride})`);
  }

  // Load the env file
  const dotenvResult = dotenv.config({ path: envFilePath, override: shouldOverride });

  if (dotenvResult.error) {
    result.error = dotenvResult.error.message;
    return result;
  }

  result.loaded = true;
  result.envFilePath = envFilePath;

  return result;
}

/**
 * Get the expected env file path for current environment
 */
export function getEnvFilePath(): string | null {
  const nodeEnv = getNodeEnv();
  const rootDir = findMonorepoRoot();

  if (!rootDir) {
    return null;
  }

  const envFileName = ENV_FILE_MAP[nodeEnv] || '.env.dev';
  const envFilePath = path.join(rootDir, envFileName);

  if (fs.existsSync(envFilePath)) {
    return envFilePath;
  }

  // Fall back to .env for development
  if (nodeEnv === 'development') {
    const fallbackPath = path.join(rootDir, '.env');
    if (fs.existsSync(fallbackPath)) {
      return fallbackPath;
    }
  }

  return null;
}
