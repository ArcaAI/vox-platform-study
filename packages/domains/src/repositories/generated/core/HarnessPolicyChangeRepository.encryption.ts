// TASK-369 (Data Encryption Initiative) Phase 3D — field encryption for the
// append-only WORM table HarnessPolicyChange (beforeJson / afterJson JSONB).
//
// Sibling file mirroring HarnessAuditEventRepository.encryption.ts. The table is
// NOT hash-chained, so "encrypt-before-hash" reduces to encrypt-on-write: the
// service encrypts the before/after policy snapshots via Vault Transit (hope-phi)
// and threads the ciphertext into the factory, which writes a redaction sentinel
// into the plaintext columns. Helpers are pure (no entity mutation — the WORM
// entity is read-only).

import { HarnessPolicyChangeRepository } from './HarnessPolicyChangeRepository';
import { HarnessPolicyChangeEntity } from '../../../entities';
import { type SecretsServiceLike, encryptJsonToCiphertext, decryptCiphertextToJson } from '../../../common/field-encryption';

/** Ciphertext + key version produced by {@link HarnessPolicyChangeRepository.encryptPayloads}. */
export interface HarnessPolicyChangeEncryptedPayloads {
  encryptedBeforeJson: Buffer | null;
  encryptedAfterJson: Buffer | null;
  keyVersion: number | null;
}

/** Decrypted view returned by {@link HarnessPolicyChangeRepository.decryptPayloadsFromEntity}. */
export interface HarnessPolicyChangePlaintext {
  beforeJson: unknown | null;
  afterJson: unknown | null;
}

declare module './HarnessPolicyChangeRepository' {
  interface HarnessPolicyChangeRepository {
    /**
     * Encrypt the before/after policy snapshots via Vault Transit (hope-phi) and
     * return the ciphertext Buffers + the shared key version. Pure; the caller
     * threads the ciphertext into the factory. A null `beforeJson` (policy row
     * created by this change) yields a null ciphertext.
     */
    encryptPayloads(
      this: HarnessPolicyChangeRepository,
      secrets: SecretsServiceLike,
      beforeJson: unknown,
      afterJson: unknown,
    ): Promise<HarnessPolicyChangeEncryptedPayloads>;

    /**
     * Decrypt a change row's ciphertext snapshots, each falling back to its
     * plaintext JSONB column when the ciphertext is null (legacy rows).
     */
    decryptPayloadsFromEntity(
      this: HarnessPolicyChangeRepository,
      entity: HarnessPolicyChangeEntity,
      secrets: SecretsServiceLike,
    ): Promise<HarnessPolicyChangePlaintext>;
  }
}

HarnessPolicyChangeRepository.prototype.encryptPayloads = async function (
  this: HarnessPolicyChangeRepository,
  secrets: SecretsServiceLike,
  beforeJson: unknown,
  afterJson: unknown,
): Promise<HarnessPolicyChangeEncryptedPayloads> {
  let keyVersion: number | null = null;

  const before = await encryptJsonToCiphertext(secrets, beforeJson ?? null);
  if (before) keyVersion = before.keyVersion;

  const after = await encryptJsonToCiphertext(secrets, afterJson ?? null);
  if (after) keyVersion = after.keyVersion;

  return {
    encryptedBeforeJson: before?.ciphertext ?? null,
    encryptedAfterJson: after?.ciphertext ?? null,
    keyVersion,
  };
};

HarnessPolicyChangeRepository.prototype.decryptPayloadsFromEntity = async function (
  this: HarnessPolicyChangeRepository,
  entity: HarnessPolicyChangeEntity,
  secrets: SecretsServiceLike,
): Promise<HarnessPolicyChangePlaintext> {
  const beforeJson = await decryptCiphertextToJson(secrets, entity.encryptedBeforeJson);
  const afterJson = await decryptCiphertextToJson(secrets, entity.encryptedAfterJson);
  return {
    beforeJson: beforeJson !== null ? beforeJson : (entity.beforeJson ?? null),
    afterJson: afterJson !== null ? afterJson : (entity.afterJson ?? null),
  };
};
