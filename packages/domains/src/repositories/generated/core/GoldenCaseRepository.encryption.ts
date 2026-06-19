// TASK-369 (Data Encryption Initiative) Phase 3C — field encryption for
// GoldenCase (free-text clinical fields: transcript / referenceNote).
//
// Sibling file mirroring ContextItemVersionRepository.encryption.ts (declaration
// merging + prototype patching so codegen can re-run with --overwrite). Both
// fields share ONE `keyVersion` column; the shared Buffer/ciphertext primitives
// live in common/field-encryption.ts and default to the dedicated `hope-phi`
// Transit key. TASK-369 Phase 6 dropped the plaintext columns; reads decrypt the
// ciphertext only (no plaintext fallback).

import { GoldenCaseRepository } from './GoldenCaseRepository';
import { GoldenCaseEntity } from '../../../entities';
import {
  type SecretsServiceLike,
  encryptStringToCiphertext,
  decryptCiphertextToString,
} from '../../../common/field-encryption';

/** Plaintext view returned by {@link GoldenCaseRepository.decryptFieldsFromEntity}. */
export interface GoldenCasePlaintext {
  transcript: string | null;
  referenceNote: string | null;
}

declare module './GoldenCaseRepository' {
  interface GoldenCaseRepository {
    /**
     * Encrypt every populated free-text field via Vault Transit (hope-phi) and
     * store the ciphertext in the matching `encrypted*` column, recording the
     * Transit key version in the shared `keyVersion`. Mutates the entity in
     * place; caller persists. No-op per field when that field is empty/null, so
     * it is safe to call unconditionally on a partial row. The transient
     * plaintext stays in memory for the request; only ciphertext persists.
     */
    encryptFieldsIntoEntity(
      this: GoldenCaseRepository,
      entity: GoldenCaseEntity,
      secrets: SecretsServiceLike,
    ): Promise<void>;

    /**
     * Decrypt all ciphertext columns (ciphertext-only; the plaintext columns
     * were dropped in Phase 6).
     */
    decryptFieldsFromEntity(
      this: GoldenCaseRepository,
      entity: GoldenCaseEntity,
      secrets: SecretsServiceLike,
    ): Promise<GoldenCasePlaintext>;

    /** findById + decryptFieldsFromEntity in one shot (generic findById never decrypts). */
    findByIdWithDecryptedFields(
      this: GoldenCaseRepository,
      id: string,
      secrets: SecretsServiceLike,
    ): Promise<{ entity: GoldenCaseEntity; plaintext: GoldenCasePlaintext }>;
  }
}

GoldenCaseRepository.prototype.encryptFieldsIntoEntity = async function (
  this: GoldenCaseRepository,
  entity: GoldenCaseEntity,
  secrets: SecretsServiceLike,
): Promise<void> {
  let keyVersion: number | null = null;

  const transcript = await encryptStringToCiphertext(secrets, entity.transcript);
  if (transcript) {
    entity.encryptedTranscript = transcript.ciphertext;
    keyVersion = transcript.keyVersion;
  }

  const referenceNote = await encryptStringToCiphertext(secrets, entity.referenceNote);
  if (referenceNote) {
    entity.encryptedReferenceNote = referenceNote.ciphertext;
    keyVersion = referenceNote.keyVersion;
  }

  if (keyVersion !== null) entity.keyVersion = keyVersion;
};

GoldenCaseRepository.prototype.decryptFieldsFromEntity = async function (
  this: GoldenCaseRepository,
  entity: GoldenCaseEntity,
  secrets: SecretsServiceLike,
): Promise<GoldenCasePlaintext> {
  const transcript = await decryptCiphertextToString(secrets, entity.encryptedTranscript);
  const referenceNote = await decryptCiphertextToString(secrets, entity.encryptedReferenceNote);
  // TASK-369 Phase 6 — plaintext columns dropped; decrypt ciphertext only.
  return { transcript, referenceNote };
};

GoldenCaseRepository.prototype.findByIdWithDecryptedFields = async function (
  this: GoldenCaseRepository,
  id: string,
  secrets: SecretsServiceLike,
): Promise<{ entity: GoldenCaseEntity; plaintext: GoldenCasePlaintext }> {
  const entity = await this.findById(id);
  const plaintext = await this.decryptFieldsFromEntity(entity, secrets);
  return { entity, plaintext };
};
