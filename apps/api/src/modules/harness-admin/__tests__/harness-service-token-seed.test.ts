/**
 * Regression guard — the apps/api <-> apps/harness shared
 * service-token MUST be provisioned for local dev.
 *
 * Root cause of the original 401 on `GET /api/v1/admin/harness/workflows`: the
 * Vault dev-init seed (`infrastructure/docker/configs/vault/dev-init.sh`) seeded
 * every other service token but OMITTED `HARNESS_SERVICE_TOKEN`. With
 * `SECRETS_PROVIDER=vault`, `HarnessOpsClient.buildHeaders()` then resolved
 * `undefined` (no Vault fallback to env) and sent an empty `X-Service-Token`,
 * which apps/harness's `require_service_token` rejects with 401.
 *
 * These assertions fail closed if the dev seed ever drops the harness token, or
 * if `apps/api/.env.sample` stops DECLARING the variable.
 *
 * TASK-558 lane D — the second assertion used to compare the seeded value with a
 * literal token committed in `apps/api/.env.sample`. That file is now generated
 * and carries placeholders only (plan §9.1 D3: "committed files contain no
 * secrets"), so the contract moved: `dev-init.sh` is the single source of the dev
 * token value, and the example file's job is to declare the KEY. Pinning a real
 * shared service token in a committed file is the posture lane A removed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../../../../..');
const DEV_INIT_SH = resolve(REPO_ROOT, 'infrastructure/docker/configs/vault/dev-init.sh');
const API_ENV_EXAMPLE = resolve(REPO_ROOT, 'apps/api/.env.sample');

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

  it('apps/api/.env.sample declares HARNESS_SERVICE_TOKEN as a placeholder, never a real token', () => {
    const documented = readEnvExampleValue(API_ENV_EXAMPLE, 'HARNESS_SERVICE_TOKEN');
    expect(documented, 'apps/api/.env.sample must document HARNESS_SERVICE_TOKEN — run `pnpm env:sync`').toBeTruthy();
    expect(documented, 'a committed example file must never carry a real service token').toBe('<CHANGE_ME>');
  });

  it('dev-init.sh, not a committed example file, owns the dev token value', () => {
    const sh = readFileSync(DEV_INIT_SH, 'utf8');
    const seeded = sh.match(/vault kv put\s+secret\/hope\/HARNESS_SERVICE_TOKEN\s+value="([^"]+)"/)?.[1];
    expect(seeded).toBeTruthy();
    expect(seeded).not.toBe('<CHANGE_ME>');
  });
});
