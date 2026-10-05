// Field encryption for ConsultationAttachment (the original file name, which
// is PHI-prone). Sibling file in the HighlightRepository.encryption.ts shape
// (declaration merging + prototype patching). Ciphertext only persists, in
// `encryptedFileName` with the Transit key version in `keyVersion`.

import { ConsultationAttachmentRepository } from './ConsultationAttachmentRepository';
import { ConsultationAttachmentEntity } from '../../../entities';
import { type SecretsServiceLike, encryptStringToCiphertext, decryptCiphertextToString } from '../../../common/field-encryption';

declare module './ConsultationAttachmentRepository' {
  interface ConsultationAttachmentRepository {
    /**
     * Encrypt `fileName` via Vault Transit (hope-phi) into `encryptedFileName`
     * (+ `keyVersion`). Mutates the entity in place; no-op for an empty name.
     */
    encryptFileNameIntoEntity(
      this: ConsultationAttachmentRepository,
      entity: ConsultationAttachmentEntity,
      fileName: string | null | undefined,
      secrets: SecretsServiceLike,
    ): Promise<void>;

    /** Decrypt `encryptedFileName`; `null` when none was stored. */
    decryptFileName(
      this: ConsultationAttachmentRepository,
      entity: ConsultationAttachmentEntity,
      secrets: SecretsServiceLike,
    ): Promise<string | null>;
  }
}

ConsultationAttachmentRepository.prototype.encryptFileNameIntoEntity = async function (
  this: ConsultationAttachmentRepository,
  entity: ConsultationAttachmentEntity,
  fileName: string | null | undefined,
  secrets: SecretsServiceLike,
): Promise<void> {
  const encrypted = await encryptStringToCiphertext(secrets, fileName);
  if (!encrypted) return;
  entity.encryptedFileName = encrypted.ciphertext;
  entity.keyVersion = encrypted.keyVersion;
};

ConsultationAttachmentRepository.prototype.decryptFileName = async function (
  this: ConsultationAttachmentRepository,
  entity: ConsultationAttachmentEntity,
  secrets: SecretsServiceLike,
): Promise<string | null> {
  return decryptCiphertextToString(secrets, entity.encryptedFileName);
};
