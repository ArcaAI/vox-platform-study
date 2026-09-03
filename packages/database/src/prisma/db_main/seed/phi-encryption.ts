/**
 * Data Encryption Initiative — seed-time Vault-Transit encryption.
 *
 * PHI field encryption (the bulk of this file) plus — since Round 4
 * non-PHI SECRET-FIELD encryption under a second Transit key
 * (`encryptSeedSecret`, at the bottom). One file because this holds the seed's
 * ONLY Vault client and its AppRole/unwrap/login dance.
 *
 * The plaintext clinical-PHI columns were DROPPED, so the seeds can no longer
 * write free-text into them. Instead they must persist Vault-Transit (`hope-phi`)
 * ciphertext into the sibling `encrypted*` columns — byte-identical to what the
 * application services write through `@arcaai/domains` `field-encryption.ts`
 * (`encryptStringToCiphertext`), so repository decrypt-on-read and the
 * `pnpm decrypt:row` tool read the seeded rows back unchanged.
 *
 * This leaf `@arcaai/database` package CANNOT import the domain
 * `encrypt*IntoEntity` / SecretsService helpers — `@arcaai/domains` and
 * `@arcaai/applications` already depend on `@arcaai/database`, so importing them
 * here would create a workspace dependency cycle. Exactly like the sanctioned
 * `scripts/decrypt-row.ts`, this talks to Vault Transit directly via
 * `node-vault`, producing the identical `vault:vN:<b64>`-as-utf8-bytes format
 * (stored in the `BYTEA encrypted*` columns) plus the parsed `keyVersion`.
 *
 * ENVIRONMENT-GATED (mirrors the application write-path
 * `@arcaai/applications` `phi-field-encryption.ts` `isPhiEncryptionRequired`):
 *   - `SECRETS_PROVIDER=vault` (staging/prod + dev per `.env.dev`) → encrypt via
 *     a reachable Vault, fail closed if it is missing/unreachable.
 *   - anything else (`env`, unset — e.g. `.env.test`) → soft no-op: the app
 *     leaves these fields unpersisted on write, so the seed does the same instead
 *     of hard-requiring Vault (a hard requirement aborted `pnpm test:db:seed`
 *     under `.env.test`, which configures no Vault).
 */
import vault from 'node-vault';

// PHI Transit key. The clinical-content key is `hope-phi` (env `VAULT_TRANSIT_KEY`
// = `hope-globalsetting` is a DIFFERENT, non-PHI key), matching the
// `@arcaai/domains` PHI default. Overridable via `VAULT_TRANSIT_KEY_PHI`.
const PHI_TRANSIT_KEY = process.env.VAULT_TRANSIT_KEY_PHI || 'hope-phi';
const TRANSIT_MOUNT = process.env.VAULT_TRANSIT_MOUNT || 'transit';

// ───────────────────────────── Vault (node-vault) ─────────────────────────────

interface VaultClientLike {
  token?: string | undefined;
  unwrap(payload?: { token: string }): Promise<unknown>;
  approleLogin(opts: { role_id: string; secret_id: string }): Promise<unknown>;
  write(path: string, body: Record<string, unknown>): Promise<unknown>;
}

let clientPromise: Promise<VaultClientLike> | null = null;

/** AppRole auth (mirrors VaultSecretsProvider.boot / decrypt-row): unwrap a wrapped secret_id if present, then login. */
async function authenticateViaAppRole(client: VaultClientLike): Promise<void> {
  const roleId = process.env.VAULT_ROLE_ID;
  const wrapped = process.env.VAULT_WRAPPED_SECRET_ID;
  const direct = process.env.VAULT_SECRET_ID;
  if (!roleId) throw new Error('VAULT_ROLE_ID is required for AppRole auth');

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
    throw new Error('No secret_id: provide VAULT_WRAPPED_SECRET_ID (preferred) or VAULT_SECRET_ID');
  }

  const login = (await client.approleLogin({ role_id: roleId, secret_id: secretId })) as {
    auth?: { client_token?: string };
  };
  const token = login?.auth?.client_token;
  if (!token) throw new Error('AppRole login did not return a client_token');
  client.token = token;
}

/** Lazily create + authenticate a single Vault client (dev root token first, else AppRole). */
async function getVaultClient(): Promise<VaultClientLike> {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const endpoint = process.env.VAULT_ADDR;
    if (!endpoint) {
      throw new Error('VAULT_ADDR is required to seed PHI ciphertext (SECRETS_PROVIDER=vault).');
    }
    const client = vault({ apiVersion: 'v1', endpoint }) as unknown as VaultClientLike;
    const rootToken = process.env.VAULT_DEV_ROOT_TOKEN || process.env.VAULT_TOKEN;
    if (rootToken) {
      client.token = rootToken; // dev convenience: skip AppRole when a root token is present
    } else {
      await authenticateViaAppRole(client);
    }
    return client;
  })();
  return clientPromise;
}

