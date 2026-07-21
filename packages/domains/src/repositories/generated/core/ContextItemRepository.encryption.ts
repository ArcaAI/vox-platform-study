// Pilot field encryption on
// ContextItem.content (highest-volume free-text clinical PHI).
//
// Encryption helpers for ContextItemRepository, implemented in a sibling file
// via TS declaration merging + prototype patching so the generated repository
// (src/repositories/generated/core/ContextItemRepository.ts) can be re-run
// with --overwrite without losing this logic.
//
// Design constraints (mirrors GlobalSettingRepository.encryption.ts):
//   - SecretsService is passed as a parameter at call time (NOT constructor
//     injection) — codegen owns the constructor signature.
//   - The shared Buffer/ciphertext/key-version primitives live in
//     `common/field-encryption.ts` (used by every Phase 3 model) and default
//     to the dedicated `hope-phi` Transit key.
//   - The plaintext `content` column has been DROPPED, so
//     decryptContentFromEntity decrypts ciphertext only (the legacy plaintext
//     fallback is gone). It returns `null` when `encryptedContent` is null
//     (legitimately nullable for ATTACHMENT / AUDIO_RECORDING rows). Generic
//     reads now repopulate the transient `content` automatically via the base
//     repository's decrypt-on-read (Vault required at runtime).

import { ContextItemRepository } from './ContextItemRepository';
import { ContextItemEntity } from '../../../entities';
import {
  type SecretsServiceLike,
  encryptStringToCiphertext,
  decryptCiphertextToString,
} from '../../../common/field-encryption';

declare module './ContextItemRepository' {
  interface ContextItemRepository {
    /**
     * Encrypt the entity's plaintext `content` via Vault Transit (hope-phi)
     * and store the ciphertext in `encryptedContent` (+ key version in
     * `contentKeyVersion`). Mutates the entity in place; caller persists.
     *
     * No-op when `content` is empty/null so it is safe to call unconditionally
     * on a not-yet-migrated row.
     */
    encryptContentIntoEntity(
      this: ContextItemRepository,
      entity: ContextItemEntity,
      secrets: SecretsServiceLike,
    ): Promise<void>;

    /**
     * Decrypt `encryptedContent` and return the plaintext string. Returns
     * `null` when `encryptedContent` is null (e.g. media-only context items).
     */
    decryptContentFromEntity(
      this: ContextItemRepository,
      entity: ContextItemEntity,
      secrets: SecretsServiceLike,
    ): Promise<string | null>;

    /**
     * Read-path helper: findById + decryptContentFromEntity in one shot, so
     * callers that genuinely need plaintext don't repeat the two-step. The
     * generic findById is NOT decrypted (no plaintext leakage by default).
     */
    findByIdWithDecryptedContent(
      this: ContextItemRepository,
      id: string,
      secrets: SecretsServiceLike,
    ): Promise<{ entity: ContextItemEntity; plaintext: string | null }>;
  }
}

ContextItemRepository.prototype.encryptContentIntoEntity = async function (
  this: ContextItemRepository,
  entity: ContextItemEntity,
  secrets: SecretsServiceLike,
): Promise<void> {
  const result = await encryptStringToCiphertext(secrets, entity.content);
  if (!result) return;
  entity.encryptedContent = result.ciphertext;
  entity.contentKeyVersion = result.keyVersion;
};

ContextItemRepository.prototype.decryptContentFromEntity = async function (
  this: ContextItemRepository,
  entity: ContextItemEntity,
  secrets: SecretsServiceLike,
): Promise<string | null> {
  return decryptCiphertextToString(secrets, entity.encryptedContent);
};

ContextItemRepository.prototype.findByIdWithDecryptedContent = async function (
  this: ContextItemRepository,
  id: string,
  secrets: SecretsServiceLike,
): Promise<{ entity: ContextItemEntity; plaintext: string | null }> {
  const entity = await this.findById(id);
  const plaintext = await this.decryptContentFromEntity(entity, secrets);
  return { entity, plaintext };
};
