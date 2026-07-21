// READ-ONLY decrypt CLI.
//
// An admin/dev tool to decrypt a single row's encrypted PHI field(s) for
// support / debugging, WITHOUT going through the running API. It loads the row
// via the unscoped platform-admin Prisma client (bypasses tenant-scope +
// soft-delete, like the deleted backfill scripts) and decrypts the `encrypted*`
// columns via Vault Transit (`hope-phi`):
//
//   - Per-field models (ContextItem, NamedEntity, SummaryMeta, …): each
//     `encrypted<Field>` Bytes column holds the utf8 of a `vault:vN:..`
//     ciphertext; transit/decrypt → plaintext (JSON-parsed for JSONB fields).
//   - AuditLog: ENVELOPE encryption — unwrap the row's `dekWrapped` DEK via
//     transit/decrypt, then locally AES-256-GCM-decrypt `encryptedData` /
//     `encryptedPreviousData` (mirrors CryptoService + AuditLogEncryptionService).
//
// Self-contained on purpose (mirrors the former backfill scripts): uses
// `node-vault` directly + the unscoped Prisma client so this `packages/database`
// script never imports `@arcaai/applications` / `@arcaai/domains` (which would
// create a workspace cycle).
//
// STRICTLY READ-ONLY: only `findUnique` is ever called — no create/update/delete.
// Error-message-only logging: ciphertext / DEK / secrets are NEVER printed (set
// DECRYPT_DEBUG=1 for a full stack — never in production).
//
// Usage:
//   SECRETS_PROVIDER=vault \
//   VAULT_ADDR=http://localhost:8200 \
//   VAULT_ROLE_ID=$(docker exec hope-vault vault read -field=role_id auth/approle/role/hope-app/role-id) \
//   VAULT_WRAPPED_SECRET_ID=$(docker exec hope-vault vault write -wrap-ttl=60s -f -format=json auth/approle/role/hope-app/secret-id | jq -r .wrap_info.token) \
//     pnpm --filter @arcaai/database decrypt:row -- --model <ModelName> --id <rowId> [--field <name>] [--json]
//
// Exit codes:
//   0 — success (or --help)
//   1 — runtime error (Vault transit error, DB error, row not found, etc)
//   2 — bad invocation (missing/unknown args, wrong SECRETS_PROVIDER)

import * as crypto from 'crypto';
// eslint-disable-next-line no-restricted-imports -- allow-list: scripts/ legitimately bypass tenant-scope for read-only admin tasks
import { getPlatformAdminPrismaClient_Unscoped } from '../src/client.js';
import vault from 'node-vault';

/** One plaintext column and the `Bytes?` ciphertext column it is encrypted into. */
export interface FieldSpec {
  plaintext: string;
  ciphertext: string;
  /** JSONB column — the decrypted plaintext is a JSON string to parse. */
  json?: boolean;
}

/** Per-model decrypt descriptor: the Prisma delegate + its encrypted fields. */
export interface ModelSpec {
  delegate: string;
  fields: FieldSpec[];
}

/**
 * Per-field PHI models + their encrypted columns — the inverse of the (now
 * deleted) backfill field maps. AuditLog is intentionally absent here: it uses
 * DEK-envelope encryption and is handled by {@link decryptAuditLogRow}.
 * GlobalSetting is also excluded — it is non-PHI secrets under a different
 * Transit key (`hope-globalsetting`), out of scope for this PHI decrypt tool.
 */