/** Parse `vault:vN:..` → N (Transit key version), defaulting to 1. */
function parseKeyVersion(ciphertext: string): number {
  const parts = ciphertext.split(':');
  if (parts.length < 3 || !parts[1] || parts[1][0] !== 'v') return 1;
  const n = Number.parseInt(parts[1].slice(1), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** transit/encrypt a plaintext Buffer → `vault:vN:<b64>` ciphertext string. */
async function transitEncrypt(plaintext: Buffer, keyName: string = PHI_TRANSIT_KEY): Promise<string> {
  const client = await getVaultClient();
  const res = (await client.write(`${TRANSIT_MOUNT}/encrypt/${keyName}`, {
    plaintext: plaintext.toString('base64'),
  })) as { data?: { ciphertext?: string } };
  const ct = res?.data?.ciphertext;
  if (!ct) throw new Error(`${TRANSIT_MOUNT}/encrypt/${keyName} returned empty ciphertext`);
  return ct;
}

export interface SeedCiphertext {
  ciphertext: Buffer;
  keyVersion: number;
}

/** Encrypt a UTF-8 string → BYTEA ciphertext + keyVersion. `null`/empty → null (column stays NULL). */
async function encryptString(plaintext: string | null | undefined): Promise<SeedCiphertext | null> {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const ct = await transitEncrypt(Buffer.from(plaintext, 'utf8'));
  return { ciphertext: Buffer.from(ct, 'utf8'), keyVersion: parseKeyVersion(ct) };
}

/** Encrypt a JSON value (stringified) → BYTEA ciphertext + keyVersion. `null` → null. */
async function encryptJson(value: unknown): Promise<SeedCiphertext | null> {
  if (value === null || value === undefined) return null;
  return encryptString(JSON.stringify(value));
}

// ──────────────────────────── per-model field registry ────────────────────────────
//
// Mirrors the dropped-column → `encrypted*` mapping (and JSON-ness) used by the
// repository decrypt-on-read registry, so seeded ciphertext round-trips. Only
// the models whose Phase 6 PHI columns are SEEDED appear here.

interface PhiField {
  /** plaintext source key on the seed row (removed before persist). */
  plaintext: string;
  /** target `encrypted*` BYTEA column. */
  ciphertext: string;
  /** encode as JSON before encrypting (object/array columns). */
  json?: boolean;
}

interface PhiModel {
  /** column that records the Transit key version for this row. */
  keyVersionColumn: string;
  fields: PhiField[];
}

const SEED_PHI_MODELS = {
  // ContextItem uses a field-specific `contentKeyVersion` (single PHI field).
  ContextItem: {
    keyVersionColumn: 'contentKeyVersion',
    fields: [{ plaintext: 'content', ciphertext: 'encryptedContent' }],
  },
  ContextItemVersion: {
    keyVersionColumn: 'keyVersion',
    fields: [
      { plaintext: 'content', ciphertext: 'encryptedContent' },
      { plaintext: 'contentDiff', ciphertext: 'encryptedContentDiff' },
      { plaintext: 'changeSummary', ciphertext: 'encryptedChangeSummary' },
      { plaintext: 'fieldChanges', ciphertext: 'encryptedFieldChanges', json: true },
    ],
  },
  NamedEntity: {
    keyVersionColumn: 'keyVersion',
    fields: [
      { plaintext: 'text', ciphertext: 'encryptedText' },
      { plaintext: 'normalizedText', ciphertext: 'encryptedNormalizedText' },
      { plaintext: 'metadata', ciphertext: 'encryptedMetadata', json: true },
    ],
  },
  TranscriptionJob: {
    keyVersionColumn: 'keyVersion',
    fields: [
      { plaintext: 'resultText', ciphertext: 'encryptedResultText' },
      { plaintext: 'resultMetadata', ciphertext: 'encryptedResultMetadata', json: true },
    ],
  },
  DnaWritingStyleReport: {
    keyVersionColumn: 'keyVersion',
    fields: [
      { plaintext: 'reportData', ciphertext: 'encryptedReportData', json: true },
      { plaintext: 'styleText', ciphertext: 'encryptedStyleText' },
    ],
  },
  DnaWritingStyleVersion: {
    keyVersionColumn: 'keyVersion',
    fields: [
      { plaintext: 'reportData', ciphertext: 'encryptedReportData', json: true },
      { plaintext: 'styleText', ciphertext: 'encryptedStyleText' },
    ],
  },
  // the Workbench's saved SYNTHETIC test payload. Mirrors the read-side registry
  // (`phi-read-decrypt.ts`: `encryptedInput: { plaintext: 'input', json: true }`) exactly; the
  // plaintext `input` column was dropped, so ciphertext is the system of record. Registered even
  // though the contract forbids real patient data in a fixture, because the column is encrypted
  // regardless of whether that contract is honoured.
  WorkflowTestFixture: {
    keyVersionColumn: 'keyVersion',
    fields: [{ plaintext: 'input', ciphertext: 'encryptedInput', json: true }],
  },
} satisfies Record<string, PhiModel>;

export type SeedPhiModel = keyof typeof SEED_PHI_MODELS;

/**
 * Whether seed-time PHI encryption is REQUIRED for the current environment.
 *
 * Mirrors the application write-path gate (`@arcaai/applications`
 * `phi-field-encryption.ts` `isPhiEncryptionRequired`) — duplicated here because
 * the leaf `@arcaai/database` package cannot import `@arcaai/applications`
 * without a dependency cycle (the same reason this file talks to Vault directly).
 * `SECRETS_PROVIDER=vault` ⇒ encrypt + fail closed; anything else ⇒ soft no-op.
 */
export function isSeedPhiEncryptionRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SECRETS_PROVIDER === 'vault';
}

/**
 * Return a copy of `row` with its Phase-6 plaintext PHI keys replaced by the
 * `encrypted*` BYTEA ciphertext (+ the row's `keyVersion`/`contentKeyVersion`).
 * Non-PHI fields pass through untouched. Use the result as BOTH the upsert
 * `create` and `update` payload so seeded rows match the encrypt-on-write path.
 *
 * In soft (non-Vault dev/test) mode the Phase-6 plaintext columns no longer
 * exist, so the plaintext seed keys are dropped and the `encrypted*` columns are
 * left NULL — byte-for-byte what the application persists on write there.
 */
export async function encryptSeedRow<TOut extends Record<string, unknown> = Record<string, unknown>>(
  model: SeedPhiModel,
  row: Record<string, unknown>,
): Promise<TOut> {
  const spec: PhiModel = SEED_PHI_MODELS[model];
  const out: Record<string, unknown> = { ...row };
  const required = isSeedPhiEncryptionRequired();
  let keyVersion: number | undefined;

  for (const field of spec.fields) {
    const value = out[field.plaintext];
    delete out[field.plaintext];
    if (!required) continue; // soft no-op: no Vault, leave encrypted*/keyVersion NULL
    const enc = field.json ? await encryptJson(value) : await encryptString(value as string | null | undefined);
    if (enc) {
      out[field.ciphertext] = enc.ciphertext;
      keyVersion = enc.keyVersion;
    }
  }
  if (keyVersion !== undefined) out[spec.keyVersionColumn] = keyVersion;
  return out as TOut;
}

// ─────────────────── seed-time SECRET-FIELD encryption (non-PHI) ───────────────────
//
// A second Transit key lives in this file because this is the seed's ONLY Vault
// client, and duplicating the AppRole/unwrap/login dance for a second caller is
// exactly the kind of copy the module header warns about.
//
// The KEY differs from the PHI one and that difference is load-bearing:
// `AiProviderConnection.encryptedApiKey` is written by
// `@arcaai/applications` `encryptSecretField(secretsService, plaintext)` with NO
// `keyName`, so it lands on `SecretsService`'s default transit key —
// `VAULT_TRANSIT_KEY ?? 'hope-globalsetting'` (`secrets.module.ts`). Seeding
// under `hope-phi` would produce a row the runtime cannot decrypt.
//
// Read from `process.env` at CALL time rather than module scope so a caller that
// stubs the environment (tests, a script that loads its env file late) observes
// the value it set.

/** The Transit key `SecretsService` encrypts secret FIELDS under (not the PHI key). */
const secretTransitKey = (): string => process.env.VAULT_TRANSIT_KEY || 'hope-globalsetting';

/**
 * Whether seed-time secret-field encryption can run at all.
 *
 * Same gate as `isSeedPhiEncryptionRequired` and for the same reason: without
 * `SECRETS_PROVIDER=vault` there is no Transit provider, and the RUNTIME resolver
 * is equally inert — `AiProviderConnectionService.resolveTenantCloudOverrides`
 * returns `{}` when no `SecretsService` is wired, and `toOverrideEntry` bails on
 * any row it cannot decrypt. So a non-Vault environment has no working provider
 * plane whether or not the seed writes ciphertext; it must not ABORT the seed.
 */
export function isSeedSecretEncryptionAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SECRETS_PROVIDER === 'vault';
}

/**
 * Encrypt a NON-PHI seed secret into the `{ ciphertext, keyVersion }` column
 * shape, or `null` when Vault is not configured for this environment.
 *
 * Byte-identical to `encryptSecretField` in `@arcaai/applications` (which this
 * package cannot import — dependency cycle): the raw `vault:vN:<b64>` string
 * stored as UTF-8 bytes, plus the version parsed out of it.
 */
export async function encryptSeedSecret(plaintext: string): Promise<SeedCiphertext | null> {
  if (!plaintext || !isSeedSecretEncryptionAvailable()) return null;
  const ct = await transitEncrypt(Buffer.from(plaintext, 'utf8'), secretTransitKey());
  return { ciphertext: Buffer.from(ct, 'utf8'), keyVersion: parseKeyVersion(ct) };
}
