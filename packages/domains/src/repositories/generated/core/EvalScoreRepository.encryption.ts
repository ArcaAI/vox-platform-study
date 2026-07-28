// Field encryption for
// EvalScore (free-text clinical fields: rationale / details JSONB).
//
// Sibling file mirroring ContextItemVersionRepository.encryption.ts (declaration
// merging + prototype patching so codegen can re-run with --overwrite). Both
// fields share ONE `keyVersion` column; the shared Buffer/ciphertext primitives
// live in common/field-encryption.ts and default to the dedicated `hope-phi`
// Transit key. The plaintext columns have been dropped; reads decrypt the
// ciphertext only (no plaintext fallback).

import { EvalScoreRepository } from './EvalScoreRepository';
import { EvalScoreEntity } from '../../../entities';
import {
  type SecretsServiceLike,
  encryptStringToCiphertext,
  encryptJsonToCiphertext,
  decryptCiphertextToString,
  decryptCiphertextToJson,
} from '../../../common/field-encryption';

/** Plaintext view returned by {@link EvalScoreRepository.decryptFieldsFromEntity}. */
export interface EvalScorePlaintext {
  rationale: string | null;
  details: unknown | null;
}

declare module './EvalScoreRepository' {
  interface EvalScoreRepository {
    /**
     * Encrypt every populated free-text field via Vault Transit (hope-phi) and
     * store the ciphertext in the matching `encrypted*` column, recording the
     * Transit key version in the shared `keyVersion`. Mutates the entity in
     * place; caller persists. No-op per field when that field is empty/null, so
     * it is safe to call unconditionally on a partial row. The transient
     * plaintext stays in memory for the request; only ciphertext persists.
     */
    encryptFieldsIntoEntity(this: EvalScoreRepository, entity: EvalScoreEntity, secrets: SecretsServiceLike): Promise<void>;

    /**
     * Decrypt all ciphertext columns (ciphertext-only; the plaintext columns
     * were dropped in Phase 6).
     */
    decryptFieldsFromEntity(this: EvalScoreRepository, entity: EvalScoreEntity, secrets: SecretsServiceLike): Promise<EvalScorePlaintext>;

    /** findById + decryptFieldsFromEntity in one shot (generic findById never decrypts). */
    findByIdWithDecryptedFields(
      this: EvalScoreRepository,
      id: string,
      secrets: SecretsServiceLike,
    ): Promise<{ entity: EvalScoreEntity; plaintext: EvalScorePlaintext }>;
  }
}

EvalScoreRepository.prototype.encryptFieldsIntoEntity = async function (
  this: EvalScoreRepository,
  entity: EvalScoreEntity,
  secrets: SecretsServiceLike,
): Promise<void> {
  let keyVersion: number | null = null;

  const rationale = await encryptStringToCiphertext(secrets, entity.rationale);
  if (rationale) {
    entity.encryptedRationale = rationale.ciphertext;
    keyVersion = rationale.keyVersion;
  }

  const details = await encryptJsonToCiphertext(secrets, entity.details);
  if (details) {
    entity.encryptedDetails = details.ciphertext;
    keyVersion = details.keyVersion;
  }

  if (keyVersion !== null) entity.keyVersion = keyVersion;
};

EvalScoreRepository.prototype.decryptFieldsFromEntity = async function (
  this: EvalScoreRepository,
  entity: EvalScoreEntity,
  secrets: SecretsServiceLike,
): Promise<EvalScorePlaintext> {
  const rationale = await decryptCiphertextToString(secrets, entity.encryptedRationale);
  const details = await decryptCiphertextToJson(secrets, entity.encryptedDetails);
  // Plaintext columns dropped; decrypt ciphertext only.
  return { rationale, details };
};

EvalScoreRepository.prototype.findByIdWithDecryptedFields = async function (
  this: EvalScoreRepository,
  id: string,
  secrets: SecretsServiceLike,
): Promise<{ entity: EvalScoreEntity; plaintext: EvalScorePlaintext }> {
  const entity = await this.findById(id);
  const plaintext = await this.decryptFieldsFromEntity(entity, secrets);
  return { entity, plaintext };
};
