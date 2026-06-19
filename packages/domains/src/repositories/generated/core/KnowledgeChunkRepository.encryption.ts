// TASK-369 (Data Encryption Initiative) Phase 3C — field encryption for
// KnowledgeChunk (institutional RAG chunk: text).
//
// Sibling file mirroring ContextItemRepository.encryption.ts (declaration
// merging + prototype patching so codegen can re-run with --overwrite). The
// field uses ONE `keyVersion` column; the shared Buffer/ciphertext primitives
// live in common/field-encryption.ts and default to the dedicated `hope-phi`
// Transit key. The plaintext column is retained for the dual-read soak — the
// decrypt helper falls back to plaintext when the ciphertext is null.

import { KnowledgeChunkRepository } from './KnowledgeChunkRepository';
import { KnowledgeChunkEntity } from '../../../entities';
import {
  type SecretsServiceLike,
  encryptStringToCiphertext,
  decryptCiphertextToString,
} from '../../../common/field-encryption';

/** Plaintext view returned by {@link KnowledgeChunkRepository.decryptFieldsFromEntity}. */
export interface KnowledgeChunkPlaintext {
  text: string | null;
}

declare module './KnowledgeChunkRepository' {
  interface KnowledgeChunkRepository {
    /**
     * Encrypt the populated chunk text via Vault Transit (hope-phi) and store
     * the ciphertext in the `encryptedText` column, recording the Transit key
     * version in the shared `keyVersion`. Mutates the entity in place; caller
     * persists. No-op when the field is empty/null, so it is safe to call
     * unconditionally on a partial row. Does NOT clear plaintext — retained for
     * the dual-read soak (Phase 6 cleanup).
     */
    encryptFieldsIntoEntity(
      this: KnowledgeChunkRepository,
      entity: KnowledgeChunkEntity,
      secrets: SecretsServiceLike,
    ): Promise<void>;

    /**
     * Decrypt the ciphertext column, falling back to the legacy plaintext
     * column when the ciphertext is null (dual-read soak bridge).
     */
    decryptFieldsFromEntity(
      this: KnowledgeChunkRepository,
      entity: KnowledgeChunkEntity,
      secrets: SecretsServiceLike,
    ): Promise<KnowledgeChunkPlaintext>;

    /** findById + decryptFieldsFromEntity in one shot (generic findById never decrypts). */
    findByIdWithDecryptedFields(
      this: KnowledgeChunkRepository,
      id: string,
      secrets: SecretsServiceLike,
    ): Promise<{ entity: KnowledgeChunkEntity; plaintext: KnowledgeChunkPlaintext }>;
  }
}

KnowledgeChunkRepository.prototype.encryptFieldsIntoEntity = async function (
  this: KnowledgeChunkRepository,
  entity: KnowledgeChunkEntity,
  secrets: SecretsServiceLike,
): Promise<void> {
  let keyVersion: number | null = null;

  const text = await encryptStringToCiphertext(secrets, entity.text);
  if (text) {
    entity.encryptedText = text.ciphertext;
    keyVersion = text.keyVersion;
  }

  if (keyVersion !== null) entity.keyVersion = keyVersion;
};

KnowledgeChunkRepository.prototype.decryptFieldsFromEntity = async function (
  this: KnowledgeChunkRepository,
  entity: KnowledgeChunkEntity,
  secrets: SecretsServiceLike,
): Promise<KnowledgeChunkPlaintext> {
  const text = await decryptCiphertextToString(secrets, entity.encryptedText);
  return {
    text: text !== null ? text : (entity.text ?? null),
  };
};

KnowledgeChunkRepository.prototype.findByIdWithDecryptedFields = async function (
  this: KnowledgeChunkRepository,
  id: string,
  secrets: SecretsServiceLike,
): Promise<{ entity: KnowledgeChunkEntity; plaintext: KnowledgeChunkPlaintext }> {
  const entity = await this.findById(id);
  const plaintext = await this.decryptFieldsFromEntity(entity, secrets);
  return { entity, plaintext };
};
