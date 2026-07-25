/**
 * `loadEnv()` — the single TypeScript env-loading implementation.
 *
 * Every TS entry point that needs `.env.*` values goes through this function:
 * `apps/api/src/main.ts` (before `NestFactory.create`), `ConfigService`, and
 * the CLI tooling. The *decision* of which file to read lives in the
 * dependency-free `./env-file-resolution` module so that `prisma.config.ts`
 * — which runs before anything is built — can share it verbatim.
 *
 * ## Contract (see `./env-file-resolution` for the authoritative statement)
 * - Precedence: **host env > env file selected by `NODE_ENV` > schema default**.
 *   The file never overwrites a variable already in `process.env`.
 * - No file is read when `CI=true` or `NODE_ENV=production`.
 * - There is no `.env` fallback; the root `.env` is docker-compose input only.
 */

import dotenv from 'dotenv';

import { planEnvFileLoad, type Environment } from './env-file-resolution';

export {
  ENV_FILE_MAP,
  ENV_FILE_OVERRIDES_HOST_ENV,
  findMonorepoRoot,
  getNodeEnv,
  isCI,
  planEnvFileLoad,
  shouldLoadEnvFile,
  type EnvFileLoadPlan,
  type Environment,
  type EnvSource,
  type PlanEnvFileLoadOptions,
} from './env-file-resolution';

// ============================================================================
// Types
// ============================================================================

export interface LoadEnvOptions {
  /** Explicit path to an env file (skips `NODE_ENV` -> file resolution). */
  envFilePath?: string;
  /** Enable debug logging. */
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
// Main
// ============================================================================

/**
 * Load environment variables from the env file selected by `NODE_ENV`.
 *
 * Safe to call more than once: because the file never overrides host env, a
 * second call cannot change a value that is already resolved.
 *
 * @example
 * ```typescript
 * loadEnv();                                      // NODE_ENV -> .env.dev / .env.test
 * loadEnv({ envFilePath: '/path/to/.env.custom' }); // explicit file
 * ```
 */
export function loadEnv(options: LoadEnvOptions = {}): LoadEnvResult {
  const { envFilePath: explicitPath, debug } = options;

  const plan = planEnvFileLoad(explicitPath === undefined ? {} : { envFilePath: explicitPath });

  const result: LoadEnvResult = {
    loaded: false,
    nodeEnv: plan.nodeEnv,
    isCI: plan.isCI,
  };

  if (!plan.envFilePath) {
    if (debug) {
      console.log(`[loadEnv] Not loading an env file: ${plan.reason ?? 'no candidate'}`);
    }
    // CI / production is the documented no-op path, not an error.
    if (plan.shouldLoad && plan.reason) {
      result.error = plan.reason;
    }
    return result;
  }

  if (debug) {
    console.log(`[loadEnv] Loading ${plan.envFilePath} (override: ${plan.override})`);
  }

  const dotenvResult = dotenv.config({ path: plan.envFilePath, override: plan.override });

  if (dotenvResult.error) {
    result.error = dotenvResult.error.message;
    return result;
  }

  result.loaded = true;
  result.envFilePath = plan.envFilePath;

  return result;
}

/**
 * Get the env file path for the current environment, or `null` when none
 * applies (CI, production, or the file does not exist).
 */
export function getEnvFilePath(): string | null {
  return planEnvFileLoad().envFilePath;
}
