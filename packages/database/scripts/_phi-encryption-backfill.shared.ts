// TASK-369 (Data Encryption Initiative) Phase 3C — shared backfill engine for
// the multi-field clinical-PHI models (ContextItemVersion, Highlight,
// NamedEntity, SummaryMeta, TranscriptionJob, GoldenCase, EvalRun, EvalScore,
// DnaWritingStyleReport, DnaWritingStyleVersion, KnowledgeChunk, Notification,
// PromptTemplate).
//
// Each per-model script is a thin wrapper that declares its Prisma delegate +
// the plaintext→ciphertext field map and calls `runMain(config)`. The engine
// mirrors backfill-contextitem-content-encryption.ts (the pilot) but is shared
// so the Vault-auth / transit-encrypt / batching boilerplate lives in ONE place
// instead of being copy-pasted ~150 lines per model.
//
// Self-contained on purpose (mirrors the pilot):
//   - Uses node-vault directly so the backfill does NOT pull
//     @arcaai/applications (which would create the workspace cycle
//     applications → database → applications).
//   - Uses the unscoped platform-admin Prisma client for cross-tenant reads.
//
// Idempotency + volume — CURSOR-based scan:
//   - The pilot filters `encryptedX: null AND plaintext: { not: null }` and
//     relies on each write flipping the single ciphertext column so the row
//     drops out. The multi-field models commonly have CONTENT-LESS rows (e.g.
//     a SummaryMeta with no citationsMap/guardrailDecisions, a QUEUED
//     TranscriptionJob with no resultText) and a JSON `{ not: null }` filter is
//     fragile, so this engine instead pages by `id` cursor over rows whose
//     shared `keyVersion` is still null. Forward progress is guaranteed by the
//     cursor (not by the write), so content-less rows never loop and a re-run
//     after success performs 0 writes and terminates.
//   - --dry-run never writes; it previews a single batch (up to --limit) and
//     reports.
//
// Usage (per-model script):
//   SECRETS_PROVIDER=vault \
//   VAULT_ADDR=http://localhost:8200 \
//   VAULT_ROLE_ID=$(docker exec hope-vault vault read -field=role_id auth/approle/role/hope-app/role-id) \
//   VAULT_WRAPPED_SECRET_ID=$(docker exec hope-vault vault write -wrap-ttl=60s -f -format=json auth/approle/role/hope-app/secret-id | jq -r .wrap_info.token) \
//     pnpm --filter @arcaai/database tsx scripts/backfill-<model>-encryption.ts \
//       [--tenant=<tenantId>] [--batch-size=200] [--limit=1000] [--dry-run]
//
// Exit codes:
//   0 — success (or dry-run completed)
//   1 — runtime error (Vault transit error, DB error, etc)
//   2 — bad invocation (wrong SECRETS_PROVIDER)

// eslint-disable-next-line no-restricted-imports -- TASK-305 B.4 allow-list: scripts/ legitimately bypass tenant-scope for back-fill / admin tasks
import { getPlatformAdminPrismaClient_Unscoped } from '../src/client.js';
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
import vault from 'node-vault';

/** One plaintext column and the `Bytes?` ciphertext column it encrypts into. */
export interface FieldSpec {
  plaintext: string;
  ciphertext: string;
  /** JSONB column — stringify before encrypting (mirrors encryptJsonToCiphertext). */
  json?: boolean;
}

/** Per-model backfill descriptor supplied by each thin wrapper script. */
export interface BackfillConfig {
  /** Substring used by the wrapper's invoked-directly guard + log lines. */
  scriptName: string;
  /** Prisma delegate name (camelCase model), e.g. `highlight`. */
  delegate: string;
  /** Human-readable model label for logs. */
  label: string;
  /** Plaintext→ciphertext field map (every populated field is encrypted). */
  fields: FieldSpec[];
  /** Shared Transit-key-version column. Defaults to `keyVersion`. */
  keyVersionColumn?: string;
}

