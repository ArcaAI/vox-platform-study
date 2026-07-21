// Field encryption for
// EvalRun (free-text clinical field: notes).
//
// Sibling file mirroring ContextItemVersionRepository.encryption.ts (declaration
// merging + prototype patching so codegen can re-run with --overwrite). The
// field records its Transit key version in the shared `keyVersion`; the shared
// Buffer/ciphertext primitives live in common/field-encryption.ts and default
// to the dedicated `hope-phi` Transit key. The plaintext
// columns have been dropped; reads decrypt the ciphertext only (no plaintext fallback).

import { EvalRunRepository } from './EvalRunRepository';
import { EvalRunEntity } from '../../../entities';
import {
  type SecretsServiceLike,
  encryptStringToCiphertext,
  decryptCiphertextToString,
} from '../../../common/field-encryption';

/** Plaintext view returned by {@link EvalRunRepository.decryptFieldsFromEntity}. */
export interface EvalRunPlaintext {
  notes: string | null;
}

declare module './EvalRunRepository' {
  interface EvalRunRepository {
    /**
     * Encrypt every populated free-text field via Vault Transit (hope-phi) and
     * store the ciphertext in the matching `encrypted*` column, recording the
     * Transit key version in the shared `keyVersion`. Mutates the entity in
     * place; caller persists. No-op per field when that field is empty/null, so
     * it is safe to call unconditionally on a partial row. The transient
     * plaintext stays in memory for the request; only ciphertext persists.
     */
    encryptFieldsIntoEntity(
      this: EvalRunRepository,
      entity: EvalRunEntity,
      secrets: SecretsServiceLike,
    ): Promise<void>;

    /**
     * Decrypt all ciphertext columns (ciphertext-only; the plaintext columns
     * were dropped in Phase 6).
     */
    decryptFieldsFromEntity(
      this: EvalRunRepository,
      entity: EvalRunEntity,
      secrets: SecretsServiceLike,
    ): Promise<EvalRunPlaintext>;

    /** findById + decryptFieldsFromEntity in one shot (generic findById never decrypts). */
    findByIdWithDecryptedFields(
      this: EvalRunRepository,
      id: string,
      secrets: SecretsServiceLike,
    ): Promise<{ entity: EvalRunEntity; plaintext: EvalRunPlaintext }>;
  }
}

EvalRunRepository.prototype.encryptFieldsIntoEntity = async function (
  this: EvalRunRepository,
  entity: EvalRunEntity,
  secrets: SecretsServiceLike,
): Promise<void> {
  let keyVersion: number | null = null;

  const notes = await encryptStringToCiphertext(secrets, entity.notes);
  if (notes) {
    entity.encryptedNotes = notes.ciphertext;
    keyVersion = notes.keyVersion;
  }

  if (keyVersion !== null) entity.keyVersion = keyVersion;
};

EvalRunRepository.prototype.decryptFieldsFromEntity = async function (
  this: EvalRunRepository,
  entity: EvalRunEntity,
  secrets: SecretsServiceLike,
): Promise<EvalRunPlaintext> {
  const notes = await decryptCiphertextToString(secrets, entity.encryptedNotes);
  // Plaintext column dropped; decrypt ciphertext only.
  return { notes };
};

EvalRunRepository.prototype.findByIdWithDecryptedFields = async function (
  this: EvalRunRepository,
  id: string,
  secrets: SecretsServiceLike,
): Promise<{ entity: EvalRunEntity; plaintext: EvalRunPlaintext }> {
  const entity = await this.findById(id);
  const plaintext = await this.decryptFieldsFromEntity(entity, secrets);
  return { entity, plaintext };
};
