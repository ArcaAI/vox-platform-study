// TASK-369 (Data Encryption Initiative) Phase 3C — field encryption for
// DnaWritingStyleReport (writing-style report: reportData JSONB / styleText).
//
// Sibling file mirroring ContextItemRepository.encryption.ts (declaration
// merging + prototype patching so codegen can re-run with --overwrite). Both
// fields share ONE `keyVersion` column; the shared Buffer/ciphertext
// primitives live in common/field-encryption.ts and default to the dedicated
// `hope-phi` Transit key. TASK-369 Phase 6 dropped the plaintext columns; reads
// decrypt the ciphertext only (no plaintext fallback).

import { DnaWritingStyleReportRepository } from './DnaWritingStyleReportRepository';
import { DnaWritingStyleReportEntity } from '../../../entities';
import {
  type SecretsServiceLike,
  encryptStringToCiphertext,
  encryptJsonToCiphertext,
  decryptCiphertextToString,
  decryptCiphertextToJson,
} from '../../../common/field-encryption';

/** Plaintext view returned by {@link DnaWritingStyleReportRepository.decryptFieldsFromEntity}. */
export interface DnaWritingStyleReportPlaintext {
  reportData: unknown | null;
  styleText: string | null;
}

declare module './DnaWritingStyleReportRepository' {
  interface DnaWritingStyleReportRepository {
    /**
     * Encrypt every populated writing-style field via Vault Transit (hope-phi)
     * and store the ciphertext in the matching `encrypted*` column, recording
     * the Transit key version in the shared `keyVersion`. Mutates the entity in
     * place; caller persists. No-op per field when that field is empty/null, so
     * it is safe to call unconditionally on a partial row. The transient
     * plaintext stays in memory for the request; only ciphertext persists.
     */
    encryptFieldsIntoEntity(
      this: DnaWritingStyleReportRepository,
      entity: DnaWritingStyleReportEntity,
      secrets: SecretsServiceLike,
    ): Promise<void>;

    /**
     * Decrypt all ciphertext columns (ciphertext-only; the plaintext columns
     * were dropped in Phase 6).
     */
    decryptFieldsFromEntity(
      this: DnaWritingStyleReportRepository,
      entity: DnaWritingStyleReportEntity,
      secrets: SecretsServiceLike,
    ): Promise<DnaWritingStyleReportPlaintext>;

    /** findById + decryptFieldsFromEntity in one shot (generic findById never decrypts). */
    findByIdWithDecryptedFields(
      this: DnaWritingStyleReportRepository,
      id: string,
      secrets: SecretsServiceLike,
    ): Promise<{ entity: DnaWritingStyleReportEntity; plaintext: DnaWritingStyleReportPlaintext }>;
  }
}

DnaWritingStyleReportRepository.prototype.encryptFieldsIntoEntity = async function (
  this: DnaWritingStyleReportRepository,
  entity: DnaWritingStyleReportEntity,
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

  if (keyVersion !== null) entity.keyVersion = keyVersion;
};

DnaWritingStyleReportRepository.prototype.decryptFieldsFromEntity = async function (
  this: DnaWritingStyleReportRepository,
  entity: DnaWritingStyleReportEntity,
  secrets: SecretsServiceLike,
): Promise<DnaWritingStyleReportPlaintext> {
  const reportData = await decryptCiphertextToJson(secrets, entity.encryptedReportData);
  const styleText = await decryptCiphertextToString(secrets, entity.encryptedStyleText);
  // TASK-369 Phase 6 — plaintext columns dropped; decrypt ciphertext only.
  return { reportData, styleText };
};

DnaWritingStyleReportRepository.prototype.findByIdWithDecryptedFields = async function (
  this: DnaWritingStyleReportRepository,
  id: string,
  secrets: SecretsServiceLike,
): Promise<{ entity: DnaWritingStyleReportEntity; plaintext: DnaWritingStyleReportPlaintext }> {
  const entity = await this.findById(id);
  const plaintext = await this.decryptFieldsFromEntity(entity, secrets);
  return { entity, plaintext };
};
