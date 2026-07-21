// Field encryption for the
// append-only WORM table PipelinePolicyChange (beforeJson / afterJson JSONB).
//
// Sibling file mirroring HarnessPolicyChangeRepository.encryption.ts. The table
// is NOT hash-chained, so encryption is plain encrypt-on-write: the service
// encrypts the before/after snapshots via Vault Transit (hope-phi) and threads
// the ciphertext into the factory, which writes a redaction sentinel into the
// plaintext columns. Helpers are pure (no entity mutation — WORM entity is
// read-only).

import { PipelinePolicyChangeRepository } from './PipelinePolicyChangeRepository';
import { PipelinePolicyChangeEntity } from '../../../entities';
import { type SecretsServiceLike, encryptJsonToCiphertext, decryptCiphertextToJson } from '../../../common/field-encryption';

/** Ciphertext + key version produced by {@link PipelinePolicyChangeRepository.encryptPayloads}. */
export interface PipelinePolicyChangeEncryptedPayloads {
  encryptedBeforeJson: Buffer | null;
  encryptedAfterJson: Buffer | null;
  keyVersion: number | null;
}

/** Decrypted view returned by {@link PipelinePolicyChangeRepository.decryptPayloadsFromEntity}. */
export interface PipelinePolicyChangePlaintext {
  beforeJson: unknown | null;
  afterJson: unknown | null;
}

declare module './PipelinePolicyChangeRepository' {
  interface PipelinePolicyChangeRepository {
    /**
     * Encrypt the before/after policy snapshots via Vault Transit (hope-phi) and
     * return the ciphertext Buffers + the shared key version. Pure; the caller
     * threads the ciphertext into the factory. A null `beforeJson` (policy row
     * created by this change) yields a null ciphertext.
     */
    encryptPayloads(
      this: PipelinePolicyChangeRepository,
      secrets: SecretsServiceLike,
      beforeJson: unknown,
      afterJson: unknown,
    ): Promise<PipelinePolicyChangeEncryptedPayloads>;

    /**
     * Decrypt a change row's ciphertext snapshots, each falling back to its
     * plaintext JSONB column when the ciphertext is null (legacy rows).
     */
    decryptPayloadsFromEntity(
      this: PipelinePolicyChangeRepository,
      entity: PipelinePolicyChangeEntity,
      secrets: SecretsServiceLike,
    ): Promise<PipelinePolicyChangePlaintext>;
  }
}

PipelinePolicyChangeRepository.prototype.encryptPayloads = async function (
  this: PipelinePolicyChangeRepository,
  secrets: SecretsServiceLike,
  beforeJson: unknown,
  afterJson: unknown,
): Promise<PipelinePolicyChangeEncryptedPayloads> {
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

PipelinePolicyChangeRepository.prototype.decryptPayloadsFromEntity = async function (
  this: PipelinePolicyChangeRepository,
  entity: PipelinePolicyChangeEntity,
  secrets: SecretsServiceLike,
): Promise<PipelinePolicyChangePlaintext> {
  const beforeJson = await decryptCiphertextToJson(secrets, entity.encryptedBeforeJson);
  const afterJson = await decryptCiphertextToJson(secrets, entity.encryptedAfterJson);
  return {
    beforeJson: beforeJson !== null ? beforeJson : (entity.beforeJson ?? null),
    afterJson: afterJson !== null ? afterJson : (entity.afterJson ?? null),
  };
};
