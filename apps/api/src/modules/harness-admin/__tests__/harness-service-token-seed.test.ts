/**
 * Regression guard (TASK-330 Phase 6) — the apps/api <-> apps/harness shared
 * service-token MUST be provisioned for local dev.
 *
 * Root cause of the original 401 on `GET /api/v1/admin/harness/workflows`: the
 * Vault dev-init seed (`infrastructure/docker/configs/vault/dev-init.sh`) seeded
 * every other service token but OMITTED `HARNESS_SERVICE_TOKEN`. With
 * `SECRETS_PROVIDER=vault`, `HarnessOpsClient.buildHeaders()` then resolved
 * `undefined` (no Vault fallback to env) and sent an empty `X-Service-Token`,
 * which apps/harness's `require_service_token` rejects with 401.
 *
 * These assertions fail closed if the dev seed ever drops the harness token or
 * lets its value drift from the api-side `.env.example` (the documented shared
 * dev value that apps/harness/.env must also carry).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../../../../..');
const DEV_INIT_SH = resolve(REPO_ROOT, 'infrastructure/docker/configs/vault/dev-init.sh');
const API_ENV_EXAMPLE = resolve(REPO_ROOT, 'apps/api/.env.example');

/** Pull the value of an `X=...`-style assignment from an env(.example) file. */
function readEnvExampleValue(file: string, key: string): string | undefined {
  const src = readFileSync(file, 'utf8');
  const match = src.match(new RegExp(`^${key}=(.+)$`, 'm'));
  return match?.[1]?.trim();
}

describe('HARNESS_SERVICE_TOKEN dev provisioning', () => {
  it('dev-init.sh seeds secret/hope/HARNESS_SERVICE_TOKEN with a non-empty value', () => {
    const sh = readFileSync(DEV_INIT_SH, 'utf8');
    const seeded = sh.match(/vault kv put\s+secret\/hope\/HARNESS_SERVICE_TOKEN\s+value="([^"]+)"/);
    expect(seeded, 'dev-init.sh must seed secret/hope/HARNESS_SERVICE_TOKEN (else apps/api sends an empty X-Service-Token → harness 401)').not.toBeNull();
    expect(seeded?.[1]).toBeTruthy();
  });

  it('the seeded value matches apps/api/.env.example (the shared dev token contract)', () => {
    const sh = readFileSync(DEV_INIT_SH, 'utf8');
    const seeded = sh.match(/vault kv put\s+secret\/hope\/HARNESS_SERVICE_TOKEN\s+value="([^"]+)"/)?.[1];
    const documented = readEnvExampleValue(API_ENV_EXAMPLE, 'HARNESS_SERVICE_TOKEN');
    expect(documented, 'apps/api/.env.example must document HARNESS_SERVICE_TOKEN').toBeTruthy();
    expect(seeded).toBe(documented);
  });
});
