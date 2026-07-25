/**
 * Env-file resolution — the SINGLE declaration of HOPE's env-file contract.
 *
 * This module is deliberately **dependency-free** (node builtins only, no
 * `dotenv`, no NestJS, no workspace packages) so that it can be imported by
 * consumers that run *before* anything is built:
 *
 * | Consumer                                     | How it imports this file |
 * |----------------------------------------------|--------------------------|
 * | `packages/applications/src/common/env/index`  | relative (same package)  |
 * | `apps/api/src/main.ts`                        | `loadEnv` from `@arcaai/applications` |
 * | `prisma.config.ts` (root)                     | relative source path — the Prisma CLI transpiles it |
 * | `packages/database/prisma.config.ts`          | relative source path — same |
 * | `packages/tools/src/utils/loadEnv.ts`         | re-declares nothing; see that file |
 *
 * ## The contract
 *
 * 1. **Precedence — host env > env file > schema default.** The env file NEVER
 *    overwrites a variable already present in `process.env`; that is what
 *    {@link ENV_FILE_OVERRIDES_HOST_ENV} pins, and it is not configurable.
 *    (`dotenv`'s `override: false` is the mechanism.)
 * 2. **One file, selected by `NODE_ENV`** — see {@link ENV_FILE_MAP}. There is
 *    no `.env` fallback: the root `.env` is docker-compose interpolation input,
 *    not application configuration.
 * 3. **No file is read when `CI=true` or `NODE_ENV=production`** — deployed and
 *    CI processes are configured by host environment only.
 */

import fs from 'node:fs';
import path from 'node:path';

// ============================================================================
// Types
// ============================================================================

export type Environment = 'development' | 'test' | 'production' | 'staging';

/** A read-only view of an environment map (defaults to `process.env`). */
export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface PlanEnvFileLoadOptions {
  /** Explicit env file to use; skips `NODE_ENV` -> file resolution. */
  envFilePath?: string;
  /** Monorepo root to resolve against. Auto-detected when omitted. */
  rootDir?: string;
  /** Environment to read `NODE_ENV` / `CI` from. Defaults to `process.env`. */
  env?: EnvSource;
}

export interface EnvFileLoadPlan {
  /** Whether an env file may be read at all (false in CI / production). */
  shouldLoad: boolean;
  /** Resolved `NODE_ENV`, normalised to a known {@link Environment}. */
  nodeEnv: Environment;
  /** Whether the process is running in CI. */
  isCI: boolean;
  /** Absolute path of the file to read, or `null` when there is nothing to read. */
  envFilePath: string | null;
  /** Always `false` — host environment variables win. See {@link ENV_FILE_OVERRIDES_HOST_ENV}. */
  override: false;
  /** Human-readable explanation when `envFilePath` is `null`. */
  reason?: string;
}

// ============================================================================
// The contract, declared once
// ============================================================================

/** Maps `NODE_ENV` to the one env file that environment may read. */
export const ENV_FILE_MAP: Readonly<Record<Environment, string>> = Object.freeze({
  development: '.env.dev',
  test: '.env.test',
  production: '.env.production',
  staging: '.env.staging',
});

/**
 * Precedence marker: `false` means "host env > env file".
 *
 * This is a constant, not an option. Making it configurable is what let TS and
 * Python disagree about which value wins.
 */
export const ENV_FILE_OVERRIDES_HOST_ENV = false as const;

const KNOWN_ENVIRONMENTS: readonly Environment[] = ['development', 'test', 'production', 'staging'];

// ============================================================================
// Primitives
// ============================================================================

/** Whether the process is running in CI. */
export function isCI(env: EnvSource = process.env): boolean {
  return env['CI'] === 'true' || env['CI'] === '1';
}

/** Resolved `NODE_ENV`; anything unrecognised (or unset) means `development`. */
export function getNodeEnv(env: EnvSource = process.env): Environment {
  const value = env['NODE_ENV'] as Environment | undefined;
  return value && KNOWN_ENVIRONMENTS.includes(value) ? value : 'development';
}

/** Whether an env file may be read at all — false in CI and in production. */
export function shouldLoadEnvFile(env: EnvSource = process.env): boolean {
  return !isCI(env) && getNodeEnv(env) !== 'production';
}

/**
 * Walk up from `startDir` looking for the monorepo root
 * (`package.json` with `"name": "hope-monorepo"`).
 */
export function findMonorepoRoot(startDir: string = process.cwd()): string | null {
  let currentDir = startDir;
  const maxDepth = 10;

  for (let depth = 0; depth < maxDepth; depth++) {
    const packageJsonPath = path.join(currentDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { name?: string };
        if (pkg.name === 'hope-monorepo') {
          return currentDir;
        }
      } catch {
        // Unparseable package.json — keep walking.
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  return null;
}

// ============================================================================
// The one resolution routine
// ============================================================================

/**
 * Decide which env file (if any) this process should read.
 *
 * Callers do the actual reading, because the loader they have available
 * differs (`dotenv` in the app and CLI tools, Prisma's own loader in
 * `prisma.config.ts`). The DECISION is made here, once.
 */
export function planEnvFileLoad(options: PlanEnvFileLoadOptions = {}): EnvFileLoadPlan {
  const env = options.env ?? process.env;
  const nodeEnv = getNodeEnv(env);
  const ci = isCI(env);

  const plan: EnvFileLoadPlan = {
    shouldLoad: !ci && nodeEnv !== 'production',
    nodeEnv,
    isCI: ci,
    envFilePath: null,
    override: ENV_FILE_OVERRIDES_HOST_ENV,
  };

  if (!plan.shouldLoad) {
    plan.reason = ci ? 'CI=true — host environment only' : 'NODE_ENV=production — host environment only';
    return plan;
  }

  if (options.envFilePath) {
    if (fs.existsSync(options.envFilePath)) {
      plan.envFilePath = options.envFilePath;
    } else {
      plan.reason = `Env file not found: ${options.envFilePath}`;
    }
    return plan;
  }

  const rootDir = options.rootDir ?? findMonorepoRoot();
  if (!rootDir) {
    plan.reason = 'Could not find monorepo root';
    return plan;
  }

  const envFilePath = path.join(rootDir, ENV_FILE_MAP[nodeEnv]);
  if (fs.existsSync(envFilePath)) {
    plan.envFilePath = envFilePath;
  } else {
    // No `.env` fallback on purpose: the root `.env` is compose interpolation
    // input, not application configuration.
    plan.reason = `Env file not found: ${envFilePath}`;
  }

  return plan;
}
