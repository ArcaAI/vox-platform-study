// Encryption helpers for GlobalSettingRepository. Implemented in a sibling
// file via TS declaration merging + prototype patching so the generated
// repository (src/repositories/generated/core/GlobalSettingRepository.ts)
// can be re-run with --overwrite without losing this logic.
//
// Design constraints:
//   - SecretsService is passed as a parameter at call time (NOT via
//     constructor injection) — the codegen owns the constructor
//     signature and changing it would break the regen contract.
//   - The methods live as instance methods on GlobalSettingRepository
//     so consumers can write `repo.encryptValueIntoEntity(entity, sec)`
//     ergonomically.
//   - decryptValueFromEntity falls back to `entity.value` (legacy
//     plaintext) when `encryptedValue` is null. This is the readback
//     bridge that lets Phase 4D (plaintext seed cleanup) wait until
//     after a one-release dual-read soak.

import { GlobalSettingRepository } from './GlobalSettingRepository';
import { GlobalSettingEntity } from '../../../entities';

/**
 * Subset of SecretsService that the helpers actually call. Typed as a
 * structural minimum so the domains package doesn't import the
 * applications package (which would create a cycle: applications →
 * domains → applications).
 */
export interface SecretsServiceLike {
  encrypt(plaintext: Buffer): Promise<string>;
  decrypt(ciphertext: string): Promise<Buffer>;
}

declare module './GlobalSettingRepository' {
  interface GlobalSettingRepository {
    /**
     * Encrypt the entity's plaintext `value` via Vault Transit and store
     * the ciphertext in `encryptedValue` (plus the key version in
     * `keyVersion`). Mutates the entity in place; caller persists.
     *
     * No-op when `entity.value` is empty (no plaintext to encrypt) so
     * the helper is safe to call unconditionally on a row that may or
     * may not have been migrated yet.
     *
     * Note: this method does NOT clear `entity.value`. Plaintext stays
     * in the row as the readback fallback during the Phase 4D window;
     * the actual DELETE is gated on user approval (workspace policy).
     */
    encryptValueIntoEntity(
      this: GlobalSettingRepository,
      entity: GlobalSettingEntity,
      secrets: SecretsServiceLike,
    ): Promise<void>;

    /**
     * Decrypt `encryptedValue` and return the plaintext string. Falls
     * back to `entity.value` when `encryptedValue` is null (one-release
     * legacy bridge). Throws iff the entity has neither.
     *
     * Does NOT write back to `entity.value`. Callers that want
     * decrypted material in memory must accept it as a return value.
     */
    decryptValueFromEntity(
      this: GlobalSettingRepository,
      entity: GlobalSettingEntity,
      secrets: SecretsServiceLike,
    ): Promise<string>;

    /**
     * Read-path helper for explicit decrypted access. Wraps findById
     * and decryptValueFromEntity into one shot so callers that need
     * the plaintext don't have to remember the two-step.
     *
     * findById throws when the row is missing (existing repo
     * semantics), so we never need to encode an `undefined` branch.
     */
    findByIdWithDecryptedValue(
      this: GlobalSettingRepository,
      id: string,
      secrets: SecretsServiceLike,
    ): Promise<{ entity: GlobalSettingEntity; plaintext: string }>;
  }
}

// Note: a behaviour-identical canonical copy of this function lives in
// the applications layer (secrets/secret-field.util.ts). This domains-layer copy
// is intentional — domains cannot import applications (import cycle). Keep the
// two implementations byte-identical; do not diverge one without the other.
function parseKeyVersionFromCiphertext(ct: string): number {
  // Vault Transit ciphertext is of the form `vault:vN:<b64>` where N is
  // the key version. Parse robustly: bad shape → 1 (the bootstrap key).
  const parts = ct.split(':');
  if (parts.length < 3 || parts[1].length < 2 || parts[1][0] !== 'v') return 1;
  const n = parseInt(parts[1].slice(1), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

GlobalSettingRepository.prototype.encryptValueIntoEntity = async function (
  this: GlobalSettingRepository,
  entity: GlobalSettingEntity,
  secrets: SecretsServiceLike,
): Promise<void> {
  if (!entity.value) return;
  const ct = await secrets.encrypt(Buffer.from(entity.value, 'utf8'));
  entity.encryptedValue = Buffer.from(ct, 'utf8');
  entity.keyVersion = parseKeyVersionFromCiphertext(ct);
};

GlobalSettingRepository.prototype.decryptValueFromEntity = async function (
  this: GlobalSettingRepository,
  entity: GlobalSettingEntity,
  secrets: SecretsServiceLike,
): Promise<string> {
  if (entity.encryptedValue) {
    const ct = Buffer.from(entity.encryptedValue).toString('utf8');
    const pt = await secrets.decrypt(ct);
    return pt.toString('utf8');
  }
  if (typeof entity.value === 'string') {
    return entity.value;
  }
  throw new Error(
    `GlobalSettingRepository.decryptValueFromEntity: entity ${entity.id} has neither encryptedValue nor a legacy value`,
  );
};

GlobalSettingRepository.prototype.findByIdWithDecryptedValue = async function (
  this: GlobalSettingRepository,
  id: string,
  secrets: SecretsServiceLike,
): Promise<{ entity: GlobalSettingEntity; plaintext: string }> {
  const entity = await this.findById(id);
  const plaintext = await this.decryptValueFromEntity(entity, secrets);
  return { entity, plaintext };
};
