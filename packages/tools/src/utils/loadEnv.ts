/**
 * Environment loading for the `@arcaai/tools` CLI generators.
 *
 * This module owns NO policy. The NODE_ENV -> file map, the CI/production skip
 * and the host-env-wins precedence are declared once in
 * `packages/applications/src/common/env/env-file-resolution` and imported here
 * by SOURCE PATH — `@arcaai/tools` must not gain a package dependency on
 * `@arcaai/applications`: this package's generators produce the code that
 * `@arcaai/domains` (and therefore `@arcaai/applications`) is built from, so a
 * package edge would close that loop. The imported module has no dependencies
 * beyond `node:fs` / `node:path`, so ts-node compiles it in place.
 */

import dotenv from 'dotenv';

import { planEnvFileLoad } from '../../../applications/src/common/env/env-file-resolution';

export { findMonorepoRoot } from '../../../applications/src/common/env/env-file-resolution';

/**
 * Load environment variables from the env file selected by NODE_ENV.
 *
 * Never overrides host environment variables, and reads nothing at all when
 * `CI=true` or `NODE_ENV=production`.
 */
export function loadToolsEnv(): { loaded: boolean; path?: string } {
  const plan = planEnvFileLoad();

  if (!plan.envFilePath) {
    return { loaded: false };
  }

  const result = dotenv.config({ path: plan.envFilePath, override: plan.override });
  if (result.error) {
    return { loaded: false };
  }

  return { loaded: true, path: plan.envFilePath };
}

// Auto-load when imported
loadToolsEnv();