export const MODEL_REGISTRY: Record<string, ModelSpec> = {
  ContextItem: { delegate: 'contextItem', fields: [{ plaintext: 'content', ciphertext: 'encryptedContent' }] },
  ContextItemVersion: {
    delegate: 'contextItemVersion',
    fields: [
      { plaintext: 'content', ciphertext: 'encryptedContent' },
      { plaintext: 'contentDiff', ciphertext: 'encryptedContentDiff' },
      { plaintext: 'changeSummary', ciphertext: 'encryptedChangeSummary' },
      { plaintext: 'fieldChanges', ciphertext: 'encryptedFieldChanges', json: true },
    ],
  },
  NamedEntity: {
    delegate: 'namedEntity',
    fields: [
      { plaintext: 'text', ciphertext: 'encryptedText' },
      { plaintext: 'normalizedText', ciphertext: 'encryptedNormalizedText' },
      { plaintext: 'metadata', ciphertext: 'encryptedMetadata', json: true },
    ],
  },
  SummaryMeta: {
    delegate: 'summaryMeta',
    fields: [
      { plaintext: 'citationsMap', ciphertext: 'encryptedCitationsMap', json: true },
      { plaintext: 'guardrailDecisions', ciphertext: 'encryptedGuardrailDecisions', json: true },
    ],
  },
  Highlight: {
    delegate: 'highlight',
    fields: [
      { plaintext: 'exact', ciphertext: 'encryptedExact' },
      { plaintext: 'prefix', ciphertext: 'encryptedPrefix' },
      { plaintext: 'suffix', ciphertext: 'encryptedSuffix' },
      { plaintext: 'note', ciphertext: 'encryptedNote' },
    ],
  },
  TranscriptionJob: {
    delegate: 'transcriptionJob',
    fields: [
      { plaintext: 'resultText', ciphertext: 'encryptedResultText' },
      { plaintext: 'resultMetadata', ciphertext: 'encryptedResultMetadata', json: true },
    ],
  },
  GoldenCase: {
    delegate: 'goldenCase',
    fields: [
      { plaintext: 'transcript', ciphertext: 'encryptedTranscript' },
      { plaintext: 'referenceNote', ciphertext: 'encryptedReferenceNote' },
    ],
  },
  EvalRun: { delegate: 'evalRun', fields: [{ plaintext: 'notes', ciphertext: 'encryptedNotes' }] },
  EvalScore: {
    delegate: 'evalScore',
    fields: [
      { plaintext: 'rationale', ciphertext: 'encryptedRationale' },
      { plaintext: 'details', ciphertext: 'encryptedDetails', json: true },
    ],
  },
  DnaWritingStyleReport: {
    delegate: 'dnaWritingStyleReport',
    fields: [
      { plaintext: 'reportData', ciphertext: 'encryptedReportData', json: true },
      { plaintext: 'styleText', ciphertext: 'encryptedStyleText' },
    ],
  },
  DnaWritingStyleVersion: {
    delegate: 'dnaWritingStyleVersion',
    fields: [
      { plaintext: 'reportData', ciphertext: 'encryptedReportData', json: true },
      { plaintext: 'styleText', ciphertext: 'encryptedStyleText' },
    ],
  },
  KnowledgeChunk: { delegate: 'knowledgeChunk', fields: [{ plaintext: 'text', ciphertext: 'encryptedText' }] },
  Notification: {
    delegate: 'notification',
    fields: [
      { plaintext: 'messageText', ciphertext: 'encryptedMessageText' },
      { plaintext: 'messageRichText', ciphertext: 'encryptedMessageRichText' },
      { plaintext: 'messageContent', ciphertext: 'encryptedMessageContent', json: true },
    ],
  },
  PromptTemplate: { delegate: 'promptTemplate', fields: [{ plaintext: 'lastTestOutput', ciphertext: 'encryptedLastTestOutput' }] },
};

/** AuditLog's two enveloped JSONB payloads (plaintext-column name → ciphertext column). */
export const AUDITLOG_FIELDS: Record<string, string> = {
  data: 'encryptedData',
  previousData: 'encryptedPreviousData',
};

export interface ParsedArgs {
  help: boolean;
  json: boolean;
  model: string | null;
  id: string | null;
  field: string | null;
  transitMount: string;
  transitKey: string;
}

/**
 * Parse `--k=v`, `--k v`, and boolean `--flag` forms. PURE — unit-tested.
 * Unknown values default to the PHI Transit key / `transit` mount.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const map = new Map<string, string>();
  const tokens = argv.slice(2);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.startsWith('--')) continue;
    const body = tok.replace(/^--/, '');
    if (body.includes('=')) {
      const [k, v = ''] = body.split('=');
      map.set(k, v);
      continue;
    }
    const next = tokens[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      map.set(body, next);
      i++;
    } else {
      map.set(body, '');
    }
  }
  return {
    help: map.has('help') || map.has('h'),
    json: map.has('json'),
    model: map.get('model') || null,
    id: map.get('id') || null,
    field: map.get('field') || null,
    transitMount: map.get('transit-mount') || 'transit',
    transitKey: map.get('transit-key') || 'hope-phi',
  };
}

/** Resolve a model name (case-insensitive) to its canonical registry key, or `AuditLog`. */
export function resolveModelKey(model: string): string | null {
  if (model === 'AuditLog' || MODEL_REGISTRY[model]) return model === 'AuditLog' ? 'AuditLog' : model;
  const lower = model.toLowerCase();
  if (lower === 'auditlog') return 'AuditLog';
  return Object.keys(MODEL_REGISTRY).find((k) => k.toLowerCase() === lower) ?? null;
}

