// Field encryption for
// DnaWritingStyleVersion (immutable snapshot: reportData JSONB / styleText).
//
// Sibling file mirroring ContextItemRepository.encryption.ts (declaration
// merging + prototype patching so codegen can re-run with --overwrite). Both
// fields share ONE `keyVersion` column; the shared Buffer/ciphertext
// primitives live in common/field-encryption.ts and default to the dedicated
// `hope-phi` Transit key. The plaintext columns have been dropped; reads
// decrypt the ciphertext only (no plaintext fallback).

import { DnaWritingStyleVersionRepository } from './DnaWritingStyleVersionRepository';
import { DnaWritingStyleVersionEntity } from '../../../entities';
import {
  type SecretsServiceLike,
  encryptStringToCiphertext,
  encryptJsonToCiphertext,
  decryptCiphertextToString,
  decryptCiphertextToJson,
} from '../../../common/field-encryption';

/** Plaintext view returned by {@link DnaWritingStyleVersionRepository.decryptFieldsFromEntity}. */
export interface DnaWritingStyleVersionPlaintext {
  reportData: unknown | null;
  styleText: string | null;
  // TASK-551 — decrypted structured redaction/rewrite rules snapshot.
  redactionRules: unknown | null;
}

declare module './DnaWritingStyleVersionRepository' {
  interface DnaWritingStyleVersionRepository {
    /**
     * Encrypt every populated snapshot field via Vault Transit (hope-phi) and
     * store the ciphertext in the matching `encrypted*` column, recording the
     * Transit key version in the shared `keyVersion`. Mutates the entity in
     * place; caller persists. No-op per field when that field is empty/null, so
     * it is safe to call unconditionally on a partial row. The transient
     * plaintext stays in memory for the request; only ciphertext persists.
     */
    encryptFieldsIntoEntity(
      this: DnaWritingStyleVersionRepository,
      entity: DnaWritingStyleVersionEntity,
      secrets: SecretsServiceLike,
    ): Promise<void>;

    /**
     * Decrypt all ciphertext columns (ciphertext-only; the plaintext columns
     * were dropped in Phase 6).
     */
    decryptFieldsFromEntity(
      this: DnaWritingStyleVersionRepository,
      entity: DnaWritingStyleVersionEntity,
      secrets: SecretsServiceLike,
    ): Promise<DnaWritingStyleVersionPlaintext>;

    /** findById + decryptFieldsFromEntity in one shot (generic findById never decrypts). */
    findByIdWithDecryptedFields(
      this: DnaWritingStyleVersionRepository,
      id: string,
      secrets: SecretsServiceLike,
    ): Promise<{ entity: DnaWritingStyleVersionEntity; plaintext: DnaWritingStyleVersionPlaintext }>;
  }
}

DnaWritingStyleVersionRepository.prototype.encryptFieldsIntoEntity = async function (
  this: DnaWritingStyleVersionRepository,
  entity: DnaWritingStyleVersionEntity,
  secrets: SecretsServiceLike,
): Promise<void> {
  let keyVersion: number | null = null;

  const reportData = await encryptJsonToCiphertext(secrets, entity.reportData);
  if (reportData) {
    entity.encryptedReportData = reportData.ciphertext;
    keyVersion = reportData.keyVersion;
  }

  const styleText = await encryptStringToCiphertext(secrets, entity.styleText);
  if (styleText) {
    entity.encryptedStyleText = styleText.ciphertext;
    keyVersion = styleText.keyVersion;
  }

  const redactionRules = await encryptJsonToCiphertext(secrets, entity.redactionRules);
  if (redactionRules) {
    entity.encryptedRedactionRules = redactionRules.ciphertext;
    keyVersion = redactionRules.keyVersion;
  }

  if (keyVersion !== null) entity.keyVersion = keyVersion;
};

DnaWritingStyleVersionRepository.prototype.decryptFieldsFromEntity = async function (
  this: DnaWritingStyleVersionRepository,
  entity: DnaWritingStyleVersionEntity,
  secrets: SecretsServiceLike,
): Promise<DnaWritingStyleVersionPlaintext> {
  const reportData = await decryptCiphertextToJson(secrets, entity.encryptedReportData);
  const styleText = await decryptCiphertextToString(secrets, entity.encryptedStyleText);
  const redactionRules = await decryptCiphertextToJson(secrets, entity.encryptedRedactionRules);
  // Plaintext columns dropped; decrypt ciphertext only.
  return { reportData, styleText, redactionRules };
};

DnaWritingStyleVersionRepository.prototype.findByIdWithDecryptedFields = async function (
  this: DnaWritingStyleVersionRepository,
  id: string,
  secrets: SecretsServiceLike,
): Promise<{ entity: DnaWritingStyleVersionEntity; plaintext: DnaWritingStyleVersionPlaintext }> {
  const entity = await this.findById(id);
  const plaintext = await this.decryptFieldsFromEntity(entity, secrets);
  return { entity, plaintext };
};
