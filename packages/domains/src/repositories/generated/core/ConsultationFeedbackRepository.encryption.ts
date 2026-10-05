// Field encryption for ConsultationFeedback (the free-text clinician comment).
// Sibling file in the HighlightRepository.encryption.ts shape (declaration
// merging + prototype patching). `comment` is a transient entity field; only
// `encryptedComment` (+ `keyVersion`) persists.

import { ConsultationFeedbackRepository } from './ConsultationFeedbackRepository';
import { ConsultationFeedbackEntity } from '../../../entities';
import { type SecretsServiceLike, encryptStringToCiphertext, decryptCiphertextToString } from '../../../common/field-encryption';

declare module './ConsultationFeedbackRepository' {
  interface ConsultationFeedbackRepository {
    /**
     * Encrypt the transient `comment` via Vault Transit (hope-phi) into
     * `encryptedComment` (+ `keyVersion`). Mutates in place; no-op when the
     * comment is empty.
     */
    encryptFieldsIntoEntity(this: ConsultationFeedbackRepository, entity: ConsultationFeedbackEntity, secrets: SecretsServiceLike): Promise<void>;

    /** Decrypt `encryptedComment` into the transient `comment` and return it (`null` when none). */
    decryptFieldsFromEntity(
      this: ConsultationFeedbackRepository,
      entity: ConsultationFeedbackEntity,
      secrets: SecretsServiceLike,
    ): Promise<string | null>;
  }
}

ConsultationFeedbackRepository.prototype.encryptFieldsIntoEntity = async function (
  this: ConsultationFeedbackRepository,
  entity: ConsultationFeedbackEntity,
  secrets: SecretsServiceLike,
): Promise<void> {
  const comment = await encryptStringToCiphertext(secrets, entity.comment);
  if (!comment) return;
  entity.encryptedComment = comment.ciphertext;
  entity.keyVersion = comment.keyVersion;
};

ConsultationFeedbackRepository.prototype.decryptFieldsFromEntity = async function (
  this: ConsultationFeedbackRepository,
  entity: ConsultationFeedbackEntity,
  secrets: SecretsServiceLike,
): Promise<string | null> {
  const comment = await decryptCiphertextToString(secrets, entity.encryptedComment);
  entity.comment = comment;
  return comment;
};