export function knownModelNames(): string[] {
  return ['AuditLog', ...Object.keys(MODEL_REGISTRY)].sort();
}

export function validateInvocation(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv,
): { ok: true } | { ok: false; code: number; message: string } {
  if (env.SECRETS_PROVIDER !== 'vault') {
    return { ok: false, code: 2, message: 'SECRETS_PROVIDER=vault is required (this tool decrypts real PHI via Vault Transit).' };
  }
  if (!args.model) return { ok: false, code: 2, message: '--model <ModelName> is required (see --help).' };
  if (!args.id) return { ok: false, code: 2, message: '--id <rowId> is required (see --help).' };
  if (resolveModelKey(args.model) === null) {
    return { ok: false, code: 2, message: `Unknown --model "${args.model}". Known models: ${knownModelNames().join(', ')}` };
  }
  return { ok: true };
}

// ───────────────────────────── decrypt primitives ─────────────────────────────

/** transit/decrypt → plaintext Buffer. Injected into the pure helpers for testing. */
export type DecryptFn = (ciphertext: string) => Promise<Buffer>;

export interface DecryptedField {
  field: string;
  /** ciphertext = decrypted from the encrypted column; plaintext-fallback = dual-read soak; absent = both null. */
  source: 'ciphertext' | 'plaintext-fallback' | 'absent';
  value: unknown;
}

/**
 * Decrypt one per-field ciphertext column, falling back to the retained
 * plaintext column (dual-read soak) when the ciphertext is null. PURE.
 */
export async function decryptField(
  row: Record<string, unknown>,
  spec: FieldSpec,
  decrypt: DecryptFn,
): Promise<DecryptedField> {
  const ctRaw = row[spec.ciphertext] as Buffer | Uint8Array | null | undefined;
  if (ctRaw && ctRaw.length > 0) {
    const ct = Buffer.from(ctRaw).toString('utf8');
    const pt = (await decrypt(ct)).toString('utf8');
    return { field: spec.plaintext, source: 'ciphertext', value: spec.json ? JSON.parse(pt) : pt };
  }
  const plain = row[spec.plaintext];
  if (plain !== null && plain !== undefined) {
    return { field: spec.plaintext, source: 'plaintext-fallback', value: plain };
  }
  return { field: spec.plaintext, source: 'absent', value: null };
}

/** Select + decrypt the requested per-field model columns (all, or one `--field`). PURE. */
export async function decryptModelRow(
  row: Record<string, unknown>,
  specs: FieldSpec[],
  fieldFilter: string | null,
  decrypt: DecryptFn,
): Promise<DecryptedField[]> {
  const selected = fieldFilter ? specs.filter((s) => s.plaintext === fieldFilter || s.ciphertext === fieldFilter) : specs;
  if (fieldFilter && selected.length === 0) {
    throw new Error(`Unknown --field "${fieldFilter}". Fields for this model: ${specs.map((s) => s.plaintext).join(', ')}`);
  }
  const out: DecryptedField[] = [];
  for (const spec of selected) out.push(await decryptField(row, spec, decrypt));
  return out;
}

/**
 * Locally decrypt an AuditLog envelope payload with the unwrapped DEK key.
 * Mirrors CryptoService.decrypt: authenticated AES-256-GCM (`gcm:v1:` prefix),
 * with legacy AES-256-CBC kept for backward compatibility. PURE (no Vault/DB).
 */
