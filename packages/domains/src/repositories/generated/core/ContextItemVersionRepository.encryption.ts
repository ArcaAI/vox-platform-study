// TASK-369 (Data Encryption Initiative) Phase 3C — field encryption for
// ContextItemVersion (immutable content snapshots: content / contentDiff /
// changeSummary / fieldChanges).
//
// Sibling file mirroring ContextItemRepository.encryption.ts (declaration
// merging + prototype patching so codegen can re-run with --overwrite). All
// four fields share ONE `keyVersion` column; the shared Buffer/ciphertext
// primitives live in common/field-encryption.ts and default to the dedicated
// `hope-phi` Transit key. Plaintext columns are retained for the dual-read
// soak — decrypt helpers fall back to plaintext when the ciphertext is null.

import { ContextItemVersionRepository } from './ContextItemVersionRepository';
import { ContextItemVersionEntity } from '../../../entities';
import {
  type SecretsServiceLike,
  encryptStringToCiphertext,
  encryptJsonToCiphertext,
  decryptCiphertextToString,
  decryptCiphertextToJson,
} from '../../../common/field-encryption';

/** Plaintext view returned by {@link ContextItemVersionRepository.decryptFieldsFromEntity}. */
export interface ContextItemVersionPlaintext {
  content: string | null;
  contentDiff: string | null;
  changeSummary: string | null;
  fieldChanges: unknown | null;
}

declare module './ContextItemVersionRepository' {
  interface ContextItemVersionRepository {
    /**
     * Encrypt every populated free-text snapshot field via Vault Transit
     * (hope-phi) and store the ciphertext in the matching `encrypted*` column,
     * recording the Transit key version in the shared `keyVersion`. Mutates the
     * entity in place; caller persists. No-op per field when that field is
     * empty/null, so it is safe to call unconditionally on a partial row. Does
     * NOT clear plaintext — retained for the dual-read soak (Phase 6 cleanup).
     */
    encryptFieldsIntoEntity(
      this: ContextItemVersionRepository,
      entity: ContextItemVersionEntity,
      secrets: SecretsServiceLike,
    ): Promise<void>;

    /**
     * Decrypt all ciphertext columns, each falling back to its legacy plaintext
     * column when the ciphertext is null (dual-read soak bridge).
     */
    decryptFieldsFromEntity(
      this: ContextItemVersionRepository,
      entity: ContextItemVersionEntity,
      secrets: SecretsServiceLike,
    ): Promise<ContextItemVersionPlaintext>;

    /** findById + decryptFieldsFromEntity in one shot (generic findById never decrypts). */
    findByIdWithDecryptedFields(
      this: ContextItemVersionRepository,
      id: string,
      secrets: SecretsServiceLike,
    ): Promise<{ entity: ContextItemVersionEntity; plaintext: ContextItemVersionPlaintext }>;
  }
}

ContextItemVersionRepository.prototype.encryptFieldsIntoEntity = async function (
  this: ContextItemVersionRepository,
  entity: ContextItemVersionEntity,
  secrets: SecretsServiceLike,
): Promise<void> {
  let keyVersion: number | null = null;

  const content = await encryptStringToCiphertext(secrets, entity.content);
  if (content) {
    entity.encryptedContent = content.ciphertext;
    keyVersion = content.keyVersion;
  }

  const contentDiff = await encryptStringToCiphertext(secrets, entity.contentDiff);
  if (contentDiff) {
    entity.encryptedContentDiff = contentDiff.ciphertext;
    keyVersion = contentDiff.keyVersion;
  }

  const changeSummary = await encryptStringToCiphertext(secrets, entity.changeSummary);
  if (changeSummary) {
    entity.encryptedChangeSummary = changeSummary.ciphertext;
    keyVersion = changeSummary.keyVersion;
  }

  const fieldChanges = await encryptJsonToCiphertext(secrets, entity.fieldChanges);
  if (fieldChanges) {
    entity.encryptedFieldChanges = fieldChanges.ciphertext;
    keyVersion = fieldChanges.keyVersion;
  }

  if (keyVersion !== null) entity.keyVersion = keyVersion;
};

ContextItemVersionRepository.prototype.decryptFieldsFromEntity = async function (
  this: ContextItemVersionRepository,
  entity: ContextItemVersionEntity,
  secrets: SecretsServiceLike,
): Promise<ContextItemVersionPlaintext> {
  const content = await decryptCiphertextToString(secrets, entity.encryptedContent);
  const contentDiff = await decryptCiphertextToString(secrets, entity.encryptedContentDiff);
  const changeSummary = await decryptCiphertextToString(secrets, entity.encryptedChangeSummary);
  const fieldChanges = await decryptCiphertextToJson(secrets, entity.encryptedFieldChanges);
  return {
    content: content !== null ? content : (entity.content ?? null),
    contentDiff: contentDiff !== null ? contentDiff : (entity.contentDiff ?? null),
    changeSummary: changeSummary !== null ? changeSummary : (entity.changeSummary ?? null),
    fieldChanges: fieldChanges !== null ? fieldChanges : (entity.fieldChanges ?? null),
  };
};

ContextItemVersionRepository.prototype.findByIdWithDecryptedFields = async function (
  this: ContextItemVersionRepository,
  id: string,
  secrets: SecretsServiceLike,
): Promise<{ entity: ContextItemVersionEntity; plaintext: ContextItemVersionPlaintext }> {
  const entity = await this.findById(id);
  const plaintext = await this.decryptFieldsFromEntity(entity, secrets);
  return { entity, plaintext };
};
