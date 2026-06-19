// TASK-369 (Data Encryption Initiative) Phase 3B — backfill encryption for
// ContextItem.content (clinical free-text PHI).
//
// Reads ContextItem rows whose `encryptedContent` is still null AND that have
// non-null plaintext `content`, encrypts `content` via Vault Transit (the
// dedicated `hope-phi` key by default), and writes (encryptedContent,
// contentKeyVersion) back. `content` is intentionally left untouched — Phase 6
// removes plaintext under a separate user-gated SQL change after the dual-read
// soak.
//
// Self-contained on purpose (mirrors backfill-globalsetting-encryption.ts):
//   - Uses node-vault directly so the backfill does NOT pull
//     @arcaai/applications (which would create the workspace cycle
//     applications → database → applications).
//   - Uses the unscoped platform-admin Prisma client for cross-tenant reads.
//
// Idempotency + volume:
//   - The findMany filter excludes already-encrypted rows
//     (encryptedContent: null), so each batch naturally advances and a re-run
//     after success reports 0 rows. ContextItem is high-volume, so rows are
//     processed in batches (default 200) instead of loaded all at once.
//   - --dry-run never writes; it processes a single batch (up to --limit) and
//     reports, because without writes the null-filter would otherwise loop
//     forever on the same rows.
//
// Usage:
//   SECRETS_PROVIDER=vault \
//   VAULT_ADDR=http://localhost:8200 \
//   VAULT_ROLE_ID=$(docker exec hope-vault vault read -field=role_id auth/approle/role/hope-app/role-id) \
//   VAULT_WRAPPED_SECRET_ID=$(docker exec hope-vault vault write -wrap-ttl=60s -f -format=json auth/approle/role/hope-app/secret-id | jq -r .wrap_info.token) \
//     pnpm --filter @arcaai/database tsx scripts/backfill-contextitem-content-encryption.ts \
//       [--type=WORKNOTE] [--tenant=<tenantId>] [--batch-size=200] [--limit=1000] [--dry-run]
//
// Exit codes:
//   0 — success (or dry-run completed)
//   1 — runtime error (Vault transit error, DB error, etc)
//   2 — bad invocation (wrong SECRETS_PROVIDER)

// eslint-disable-next-line no-restricted-imports -- TASK-305 B.4 allow-list: scripts/ legitimately bypass tenant-scope for back-fill / admin tasks
import { getPlatformAdminPrismaClient_Unscoped } from '../src/client.js';
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
import vault from 'node-vault';

export interface ParsedArgs {
  dryRun: boolean;
  transitMount: string;
  transitKey: string;
  batchSize: number;
  limit: number | null;
  tenantId: string | null;
  type: string | null;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const map = new Map<string, string>();
  for (const a of argv.slice(2)) {
    const [k, v = ''] = a.replace(/^--/, '').split('=');
    map.set(k, v);
  }
  const batchSize = parseInt(map.get('batch-size') ?? '200', 10);
  const rawLimit = map.get('limit');
  const limit = rawLimit ? parseInt(rawLimit, 10) : null;
  return {
    dryRun: map.has('dry-run'),
    transitMount: map.get('transit-mount') ?? 'transit',
    transitKey: map.get('transit-key') ?? 'hope-phi',
    batchSize: Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 200,
    limit: limit !== null && Number.isFinite(limit) && limit > 0 ? limit : null,
    tenantId: map.get('tenant') || null,
    type: map.get('type') || null,
  };
}

export function validateInvocation(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv,
): { ok: true } | { ok: false; code: number; message: string } {
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

  // Mirrors VaultSecretsProvider.boot(): unwrap a one-shot wrapped secret_id
  // when present; otherwise log in directly with secret_id.
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
    throw new Error('No secret_id available: provide VAULT_WRAPPED_SECRET_ID (preferred) or VAULT_SECRET_ID');
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
  // Only rows that still need encryption: no ciphertext yet AND have plaintext.
  const where: Record<string, unknown> = {
    encryptedContent: null,
    content: { not: null },
  };
  if (args.tenantId) where.tenantId = args.tenantId;
  if (args.type) where.type = args.type;

  let totalProcessed = 0;
  try {
    for (;;) {
      if (args.limit !== null && totalProcessed >= args.limit) break;
      const remainingCap = args.limit !== null ? args.limit - totalProcessed : args.batchSize;
      const take = Math.min(args.batchSize, remainingCap);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = (await prisma.contextItem.findMany({ where: where as any, take })) as Array<{
        id: string;
        tenantId: string | null;
        content: string | null;
      }>;
      if (rows.length === 0) break;

      for (const row of rows) {
        if (row.content === null) continue;
        const { ciphertext, keyVersion } = await transitEncrypt(client, args, row.content);
        // Error-message-only logging: never print `content` (PHI). Lengths only.
        console.log(
          ` - ${row.tenantId ?? '(no-tenant)'}/${row.id}: ${row.content.length} chars plaintext → ${ciphertext.length} bytes ciphertext (key v${keyVersion})`,
        );
        if (!args.dryRun) {
          await prisma.contextItem.update({
            where: { id: row.id },
            data: { encryptedContent: Buffer.from(ciphertext, 'utf8'), contentKeyVersion: keyVersion },
          });
        }
        totalProcessed++;
      }

      // Dry-run never mutates, so the null-filter would re-return the same rows
      // forever — process a single batch and stop. A real run advances because
      // each row's encryptedContent becomes non-null.
      if (args.dryRun) break;
      if (rows.length < take) break;
    }
    console.log(
      args.dryRun
        ? `DRY-RUN complete; ${totalProcessed} row(s) would be encrypted; no writes performed`
        : `Backfill complete; encrypted ${totalProcessed} row(s)`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// Main-module guard so unit tests can import parseArgs + validateInvocation
// without executing the backfill.
const invokedDirectly =
  typeof process.argv[1] === 'string' && /backfill-contextitem-content-encryption/.test(process.argv[1]);

if (invokedDirectly) {
  main().catch((err) => {
    // Log ONLY the error message by default — node-vault sometimes embeds the
    // response body (which can include plaintext/ciphertext for the row being
    // processed) in the error chain. Print message + Prisma error code only.
    const e = err as Error & { code?: string; meta?: unknown };
    console.error(`backfill error: ${e.message}${e.code ? ` (code ${e.code})` : ''}`);
    // SRE diagnostic escape hatch: BACKFILL_DEBUG=1 prints the full stack.
    // Never set in production — the stack can include the row payload.
    if (process.env.BACKFILL_DEBUG === '1') console.error(err);
    process.exit(1);
  });
}