export function decryptLocalPayload(encryptedData: string, key: string): string {
  const GCM_PREFIX = 'gcm:v1:';
  if (encryptedData.startsWith(GCM_PREFIX)) {
    const [ivHex, authTagHex, ciphertextHex] = encryptedData.slice(GCM_PREFIX.length).split(':');
    if (ivHex === undefined || authTagHex === undefined || ciphertextHex === undefined) {
      throw new Error('Invalid GCM ciphertext format');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]).toString('utf8');
  }
  const [ivHex, encryptedHex] = encryptedData.split(':');
  if (!ivHex || !encryptedHex) throw new Error('Invalid ciphertext format');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key), Buffer.from(ivHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedHex, 'hex')), decipher.final()]).toString('utf8');
}

/**
 * Decrypt an AuditLog row's enveloped `data` / `previousData`: unwrap the row's
 * `dekWrapped` DEK once (via the injected `unwrap` = transit/decrypt), then
 * locally decrypt each requested payload. Falls back to the retained plaintext
 * JSONB columns for legacy rows (no ciphertext). PURE (deps injected).
 */
export async function decryptAuditLogRow(
  row: Record<string, unknown>,
  fieldFilter: string | null,
  unwrap: DecryptFn,
  localDecrypt: (encryptedData: string, key: string) => string,
): Promise<DecryptedField[]> {
  const fields = fieldFilter ? [fieldFilter] : Object.keys(AUDITLOG_FIELDS);
  for (const f of fields) {
    if (!(f in AUDITLOG_FIELDS)) {
      throw new Error(`Unknown --field "${f}" for AuditLog. Fields: ${Object.keys(AUDITLOG_FIELDS).join(', ')}`);
    }
  }

  const wrapped = row['dekWrapped'] as string | null | undefined;
  let dekKey: string | null = null; // unwrapped once, lazily, then reused.

  const out: DecryptedField[] = [];
  for (const f of fields) {
    const ctRaw = row[AUDITLOG_FIELDS[f]] as Buffer | Uint8Array | null | undefined;
    if (ctRaw && ctRaw.length > 0) {
      if (!wrapped) throw new Error(`AuditLog row has ${AUDITLOG_FIELDS[f]} but no dekWrapped — cannot decrypt.`);
      if (dekKey === null) dekKey = (await unwrap(wrapped)).toString('utf8');
      out.push({ field: f, source: 'ciphertext', value: JSON.parse(localDecrypt(Buffer.from(ctRaw).toString('utf8'), dekKey)) });
    } else {
      const plain = row[f];
      out.push(plain !== null && plain !== undefined ? { field: f, source: 'plaintext-fallback', value: plain } : { field: f, source: 'absent', value: null });
    }
  }
  return out;
}

// ───────────────────────────── Vault (node-vault) ─────────────────────────────

interface VaultClientLike {
  token?: string;
  unwrap(payload?: { token: string }): Promise<unknown>;
  approleLogin(opts: { role_id: string; secret_id: string }): Promise<unknown>;
  write(path: string, body: Record<string, unknown>): Promise<unknown>;
}

/** Mirrors VaultSecretsProvider.boot(): unwrap a wrapped secret_id, then AppRole login. */
async function authenticateVaultClient(client: VaultClientLike): Promise<void> {
  const addr = process.env.VAULT_ADDR;
  const roleId = process.env.VAULT_ROLE_ID;
  const wrapped = process.env.VAULT_WRAPPED_SECRET_ID;
  const direct = process.env.VAULT_SECRET_ID;

  if (!addr || !roleId) throw new Error('VAULT_ADDR and VAULT_ROLE_ID are required');

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

  const login = (await client.approleLogin({ role_id: roleId, secret_id: secretId })) as { auth?: { client_token?: string } };
  const token = login?.auth?.client_token;
  if (!token) throw new Error('AppRole login did not return a client_token');
  client.token = token;
}

/** transit/decrypt a `vault:vN:..` ciphertext → the original plaintext Buffer. */
async function transitDecrypt(client: VaultClientLike, args: ParsedArgs, ciphertext: string): Promise<Buffer> {
  const res = (await client.write(`${args.transitMount}/decrypt/${args.transitKey}`, { ciphertext })) as {
    data?: { plaintext?: string };
  };
  const b64 = res?.data?.plaintext;
  if (b64 === undefined || b64 === null) throw new Error('transit/decrypt returned empty plaintext');
  return Buffer.from(b64, 'base64');
}

