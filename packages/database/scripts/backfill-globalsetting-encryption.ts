// TASK-302 Phase 4 Task 4.7 (Stream B).
//
// Backfill: read all locked GlobalSetting rows whose `encryptedValue` is
// still null, encrypt their `value` via Vault Transit, write
// (encryptedValue, keyVersion) back. `value` is intentionally left
// untouched — Phase 4D removes plaintext under a separate user-gated
// SQL change after a one-release dual-read soak.
//
// Self-contained on purpose:
//   - Uses node-vault directly so the backfill does NOT pull
//     @arcaai/applications (which would create the workspace cycle
//     applications → database → applications).
//   - Uses @prisma/client (re-exported by @arcaai/database) for the row
//     reads/writes.
//
// Idempotency:
//   - The findMany filter excludes rows already encrypted
//     (encryptedValue IS NOT NULL), so re-running after a successful run
//     reports 0 rows.
//   - --dry-run never writes; safe to run unattended.
//
// Usage:
//   SECRETS_PROVIDER=vault \
//   VAULT_ADDR=http://localhost:8200 \
//   VAULT_ROLE_ID=$(docker exec hope-vault vault read -field=role_id auth/approle/role/hope-app/role-id) \
//   VAULT_WRAPPED_SECRET_ID=$(docker exec hope-vault vault write -wrap-ttl=60s -f -format=json auth/approle/role/hope-app/secret-id | jq -r .wrap_info.token) \
//     pnpm --filter @arcaai/database tsx scripts/backfill-globalsetting-encryption.ts \
//       --keys=JWT_SECRET_KEY,OIDC_CLIENT_SECRET,S3_ACCESS_KEY,S3_SECRET_KEY \
//       [--dry-run]
//
// Exit codes:
//   0 — success (or dry-run completed)
//   1 — runtime error (Vault transit error, DB error, etc)
//   2 — bad invocation (missing flags / wrong SECRETS_PROVIDER)

// eslint-disable-next-line no-restricted-imports -- TASK-305 B.4 allow-list: scripts/ legitimately bypass tenant-scope for back-fill / admin tasks
import { getPlatformAdminPrismaClient_Unscoped } from '../src/client.js';
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
import vault from 'node-vault';

export interface ParsedArgs {
  keys: string[];
  dryRun: boolean;
  transitMount: string;
  transitKey: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const map = new Map<string, string>();
  for (const a of argv.slice(2)) {
    const [k, v = ''] = a.replace(/^--/, '').split('=');
    map.set(k, v);
  }
  return {
    keys: (map.get('keys') ?? '').split(',').filter(Boolean),
    dryRun: map.has('dry-run'),
    transitMount: map.get('transit-mount') ?? 'transit',
    transitKey: map.get('transit-key') ?? 'hope-globalsetting',
  };
}

export function validateInvocation(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv,
): { ok: true } | { ok: false; code: number; message: string } {
  if (args.keys.length === 0) {
    return { ok: false, code: 2, message: '--keys=A,B,C required' };
  }
  if (env.SECRETS_PROVIDER !== 'vault') {
    return { ok: false, code: 2, message: 'SECRETS_PROVIDER=vault required' };
  }
  return { ok: true };
}

interface VaultClientLike {
  token?: string;
  unwrap(payload?: { token: string }): Promise<unknown>;
  approleLogin(opts: { role_id: string; secret_id: string }): Promise<unknown>;
  write(path: string, body: Record<string, unknown>): Promise<unknown>;
}

