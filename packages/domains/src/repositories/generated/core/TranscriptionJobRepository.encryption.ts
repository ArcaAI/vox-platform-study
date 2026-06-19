// TASK-369 (Data Encryption Initiative) Phase 3C — field encryption for
// TranscriptionJob (resultText free-text + resultMetadata JSONB).
//
// Sibling file mirroring ContextItemVersionRepository.encryption.ts. Both
// fields share ONE `keyVersion` column; the shared Buffer/ciphertext primitives
// live in common/field-encryption.ts and default to the dedicated `hope-phi`
// Transit key. Plaintext columns are retained for the dual-read soak — decrypt
// helpers fall back to plaintext when the ciphertext is null.

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
     * it is safe to call unconditionally on a partial row. Does NOT clear
     * plaintext — retained for the dual-read soak (Phase 6 cleanup).
     */
    encryptFieldsIntoEntity(
      this: TranscriptionJobRepository,
      entity: TranscriptionJobEntity,
      secrets: SecretsServiceLike,
    ): Promise<void>;

    /**
     * Decrypt all ciphertext columns, each falling back to its legacy plaintext
     * column when the ciphertext is null (dual-read soak bridge).
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
  return {
    resultText: resultText !== null ? resultText : (entity.resultText ?? null),
    resultMetadata: resultMetadata !== null ? resultMetadata : (entity.resultMetadata ?? null),
  };
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
