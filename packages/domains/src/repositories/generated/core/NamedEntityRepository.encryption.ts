// Field encryption for
// NamedEntity (recognized free-text span `text`/`normalizedText` + `metadata`).
//
// Sibling file mirroring ContextItemRepository.encryption.ts. The short
// ontology code columns (umlsCui / snomedCode / rxnormCode / icdCode /
// loincCode) are standard coded identifiers and are intentionally NOT
// encrypted (kept queryable under disk encryption, per the data-classification
// decision). All encrypted fields share ONE `keyVersion` column. Phase 6 dropped
// the plaintext columns; reads decrypt the ciphertext only.
//
// Performance note: NamedEntity rows are created in BULK by the NER pipeline.
// Encrypting via a Transit round-trip per field per row is acceptable for the
// pilot/soak but should move to Transit BATCH encrypt before broad enablement
// on hot bulk paths (tracked under Phase 3D's AuditLog/batch work).

import { NamedEntityRepository } from './NamedEntityRepository';
import { NamedEntityEntity } from '../../../entities';
import {
  type SecretsServiceLike,
  encryptStringToCiphertext,
  encryptJsonToCiphertext,
  decryptCiphertextToString,
  decryptCiphertextToJson,
} from '../../../common/field-encryption';

/** Plaintext view returned by {@link NamedEntityRepository.decryptFieldsFromEntity}. */
export interface NamedEntityPlaintext {
  text: string | null;
  normalizedText: string | null;
  metadata: unknown | null;
}

declare module './NamedEntityRepository' {
  interface NamedEntityRepository {
    /**
     * Encrypt the recognized span + metadata via Vault Transit (hope-phi),
     * storing ciphertext in the matching `encrypted*` column and recording the
     * Transit key version in the shared `keyVersion`. Mutates in place; no-op
     * per field when empty/null. Only ciphertext persists (Phase 6).
     */
    encryptFieldsIntoEntity(
      this: NamedEntityRepository,
      entity: NamedEntityEntity,
      secrets: SecretsServiceLike,
    ): Promise<void>;

    /** Decrypt all ciphertext columns (ciphertext-only; plaintext dropped in Phase 6). */
    decryptFieldsFromEntity(
      this: NamedEntityRepository,
      entity: NamedEntityEntity,
      secrets: SecretsServiceLike,
    ): Promise<NamedEntityPlaintext>;

    /** findById + decryptFieldsFromEntity in one shot (generic findById never decrypts). */
    findByIdWithDecryptedFields(
      this: NamedEntityRepository,
      id: string,
      secrets: SecretsServiceLike,
    ): Promise<{ entity: NamedEntityEntity; plaintext: NamedEntityPlaintext }>;
  }
}

NamedEntityRepository.prototype.encryptFieldsIntoEntity = async function (
  this: NamedEntityRepository,
  entity: NamedEntityEntity,
  secrets: SecretsServiceLike,
): Promise<void> {
  let keyVersion: number | null = null;

  const text = await encryptStringToCiphertext(secrets, entity.text);
  if (text) {
    entity.encryptedText = text.ciphertext;
    keyVersion = text.keyVersion;
  }

  const normalizedText = await encryptStringToCiphertext(secrets, entity.normalizedText);
  if (normalizedText) {
    entity.encryptedNormalizedText = normalizedText.ciphertext;
    keyVersion = normalizedText.keyVersion;
  }

  const metadata = await encryptJsonToCiphertext(secrets, entity.metadata);
  if (metadata) {
    entity.encryptedMetadata = metadata.ciphertext;
    keyVersion = metadata.keyVersion;
  }

  if (keyVersion !== null) entity.keyVersion = keyVersion;
};

NamedEntityRepository.prototype.decryptFieldsFromEntity = async function (
  this: NamedEntityRepository,
  entity: NamedEntityEntity,
  secrets: SecretsServiceLike,
): Promise<NamedEntityPlaintext> {
  const text = await decryptCiphertextToString(secrets, entity.encryptedText);
  const normalizedText = await decryptCiphertextToString(secrets, entity.encryptedNormalizedText);
  const metadata = await decryptCiphertextToJson(secrets, entity.encryptedMetadata);
  // Plaintext columns dropped; decrypt ciphertext only.
  return { text, normalizedText, metadata };
};

NamedEntityRepository.prototype.findByIdWithDecryptedFields = async function (
  this: NamedEntityRepository,
  id: string,
  secrets: SecretsServiceLike,
): Promise<{ entity: NamedEntityEntity; plaintext: NamedEntityPlaintext }> {
  const entity = await this.findById(id);
  const plaintext = await this.decryptFieldsFromEntity(entity, secrets);
  return { entity, plaintext };
};
