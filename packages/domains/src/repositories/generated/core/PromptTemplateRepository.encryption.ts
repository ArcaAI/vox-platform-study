// TASK-369 (Data Encryption Initiative) Phase 3C — field encryption for
// PromptTemplate (lastTestOutput free-text test result).
//
// Sibling file mirroring ContextItemVersionRepository.encryption.ts. The single
// encrypted field records its Transit key version in `keyVersion`; the shared
// Buffer/ciphertext primitives live in common/field-encryption.ts and default
// to the dedicated `hope-phi` Transit key. The plaintext column is retained for
// the dual-read soak — the decrypt helper falls back to plaintext when the
// ciphertext is null.

import { PromptTemplateRepository } from './PromptTemplateRepository';
import { PromptTemplateEntity } from '../../../entities';
import {
  type SecretsServiceLike,
  encryptStringToCiphertext,
  decryptCiphertextToString,
} from '../../../common/field-encryption';

/** Plaintext view returned by {@link PromptTemplateRepository.decryptFieldsFromEntity}. */
export interface PromptTemplatePlaintext {
  lastTestOutput: string | null;
}

declare module './PromptTemplateRepository' {
  interface PromptTemplateRepository {
    /**
     * Encrypt the populated test-output field via Vault Transit (hope-phi) and
     * store the ciphertext in the `encryptedLastTestOutput` column, recording
     * the Transit key version in `keyVersion`. Mutates the entity in place;
     * caller persists. No-op when the field is empty/null, so it is safe to
     * call unconditionally on a partial row. Does NOT clear plaintext —
     * retained for the dual-read soak (Phase 6 cleanup).
     */
    encryptFieldsIntoEntity(
      this: PromptTemplateRepository,
      entity: PromptTemplateEntity,
      secrets: SecretsServiceLike,
    ): Promise<void>;

    /**
     * Decrypt the ciphertext column, falling back to its legacy plaintext
     * column when the ciphertext is null (dual-read soak bridge).
     */
    decryptFieldsFromEntity(
      this: PromptTemplateRepository,
      entity: PromptTemplateEntity,
      secrets: SecretsServiceLike,
    ): Promise<PromptTemplatePlaintext>;

    /** findById + decryptFieldsFromEntity in one shot (generic findById never decrypts). */
    findByIdWithDecryptedFields(
      this: PromptTemplateRepository,
      id: string,
      secrets: SecretsServiceLike,
    ): Promise<{ entity: PromptTemplateEntity; plaintext: PromptTemplatePlaintext }>;
  }
}

PromptTemplateRepository.prototype.encryptFieldsIntoEntity = async function (
  this: PromptTemplateRepository,
  entity: PromptTemplateEntity,
  secrets: SecretsServiceLike,
): Promise<void> {
  let keyVersion: number | null = null;

  const lastTestOutput = await encryptStringToCiphertext(secrets, entity.lastTestOutput);
  if (lastTestOutput) {
    entity.encryptedLastTestOutput = lastTestOutput.ciphertext;
    keyVersion = lastTestOutput.keyVersion;
  }

  if (keyVersion !== null) entity.keyVersion = keyVersion;
};

PromptTemplateRepository.prototype.decryptFieldsFromEntity = async function (
  this: PromptTemplateRepository,
  entity: PromptTemplateEntity,
  secrets: SecretsServiceLike,
): Promise<PromptTemplatePlaintext> {
  const lastTestOutput = await decryptCiphertextToString(secrets, entity.encryptedLastTestOutput);
  return {
    lastTestOutput: lastTestOutput !== null ? lastTestOutput : (entity.lastTestOutput ?? null),
  };
};

PromptTemplateRepository.prototype.findByIdWithDecryptedFields = async function (
  this: PromptTemplateRepository,
  id: string,
  secrets: SecretsServiceLike,
): Promise<{ entity: PromptTemplateEntity; plaintext: PromptTemplatePlaintext }> {
  const entity = await this.findById(id);
  const plaintext = await this.decryptFieldsFromEntity(entity, secrets);
  return { entity, plaintext };
};