export interface ParsedArgs {
  dryRun: boolean;
  transitMount: string;
  transitKey: string;
  batchSize: number;
  limit: number | null;
  tenantId: string | null;
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

/** Encrypt one plaintext (or JSON) value into a `vault:vN:..` ciphertext. */
export type EncryptFn = (plaintext: string) => Promise<{ ciphertext: string; keyVersion: number }>;

/**
 * Build the Prisma `update.data` for one row: encrypt every populated plaintext
 * field into its ciphertext column (JSON fields are stringified first, mirroring
 * the domain `encryptJsonToCiphertext`), and record the shared Transit key
 * version. Empty/null/undefined fields are skipped (no-op), so a partial row is
 * handled safely. PURE except for the injected `encrypt` — unit-tested with a
 * fake encryptor (no Vault / DB).
 */
export async function buildEncryptedData(
  row: Record<string, unknown>,
  fields: FieldSpec[],
  encrypt: EncryptFn,
  keyVersionColumn = 'keyVersion',
): Promise<{ data: Record<string, unknown>; encryptedFieldCount: number }> {
  const data: Record<string, unknown> = {};
  let keyVersion: number | null = null;

  for (const field of fields) {
    const raw = row[field.plaintext];
    if (raw === null || raw === undefined) continue;
    const plaintext = field.json ? JSON.stringify(raw) : String(raw);
    if (plaintext === '') continue;
    const { ciphertext, keyVersion: kv } = await encrypt(plaintext);
    data[field.ciphertext] = Buffer.from(ciphertext, 'utf8');
    keyVersion = kv;
  }

  const encryptedFieldCount = Object.keys(data).length;
  if (keyVersion !== null) data[keyVersionColumn] = keyVersion;
  return { data, encryptedFieldCount };
}

interface PrismaDelegateLike {
  findMany(args: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
  update(args: Record<string, unknown>): Promise<unknown>;
}

interface PrismaLike {
  [delegate: string]: unknown;
  $disconnect(): Promise<void>;
}

/**
 * Cursor-paged backfill loop. Pages over rows whose shared `keyVersion` is null,
 * encrypts populated fields, and writes the ciphertext back. Returns the number
 * of rows processed (scanned). See the module header for the idempotency model.
 */
export async function runBackfill(
  prisma: PrismaLike,
  client: VaultClientLike,
  args: ParsedArgs,
  config: BackfillConfig,
): Promise<{ processed: number; written: number }> {
  const keyVersionColumn = config.keyVersionColumn ?? 'keyVersion';
  const delegate = prisma[config.delegate] as unknown as PrismaDelegateLike;
  if (!delegate || typeof delegate.findMany !== 'function') {
    throw new Error(`Unknown Prisma delegate: ${config.delegate}`);
  }

  const where: Record<string, unknown> = { [keyVersionColumn]: null };
  if (args.tenantId) where.tenantId = args.tenantId;

  let processed = 0;
  let written = 0;
  let cursor: string | undefined;

  for (;;) {
    if (args.limit !== null && processed >= args.limit) break;
    const remainingCap = args.limit !== null ? args.limit - processed : args.batchSize;
    const take = Math.min(args.batchSize, remainingCap);

    const rows = await delegate.findMany({
      where,
      take,
      orderBy: { id: 'asc' },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      const { data, encryptedFieldCount } = await buildEncryptedData(
        row,
        config.fields,
        (pt) => transitEncrypt(client, args, pt),
        keyVersionColumn,
      );
      // Error-message-only logging: never print plaintext (PHI). Field counts +
      // the row id only.
      console.log(
        ` - ${(row.tenantId as string) ?? '(no-tenant)'}/${row.id as string}: ${encryptedFieldCount} field(s) → ciphertext (key v${(data[keyVersionColumn] as number) ?? '-'})`,
      );
      if (!args.dryRun && encryptedFieldCount > 0) {
        await delegate.update({ where: { id: row.id as string }, data });
        written++;
      }
      processed++;
    }

    cursor = rows[rows.length - 1].id as string;
    // Dry-run previews a single batch (the cursor would otherwise walk the whole
    // table doing transit/encrypt calls just to count).
    if (args.dryRun) break;
    if (rows.length < take) break;
  }

  return { processed, written };
}

export async function runMain(
  config: BackfillConfig,
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const args = parseArgs(argv);

  const ok = validateInvocation(args, env);
  if (!ok.ok) {
    console.error(ok.message);
    process.exit(ok.code);
  }

  const client = vault({ apiVersion: 'v1', endpoint: env.VAULT_ADDR }) as unknown as VaultClientLike;
  await authenticateVaultClient(client);

  const prisma = getPlatformAdminPrismaClient_Unscoped() as unknown as PrismaLike;
  try {
    const { processed, written } = await runBackfill(prisma, client, args, config);
    console.log(
      args.dryRun
        ? `DRY-RUN complete (${config.label}); ${processed} row(s) scanned; no writes performed`
        : `Backfill complete (${config.label}); scanned ${processed} row(s), encrypted ${written}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Wrapper used by each per-model script's invoked-directly guard. Logs ONLY the
 * error message by default — node-vault sometimes embeds the response body
 * (which can include plaintext/ciphertext) in the error chain. `BACKFILL_DEBUG=1`
 * prints the full stack (never set in production).
 */
export function runMainAsCli(config: BackfillConfig): void {
  runMain(config).catch((err) => {
    const e = err as Error & { code?: string; meta?: unknown };
    console.error(`backfill error: ${e.message}${e.code ? ` (code ${e.code})` : ''}`);
    if (process.env.BACKFILL_DEBUG === '1') console.error(err);
    process.exit(1);
  });
}