async function authenticateVaultClient(client: VaultClientLike): Promise<void> {
  const addr = process.env.VAULT_ADDR;
  const roleId = process.env.VAULT_ROLE_ID;
  const wrapped = process.env.VAULT_WRAPPED_SECRET_ID;
  const direct = process.env.VAULT_SECRET_ID;

  if (!addr || !roleId) {
    throw new Error('VAULT_ADDR and VAULT_ROLE_ID are required');
  }

  // Mirrors VaultSecretsProvider.boot(): unwrap a one-shot wrapped
  // secret_id when present; otherwise log in directly with secret_id.
  let secretId = direct;
  if (wrapped) {
    const savedToken = client.token;
    client.token = wrapped;
    try {
      const res = (await client.unwrap()) as { data?: { secret_id?: string } };
      const sid = res?.data?.secret_id;
      if (!sid) throw new Error('unwrap returned no secret_id');
      secretId = sid;
    } finally {
      client.token = savedToken;
    }
  }

  if (!secretId) {
    throw new Error(
      'No secret_id available: provide VAULT_WRAPPED_SECRET_ID (preferred) or VAULT_SECRET_ID',
    );
  }

  const login = (await client.approleLogin({
    role_id: roleId,
    secret_id: secretId,
  })) as { auth?: { client_token?: string } };
  const token = login?.auth?.client_token;
  if (!token) throw new Error('AppRole login did not return a client_token');
  client.token = token;
}

async function transitEncrypt(
  client: VaultClientLike,
  cfg: ParsedArgs,
  plaintext: string,
): Promise<{ ciphertext: string; keyVersion: number }> {
  const path = `${cfg.transitMount}/encrypt/${cfg.transitKey}`;
  const res = (await client.write(path, {
    plaintext: Buffer.from(plaintext, 'utf8').toString('base64'),
  })) as { data?: { ciphertext?: string; key_version?: number } };
  const ct = res?.data?.ciphertext;
  if (!ct) throw new Error('transit/encrypt returned empty ciphertext');
  const kv = res?.data?.key_version ?? 1;
  return { ciphertext: ct, keyVersion: kv };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  const ok = validateInvocation(args, process.env);
  if (!ok.ok) {
    console.error(ok.message);
    process.exit(ok.code);
  }

  const client = vault({ apiVersion: 'v1', endpoint: process.env.VAULT_ADDR }) as unknown as VaultClientLike;
  await authenticateVaultClient(client);

  const prisma = getPlatformAdminPrismaClient_Unscoped();
  try {
    const rows = await prisma.globalSetting.findMany({
      where: {
        locked: true,
        key: { in: args.keys },
        encryptedValue: null,
      },
    });
    console.log(`Found ${rows.length} row(s) to encrypt`);
    for (const row of rows) {
      const { ciphertext, keyVersion } = await transitEncrypt(client, args, row.value);
      const buf = Buffer.from(ciphertext, 'utf8');
      console.log(
        ` - ${row.tenantId ?? '(no-tenant)'}/${row.key}: ${row.value.length} bytes plaintext → ${ciphertext.length} bytes ciphertext (key v${keyVersion})`,
      );
      if (!args.dryRun) {
        await prisma.globalSetting.update({
          where: { id: row.id },
          data: { encryptedValue: buf, keyVersion },
        });
      }
    }
    console.log(args.dryRun ? 'DRY-RUN complete; no writes performed' : 'Backfill complete');
  } finally {
    await prisma.$disconnect();
  }
}

// Main-module guard so the unit tests can import parseArgs +
// validateInvocation without executing the backfill. Compares the
// resolved import.meta.url to argv[1] under the conventional ESM
// pattern. The check is intentionally loose because tsx normalizes
// paths slightly differently than `node --experimental-vm-modules`.
const invokedDirectly =
  typeof process.argv[1] === 'string' && /backfill-globalsetting-encryption/.test(process.argv[1]);

if (invokedDirectly) {
  main().catch((err) => {
    // Important: by default we log ONLY the error message — node-vault
    // sometimes embeds the response body (which can include ciphertext
    // or plaintext for the row being processed) in the error chain.
    // Print message + Prisma error code only.
    const e = err as Error & { code?: string; meta?: unknown };
    console.error(`backfill error: ${e.message}${e.code ? ` (code ${e.code})` : ''}`);
    // SRE diagnostic escape hatch: when explicitly opted in via
    // BACKFILL_DEBUG=1, print the full stack so prisma-side issues like
    // ECONNREFUSED, P2002, etc. surface without rerunning. The flag must
    // never be set in production logs because the stack can include the
    // raw findMany/update payload (which references ciphertext columns).
    if (process.env.BACKFILL_DEBUG === '1') console.error(err);
    process.exit(1);
  });
}