// ───────────────────────────────── output ─────────────────────────────────

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** stdout = the plaintext / JSON values ONLY. Source notes go to stderr. */
function printResults(model: string, id: string, results: DecryptedField[], asJson: boolean): void {
  for (const r of results) {
    if (r.source !== 'ciphertext') {
      console.error(` (note) ${r.field}: ${r.source === 'plaintext-fallback' ? 'no ciphertext — plaintext-column fallback (dual-read soak)' : 'empty (no ciphertext, no plaintext)'}`);
    }
  }
  if (asJson) {
    const fields: Record<string, unknown> = {};
    for (const r of results) fields[r.field] = r.value;
    console.log(JSON.stringify({ model, id, fields }, null, 2));
    return;
  }
  if (results.length === 1) {
    console.log(stringifyValue(results[0].value));
    return;
  }
  for (const r of results) console.log(`${r.field}: ${stringifyValue(r.value)}`);
}

function printUsage(): void {
  console.log(
    [
      'decrypt-row — READ-ONLY admin/dev tool to decrypt a row\'s encrypted PHI field(s).',
      '',
      'Usage:',
      '  pnpm --filter @arcaai/database decrypt:row -- --model <ModelName> --id <rowId> [--field <name>] [--json]',
      '',
      'Required env:',
      '  SECRETS_PROVIDER=vault   VAULT_ADDR   VAULT_ROLE_ID',
      '  VAULT_WRAPPED_SECRET_ID (preferred) or VAULT_SECRET_ID',
      '',
      'Options:',
      '  --model   Model name (case-insensitive). One of:',
      `            ${knownModelNames().join(', ')}`,
      '  --id      Row id (uuid).',
      '  --field   Decrypt only this field (default: all encrypted fields).',
      '            AuditLog fields: data, previousData.',
      '  --json    Emit { model, id, fields } as JSON to stdout.',
      '  --help    Show this help.',
      '',
      'Read-only: only findUnique is called. Ciphertext/secrets are never printed',
      '(set DECRYPT_DEBUG=1 for a full stack — never in production).',
    ].join('\n'),
  );
}

// ───────────────────────────────── main ─────────────────────────────────

interface PrismaDelegateLike {
  findUnique(args: { where: { id: string } }): Promise<Record<string, unknown> | null>;
}
interface PrismaLike {
  [delegate: string]: unknown;
  $disconnect(): Promise<void>;
}

export async function main(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    printUsage();
    return;
  }

  const ok = validateInvocation(args, env);
  if (!ok.ok) {
    console.error(ok.message);
    process.exitCode = ok.code;
    return;
  }

  const modelKey = resolveModelKey(args.model!)!;

  const client = vault({ apiVersion: 'v1', endpoint: env.VAULT_ADDR }) as unknown as VaultClientLike;
  await authenticateVaultClient(client);
  const decrypt: DecryptFn = (ct) => transitDecrypt(client, args, ct);

  const prisma = getPlatformAdminPrismaClient_Unscoped() as unknown as PrismaLike;
  try {
    if (modelKey === 'AuditLog') {
      const row = await (prisma.auditLog as PrismaDelegateLike).findUnique({ where: { id: args.id! } });
      if (!row) throw new Error(`AuditLog row not found: ${args.id}`);
      const results = await decryptAuditLogRow(row, args.field, decrypt, decryptLocalPayload);
      printResults(modelKey, args.id!, results, args.json);
    } else {
      const spec = MODEL_REGISTRY[modelKey];
      const row = await (prisma[spec.delegate] as PrismaDelegateLike).findUnique({ where: { id: args.id! } });
      if (!row) throw new Error(`${modelKey} row not found: ${args.id}`);
      const results = await decryptModelRow(row, spec.fields, args.field, decrypt);
      printResults(modelKey, args.id!, results, args.json);
    }
  } finally {
    await prisma.$disconnect();
  }
}

// Main-module guard so unit tests can import the pure helpers without running.
const invokedDirectly = typeof process.argv[1] === 'string' && /decrypt-row/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    // Log ONLY the message — node-vault can embed the (PHI) response body in the
    // error chain. DECRYPT_DEBUG=1 prints the full stack (never in production).
    const e = err as Error & { code?: string };
    console.error(`decrypt-row error: ${e.message}${e.code ? ` (code ${e.code})` : ''}`);
    if (process.env.DECRYPT_DEBUG === '1') console.error(err);
    process.exit(1);
  });
}
