// TASK-504 Phase 1 — canonical "encrypted secret field in a DB column" helpers.
//
// The single home for the Vault-Transit crypto path behind data class 2
// (per-tenant BYO secret at rest — see docs/implementation/TASK-504.../README.md
// §3). Every credential/secret-field service (TenantTtsProviderCredential today,
// future SSO/SMTP/webhook secrets) encrypts and decrypts through THIS module so
// the ciphertext handling is audited in exactly one place instead of copy-pasted
// per feature.
//
// Layering note: this lives in the applications layer alongside SecretsService.
// A behaviour-identical twin of parseKeyVersionFromCiphertext also exists in the
// domains layer (packages/domains/src/repositories/generated/core/
// GlobalSettingRepository.encryption.ts). The domains package CANNOT import the
// applications package (it would create the cycle applications → domains →
// applications), so that copy is intentional and MUST stay byte-identical to
// this one — do not let the two implementations drift.

/**
 * Minimal Vault-Transit surface these helpers call. Declared structurally so
 * the util has no hard dependency on the concrete SecretsService — any object
 * exposing encrypt/decrypt (including the test fakes) satisfies it.
 */
export interface TransitCrypto {
  encrypt(plaintext: Buffer, keyName?: string): Promise<string>;
  decrypt(ciphertext: string, keyName?: string): Promise<Buffer>;
}

/**
 * Vault Transit ciphertext has the form `vault:vN:<base64>` where N is the
 * encryption key version. Extract N; any malformed/absent shape falls back to
 * 1 (the bootstrap key version) so a bad value can never yield a non-positive
 * or NaN key version.
 */
export function parseKeyVersionFromCiphertext(ciphertext: string): number {
  const parts = ciphertext.split(':');
  if (parts.length < 3 || parts[1].length < 2 || parts[1][0] !== 'v') return 1;
  const n = parseInt(parts[1].slice(1), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Encrypt a plaintext secret into the at-rest column shape:
 * `{ ciphertext: Bytes, keyVersion }`. The ciphertext bytes are the raw Vault
 * Transit string (`vault:vN:..`) stored as UTF-8 — the exact form the DB
 * `encrypted* Bytes` columns hold.
 *
 * The caller is responsible for gating on the presence of a Transit-capable
 * provider first (data class 2 rejects the write when Vault is absent — there
 * is no plaintext-at-rest fallback).
 */
export async function encryptSecretField(
  secrets: TransitCrypto,
  plaintext: string,
  keyName?: string,
): Promise<{ ciphertext: Buffer; keyVersion: number }> {
  const ct = await secrets.encrypt(Buffer.from(plaintext, 'utf8'), keyName);
  return { ciphertext: Buffer.from(ct, 'utf8'), keyVersion: parseKeyVersionFromCiphertext(ct) };
}

/**
 * Decrypt a stored secret-field column (`Bytes` holding a Transit ciphertext
 * string) back to its plaintext string.
 */
export async function decryptSecretField(
  // Prisma `Bytes` columns surface as Uint8Array; Buffer is a subclass, so this
  // accepts both the stored column value and a Buffer without a caller-side cast.
  secrets: TransitCrypto,
  ciphertext: Uint8Array,
  keyName?: string,
): Promise<string> {
  const ct = Buffer.from(ciphertext).toString('utf8');
  const pt = await secrets.decrypt(ct, keyName);
  return pt.toString('utf8');
}
