// Vault DB-engine smoke script — issues a dynamic PostgreSQL credential
// from Vault, opens a PrismaClient against it, runs `SELECT 1`, and
// reports the dynamic username + lease TTL.
//
// Intended for STAGING. Not unit-tested as an end-to-end script; the
// pure argument parser is covered by `__tests__/vault-db-smoke.test.ts`
// to keep the test surface small and CI-safe (no live Vault required).
//
// Self-contained on purpose:
//   - Imports `VaultPrismaClient` (and `getPrismaClientWithVault` for
//     completeness) from the SOURCE tree (`../src/vault-client.js`) so
//     the script does not require a compiled `dist/`. The plan's
//     example uses `@arcaai/applications` SecretsService, but to dodge
//     the workspace cycle (applications → database → applications) the
//     script speaks directly to a minimal Vault provider: node-vault
//     + AppRole login + `database/creds/<role>` read.
//   - This mirrors the backfill script's self-contained pattern from
//     Phase 4 (see backfill-globalsetting-encryption.ts header).
//
// Usage (against the staging dev-mode container or the staging Vault):
//   SECRETS_PROVIDER=vault \
//   VAULT_ADDR=http://localhost:8200 \
//   VAULT_ROLE_ID=$(docker exec hope-vault vault read -field=role_id auth/approle/role/hope-app/role-id) \
//   VAULT_WRAPPED_SECRET_ID=$(docker exec hope-vault vault write -wrap-ttl=60s -f -format=json auth/approle/role/hope-app/secret-id | jq -r .wrap_info.token) \
//   PG_HOST=localhost PG_PORT=5432 PG_DATABASE=hope_main \
//     pnpm --filter @arcaai/database exec tsx scripts/vault-db-smoke.ts \
//       [--role=hope-app-role]
//
// Exit codes:
//   0 — success (one SELECT 1 round-trip with dynamic creds)
//   1 — runtime error (Vault unreachable, DB connect failure, etc.)
//   2 — bad invocation (missing required env)

import { VaultPrismaClient } from '../src/vault-client.js';
import vault from 'node-vault';

export interface SmokeArgs {
  role: string;
}

export function parseArgs(argv: string[]): SmokeArgs {
  const map = new Map<string, string>();
  for (const a of argv.slice(2)) {
    const [k, v = ''] = a.replace(/^--/, '').split('=');
    map.set(k, v);
  }
  return { role: map.get('role') ?? 'hope-app-role' };
}

interface MinimalVaultClient {
  token: string;
  read(path: string): Promise<unknown>;
  approleLogin(opts: { role_id: string; secret_id: string }): Promise<{
    auth: { client_token: string };
  }>;
  unwrap(): Promise<{ data: Record<string, unknown> }>;
}

interface DbCred {
  username: string;
  password: string;
  leaseId: string;
  ttlSec: number;
}

/**
 * Tiny SecretsLike implementation that speaks Vault directly. Avoids
 * the workspace cycle that would land if we imported
 * `@arcaai/applications`'s SecretsService into a script that lives in
 * `@arcaai/database`.
 */
async function buildVaultSecrets(): Promise<{ requestDbCredential: (role: string) => Promise<DbCred> }> {
  const addr = process.env.VAULT_ADDR;
  const roleId = process.env.VAULT_ROLE_ID;
  const wrapped = process.env.VAULT_WRAPPED_SECRET_ID;
  const rawSecretId = process.env.VAULT_SECRET_ID;
  if (!addr || !roleId) {
    throw new Error('vault-db-smoke: VAULT_ADDR and VAULT_ROLE_ID are required');
  }
  if (!wrapped && !rawSecretId) {
    throw new Error('vault-db-smoke: either VAULT_WRAPPED_SECRET_ID or VAULT_SECRET_ID is required');
  }
  const client = vault({
    apiVersion: 'v1',
    endpoint: addr,
  }) as unknown as MinimalVaultClient;

  let secretId = rawSecretId;
  if (wrapped) {
    const prev = client.token;
    client.token = wrapped;
    try {
      const unwrapped = await client.unwrap();
      secretId = (unwrapped?.data as { secret_id?: string }).secret_id;
    } finally {
      client.token = prev;
    }
  }
  if (!secretId) {
    throw new Error('vault-db-smoke: no secret_id available after unwrap');
  }
  const login = await client.approleLogin({ role_id: roleId, secret_id: secretId });
  client.token = login.auth.client_token;

  return {
    requestDbCredential: async (role: string): Promise<DbCred> => {
      const res = (await client.read(`database/creds/${role}`)) as {
        lease_id: string;
        lease_duration: number;
        data: { username: string; password: string };
      };
      if (!res?.data?.username || !res?.data?.password) {
        throw new Error('vault-db-smoke: empty creds from database engine');
      }
      return {
        username: res.data.username,
        password: res.data.password,
        leaseId: res.lease_id,
        ttlSec: res.lease_duration,
      };
    },
  };
}

async function main(): Promise<void> {
  if (process.env.SECRETS_PROVIDER !== 'vault') {
    console.error('vault-db-smoke: SECRETS_PROVIDER must be set to "vault"');
    process.exit(2);
  }
  const args = parseArgs(process.argv);
  console.log(`vault-db-smoke: connecting to Vault at ${process.env.VAULT_ADDR}`);

  const secrets = await buildVaultSecrets();
  const wrapper = await VaultPrismaClient.create(secrets, args.role);

  // Only opaque metadata is logged. The dynamic username is omitted
  // entirely (Vault encodes role + lease-id-prefix into it, which is
  // residency-sensitive in audit pipelines), and the password is
  // hidden behind VaultPrismaClient's private `current` field.
  console.log(`vault-db-smoke: dynamic creds issued (ttl=${wrapper.ttlSec}s)`);
  console.log(`vault-db-smoke: lease=${wrapper.leaseId.slice(0, 24)}…`);

  const rows = (await wrapper.client.$queryRaw`SELECT 1 AS ok`) as Array<{ ok: number }>;
  if (!rows || rows[0]?.ok !== 1) {
    throw new Error(`vault-db-smoke: SELECT 1 returned unexpected result: ${JSON.stringify(rows)}`);
  }
  console.log('vault-db-smoke: SELECT 1 → ok');

  await wrapper.disconnect();
  console.log('vault-db-smoke: disconnected cleanly');
}

const isCli =
  typeof import.meta.url === 'string' &&
  import.meta.url === `file://${process.argv[1]}`;
if (isCli) {
  main().catch((e) => {
    console.error(`vault-db-smoke: ${(e as Error).message}`);
    process.exit(1);
  });
}
