// Field encryption for
// SummaryMeta (citation provenance + guardrail decision JSONB blobs, which can
// echo clinical content / transcript spans).
//
// Sibling file mirroring ContextItemRepository.encryption.ts. Both JSONB fields
// share ONE `keyVersion` column. The plaintext JSONB columns have been dropped;
// reads decrypt the ciphertext only.

import { SummaryMetaRepository } from './SummaryMetaRepository';
import { SummaryMetaEntity } from '../../../entities';
import { type SecretsServiceLike, encryptJsonToCiphertext, decryptCiphertextToJson } from '../../../common/field-encryption';

/** Plaintext view returned by {@link SummaryMetaRepository.decryptFieldsFromEntity}. */
export interface SummaryMetaPlaintext {
  citationsMap: unknown | null;
  guardrailDecisions: unknown | null;
  redactionManifest: unknown | null;
}

declare module './SummaryMetaRepository' {
  interface SummaryMetaRepository {
    /**
     * Encrypt the JSONB provenance blobs via Vault Transit (hope-phi), storing
     * ciphertext in the matching `encrypted*` column and recording the Transit
     * key version in the shared `keyVersion`. Mutates in place; no-op per field
     * when null. Only ciphertext persists (Phase 6).
     */
    encryptFieldsIntoEntity(this: SummaryMetaRepository, entity: SummaryMetaEntity, secrets: SecretsServiceLike): Promise<void>;

    /** Decrypt all ciphertext columns (ciphertext-only; plaintext dropped in Phase 6). */
    decryptFieldsFromEntity(this: SummaryMetaRepository, entity: SummaryMetaEntity, secrets: SecretsServiceLike): Promise<SummaryMetaPlaintext>;

    /** findById + decryptFieldsFromEntity in one shot (generic findById never decrypts). */
    findByIdWithDecryptedFields(
      this: SummaryMetaRepository,
      id: string,
      secrets: SecretsServiceLike,
    ): Promise<{ entity: SummaryMetaEntity; plaintext: SummaryMetaPlaintext }>;
  }
}

SummaryMetaRepository.prototype.encryptFieldsIntoEntity = async function (
  this: SummaryMetaRepository,
  entity: SummaryMetaEntity,
  secrets: SecretsServiceLike,
): Promise<void> {
  let keyVersion: number | null = null;

  const citationsMap = await encryptJsonToCiphertext(secrets, entity.citationsMap);
  if (citationsMap) {
    entity.encryptedCitationsMap = citationsMap.ciphertext;
    keyVersion = citationsMap.keyVersion;
  }

  const guardrailDecisions = await encryptJsonToCiphertext(secrets, entity.guardrailDecisions);
  if (guardrailDecisions) {
    entity.encryptedGuardrailDecisions = guardrailDecisions.ciphertext;
    keyVersion = guardrailDecisions.keyVersion;
  }

  // TASK-551 redaction manifest — same Vault-Transit path; no-op when the
  // transient plaintext is null (so a finalize backfill that never loads it
  // leaves the previously-persisted ciphertext untouched).
  const redactionManifest = await encryptJsonToCiphertext(secrets, entity.redactionManifest);
  if (redactionManifest) {
    entity.encryptedRedactionManifest = redactionManifest.ciphertext;
    keyVersion = redactionManifest.keyVersion;
  }

  if (keyVersion !== null) entity.keyVersion = keyVersion;
};

SummaryMetaRepository.prototype.decryptFieldsFromEntity = async function (
  this: SummaryMetaRepository,
  entity: SummaryMetaEntity,
  secrets: SecretsServiceLike,
): Promise<SummaryMetaPlaintext> {
  const citationsMap = await decryptCiphertextToJson(secrets, entity.encryptedCitationsMap);
  const guardrailDecisions = await decryptCiphertextToJson(secrets, entity.encryptedGuardrailDecisions);
  const redactionManifest = await decryptCiphertextToJson(secrets, entity.encryptedRedactionManifest);
  // Plaintext columns dropped; decrypt ciphertext only.
  return { citationsMap, guardrailDecisions, redactionManifest };
};

SummaryMetaRepository.prototype.findByIdWithDecryptedFields = async function (
  this: SummaryMetaRepository,
  id: string,
  secrets: SecretsServiceLike,
): Promise<{ entity: SummaryMetaEntity; plaintext: SummaryMetaPlaintext }> {
  const entity = await this.findById(id);
  const plaintext = await this.decryptFieldsFromEntity(entity, secrets);
  return { entity, plaintext };
};
