// Shared field-encryption
// primitives for the repository encryption sibling files
// (`XxxRepository.encryption.ts`).
//
// Why a shared module instead of duplicating the GlobalSetting recipe per
// model: the clinical-PHI rollout (Phase 3B/3C/3D) covers ~15 fields across
// many models. The per-repo sibling files keep the ergonomic, type-safe
// `repo.encryptXIntoEntity(entity, secrets)` surface (via prototype +
// declaration merging so codegen can re-run with --overwrite), but delegate
// the actual Buffer/ciphertext/key-version handling here so the logic lives
// in ONE place.
//
// This module is intentionally NOT exported from `common/index.ts`: the
// generated `GlobalSettingRepository.encryption.ts` already exports a
// `SecretsServiceLike` of its own, and re-exporting a second one through the
// top-level `@arcaai/domains` barrel would be a duplicate-export conflict.
// Sibling files import from here by relative path; consumers (the application
// services) only ever pass a structural object and never import the type name.

/**
 * Logical name of the dedicated PHI Vault Transit key. Phase 3A provisions a
 * key literally named `hope-phi` (separate rotation/policy blast radius from
 * the `hope-globalsetting` secrets key). Used as the default so PHI field
 * encryption works even if `VAULT_TRANSIT_KEY_PHI` is never configured.
 */
export const PHI_TRANSIT_KEY = 'hope-phi';

/**
 * Non-PHI placeholder written into a plaintext JSONB column
 * when its real value has been encrypted into the sibling `encrypted*` column.
 * Used by the IMMUTABLE WORM tables (HarnessAuditEvent / HarnessPolicyChange /
 * PipelinePolicyChange) whose plaintext columns are NOT NULL and can never be
 * scrubbed later (UPDATE/DELETE revoked) — so a NEW (encrypted) row must not
 * leave PHI in plaintext. The ciphertext (which the row `hash` is computed over,
 * where applicable) is the source of truth; decrypt to read the value back.
 * Spread into a fresh object on use so the shared constant is never mutated.
 */
export const ENCRYPTED_PAYLOAD_SENTINEL: { readonly _encrypted: true } = { _encrypted: true };

/**
 * Structural subset of `SecretsService` the helpers call. Typed as a minimum
 * so `@arcaai/domains` does NOT import `@arcaai/applications` (which would
 * create the cycle applications → domains → applications). The optional
 * `getPhiTransitKeyName()` lets the real SecretsService thread the
 * ops-configured PHI key name through; unit-test mocks omit it and fall back
 * to {@link PHI_TRANSIT_KEY}.
 */
export interface SecretsServiceLike {
  encrypt(plaintext: Buffer, keyName?: string): Promise<string>;
  decrypt(ciphertext: string, keyName?: string): Promise<Buffer>;
  /**
   * Optional Vault Transit BATCH decrypt. When present, the
   * repository decrypt-on-read path uses it to decrypt every ciphertext in a
   * multi-row/list read with ONE round-trip (the real SecretsService provides
   * it; unit-test mocks may omit it and fall back to per-item `decrypt`).
   * Returns plaintext buffers in the SAME order as the input ciphertexts.
   */
  decryptBatch?(ciphertexts: string[], keyName?: string): Promise<Buffer[]>;
  getPhiTransitKeyName?(): string | undefined;
}

/**
 * Vault Transit ciphertext is `vault:vN:<b64>` where N is the key version.
 * Parse robustly: a malformed shape falls back to 1 (the bootstrap version).
 */
export function parseKeyVersionFromCiphertext(ct: string): number {
  const parts = ct.split(':');
  if (parts.length < 3 || parts[1].length < 2 || parts[1][0] !== 'v') return 1;
  const n = parseInt(parts[1].slice(1), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function resolvePhiKey(secrets: SecretsServiceLike): string {
  return secrets.getPhiTransitKeyName?.() ?? PHI_TRANSIT_KEY;
}

/**
 * Encrypt a plaintext string under the PHI Transit key. Returns the ciphertext
 * as a Buffer (for the `Bytes?` column) plus the parsed key version, or `null`
 * when there is nothing to encrypt (`null` / `undefined` / empty string) so
 * callers can no-op safely on a not-yet-migrated row.
 */
export async function encryptStringToCiphertext(
  secrets: SecretsServiceLike,
  plaintext: string | null | undefined,
): Promise<{ ciphertext: Buffer; keyVersion: number } | null> {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const ct = await secrets.encrypt(Buffer.from(plaintext, 'utf8'), resolvePhiKey(secrets));
  return { ciphertext: Buffer.from(ct, 'utf8'), keyVersion: parseKeyVersionFromCiphertext(ct) };
}

/**
 * Decrypt a ciphertext Buffer back to its plaintext string. Returns `null`
 * when the ciphertext column is empty. (AuditLog/WORM/GlobalSetting still
 * retain a plaintext column to fall back to; the Phase 6 PHI models dropped
 * theirs, so `null` is terminal there.)
 */
export async function decryptCiphertextToString(
  secrets: SecretsServiceLike,
  ciphertext: Buffer | Uint8Array | null | undefined,
): Promise<string | null> {
  if (!ciphertext || ciphertext.length === 0) return null;
  const ct = Buffer.from(ciphertext).toString('utf8');
  const pt = await secrets.decrypt(ct, resolvePhiKey(secrets));
  return pt.toString('utf8');
}

/**
 * Encrypt a JSON-serialisable value (for JSONB columns) by stringifying it and
 * encrypting the whole blob. Returns `null` for `null` / `undefined` so an
 * absent JSON field is left unencrypted.
 */
export async function encryptJsonToCiphertext(
  secrets: SecretsServiceLike,
  value: unknown,
): Promise<{ ciphertext: Buffer; keyVersion: number } | null> {
  if (value === null || value === undefined) return null;
  return encryptStringToCiphertext(secrets, JSON.stringify(value));
}

/**
 * Decrypt a JSONB ciphertext Buffer back to its parsed value. Returns `null`
 * when the ciphertext column is empty.
 */
export async function decryptCiphertextToJson<T = unknown>(
  secrets: SecretsServiceLike,
  ciphertext: Buffer | Uint8Array | null | undefined,
): Promise<T | null> {
  const raw = await decryptCiphertextToString(secrets, ciphertext);
  if (raw === null) return null;
  return JSON.parse(raw) as T;
}
