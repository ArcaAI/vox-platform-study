// Field encryption for
// Notification (messageText / messageRichText free-text + messageContent JSONB).
//
// Sibling file mirroring ContextItemVersionRepository.encryption.ts. All three
// fields share ONE `keyVersion` column; the shared Buffer/ciphertext primitives
// live in common/field-encryption.ts and default to the dedicated `hope-phi`
// Transit key. The plaintext columns have been dropped; reads decrypt the
// ciphertext only (no plaintext fallback).

import { NotificationRepository } from './NotificationRepository';
import { NotificationEntity } from '../../../entities';
import {
  type SecretsServiceLike,
  encryptStringToCiphertext,
  encryptJsonToCiphertext,
  decryptCiphertextToString,
  decryptCiphertextToJson,
} from '../../../common/field-encryption';

/** Plaintext view returned by {@link NotificationRepository.decryptFieldsFromEntity}. */
export interface NotificationPlaintext {
  messageText: string | null;
  messageRichText: string | null;
  messageContent: unknown | null;
}

declare module './NotificationRepository' {
  interface NotificationRepository {
    /**
     * Encrypt every populated message field via Vault Transit (hope-phi) and
     * store the ciphertext in the matching `encrypted*` column, recording the
     * Transit key version in the shared `keyVersion`. Mutates the entity in
     * place; caller persists. No-op per field when that field is empty/null, so
     * it is safe to call unconditionally on a partial row. The transient
     * plaintext stays in memory for the request; only ciphertext persists.
     */
    encryptFieldsIntoEntity(
      this: NotificationRepository,
      entity: NotificationEntity,
      secrets: SecretsServiceLike,
    ): Promise<void>;

    /**
     * Decrypt all ciphertext columns (ciphertext-only; the plaintext columns
     * were dropped in Phase 6).
     */
    decryptFieldsFromEntity(
      this: NotificationRepository,
      entity: NotificationEntity,
      secrets: SecretsServiceLike,
    ): Promise<NotificationPlaintext>;

    /** findById + decryptFieldsFromEntity in one shot (generic findById never decrypts). */
    findByIdWithDecryptedFields(
      this: NotificationRepository,
      id: string,
      secrets: SecretsServiceLike,
    ): Promise<{ entity: NotificationEntity; plaintext: NotificationPlaintext }>;
  }
}

NotificationRepository.prototype.encryptFieldsIntoEntity = async function (
  this: NotificationRepository,
  entity: NotificationEntity,
  secrets: SecretsServiceLike,
): Promise<void> {
  let keyVersion: number | null = null;

  const messageText = await encryptStringToCiphertext(secrets, entity.messageText);
  if (messageText) {
    entity.encryptedMessageText = messageText.ciphertext;
    keyVersion = messageText.keyVersion;
  }

  const messageRichText = await encryptStringToCiphertext(secrets, entity.messageRichText);
  if (messageRichText) {
    entity.encryptedMessageRichText = messageRichText.ciphertext;
    keyVersion = messageRichText.keyVersion;
  }

  const messageContent = await encryptJsonToCiphertext(secrets, entity.messageContent);
  if (messageContent) {
    entity.encryptedMessageContent = messageContent.ciphertext;
    keyVersion = messageContent.keyVersion;
  }

  if (keyVersion !== null) entity.keyVersion = keyVersion;
};

NotificationRepository.prototype.decryptFieldsFromEntity = async function (
  this: NotificationRepository,
  entity: NotificationEntity,
  secrets: SecretsServiceLike,
): Promise<NotificationPlaintext> {
  const messageText = await decryptCiphertextToString(secrets, entity.encryptedMessageText);
  const messageRichText = await decryptCiphertextToString(secrets, entity.encryptedMessageRichText);
  const messageContent = await decryptCiphertextToJson(secrets, entity.encryptedMessageContent);
  // Plaintext columns dropped; decrypt ciphertext only.
  return { messageText, messageRichText, messageContent };
};

NotificationRepository.prototype.findByIdWithDecryptedFields = async function (
  this: NotificationRepository,
  id: string,
  secrets: SecretsServiceLike,
): Promise<{ entity: NotificationEntity; plaintext: NotificationPlaintext }> {
  const entity = await this.findById(id);
  const plaintext = await this.decryptFieldsFromEntity(entity, secrets);
  return { entity, plaintext };
};
