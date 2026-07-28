// Field encryption for
// TranscriptionJob (resultText free-text + resultMetadata JSONB).
//
// Sibling file mirroring ContextItemVersionRepository.encryption.ts. Both
// fields share ONE `keyVersion` column; the shared Buffer/ciphertext primitives
// live in common/field-encryption.ts and default to the dedicated `hope-phi`
// Transit key. The plaintext columns have been dropped; reads decrypt the
// ciphertext only (no plaintext fallback).

import { TranscriptionJobRepository } from './TranscriptionJobRepository';
import { TranscriptionJobEntity } from '../../../entities';
import {
  type SecretsServiceLike,
  encryptStringToCiphertext,
  encryptJsonToCiphertext,
  decryptCiphertextToString,
  decryptCiphertextToJson,
} from '../../../common/field-encryption';

/** Plaintext view returned by {@link TranscriptionJobRepository.decryptFieldsFromEntity}. */
export interface TranscriptionJobPlaintext {
  resultText: string | null;
  resultMetadata: unknown | null;
}

declare module './TranscriptionJobRepository' {
  interface TranscriptionJobRepository {
    /**
     * Encrypt every populated result field via Vault Transit (hope-phi) and
     * store the ciphertext in the matching `encrypted*` column, recording the
     * Transit key version in the shared `keyVersion`. Mutates the entity in
     * place; caller persists. No-op per field when that field is empty/null, so
     * it is safe to call unconditionally on a partial row. The transient
     * plaintext stays in memory for the request; only ciphertext persists.
     */
    encryptFieldsIntoEntity(this: TranscriptionJobRepository, entity: TranscriptionJobEntity, secrets: SecretsServiceLike): Promise<void>;

    /**
     * Decrypt all ciphertext columns (ciphertext-only; the plaintext columns
     * were dropped in Phase 6).
     */
    decryptFieldsFromEntity(
      this: TranscriptionJobRepository,
      entity: TranscriptionJobEntity,
      secrets: SecretsServiceLike,
    ): Promise<TranscriptionJobPlaintext>;

    /** findById + decryptFieldsFromEntity in one shot (generic findById never decrypts). */
    findByIdWithDecryptedFields(
      this: TranscriptionJobRepository,
      id: string,
      secrets: SecretsServiceLike,
    ): Promise<{ entity: TranscriptionJobEntity; plaintext: TranscriptionJobPlaintext }>;
  }
}

TranscriptionJobRepository.prototype.encryptFieldsIntoEntity = async function (
  this: TranscriptionJobRepository,
  entity: TranscriptionJobEntity,
  secrets: SecretsServiceLike,
): Promise<void> {
  let keyVersion: number | null = null;

  const resultText = await encryptStringToCiphertext(secrets, entity.resultText);
  if (resultText) {
    entity.encryptedResultText = resultText.ciphertext;
    keyVersion = resultText.keyVersion;
  }

  const resultMetadata = await encryptJsonToCiphertext(secrets, entity.resultMetadata);
  if (resultMetadata) {
    entity.encryptedResultMetadata = resultMetadata.ciphertext;
    keyVersion = resultMetadata.keyVersion;
  }

  if (keyVersion !== null) entity.keyVersion = keyVersion;
};

TranscriptionJobRepository.prototype.decryptFieldsFromEntity = async function (
  this: TranscriptionJobRepository,
  entity: TranscriptionJobEntity,
  secrets: SecretsServiceLike,
): Promise<TranscriptionJobPlaintext> {
  const resultText = await decryptCiphertextToString(secrets, entity.encryptedResultText);
  const resultMetadata = await decryptCiphertextToJson(secrets, entity.encryptedResultMetadata);
  // Plaintext columns dropped; decrypt ciphertext only.
  return { resultText, resultMetadata };
};

TranscriptionJobRepository.prototype.findByIdWithDecryptedFields = async function (
  this: TranscriptionJobRepository,
  id: string,
  secrets: SecretsServiceLike,
): Promise<{ entity: TranscriptionJobEntity; plaintext: TranscriptionJobPlaintext }> {
  const entity = await this.findById(id);
  const plaintext = await this.decryptFieldsFromEntity(entity, secrets);
  return { entity, plaintext };
};
