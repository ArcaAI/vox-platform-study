// Field encryption for
// WorkflowTestFixture (the saved Workbench test `input` JSON payload).
//
// Sibling file mirroring GoldenCaseRepository.encryption.ts /
// SummaryMetaRepository.encryption.ts (declaration merging + prototype patching
// so codegen can re-run with --overwrite). The shared Buffer/ciphertext
// primitives live in common/field-encryption.ts and default to the dedicated
// `hope-phi` Transit key. The plaintext `input` column has been dropped
// (TASK-721 R4); reads decrypt the ciphertext only (no plaintext fallback).

import { WorkflowTestFixtureRepository } from './WorkflowTestFixtureRepository';
import { WorkflowTestFixtureEntity } from '../../../entities';
import { type SecretsServiceLike, encryptJsonToCiphertext, decryptCiphertextToJson } from '../../../common/field-encryption';

/** Plaintext view returned by {@link WorkflowTestFixtureRepository.decryptFieldsFromEntity}. */
export interface WorkflowTestFixturePlaintext {
  input: Record<string, unknown> | null;
}

declare module './WorkflowTestFixtureRepository' {
  interface WorkflowTestFixtureRepository {
    /**
     * Encrypt the JSON `input` payload via Vault Transit (hope-phi), storing the
     * ciphertext in `encryptedInput` and recording the Transit key version in
     * `keyVersion`. Mutates the entity in place; caller persists. No-op when
     * `input` is null/undefined, so it is safe to call unconditionally on a
     * partial row (a PATCH that does not touch `input` leaves the previously
     * persisted ciphertext untouched). The transient plaintext stays in memory
     * for the request; only ciphertext persists.
     */
    encryptFieldsIntoEntity(this: WorkflowTestFixtureRepository, entity: WorkflowTestFixtureEntity, secrets: SecretsServiceLike): Promise<void>;

    /** Decrypt the ciphertext column (ciphertext-only; the plaintext column was dropped). */
    decryptFieldsFromEntity(
      this: WorkflowTestFixtureRepository,
      entity: WorkflowTestFixtureEntity,
      secrets: SecretsServiceLike,
    ): Promise<WorkflowTestFixturePlaintext>;

    /** findById + decryptFieldsFromEntity in one shot (generic findById never decrypts). */
    findByIdWithDecryptedFields(
      this: WorkflowTestFixtureRepository,
      id: string,
      secrets: SecretsServiceLike,
    ): Promise<{ entity: WorkflowTestFixtureEntity; plaintext: WorkflowTestFixturePlaintext }>;
  }
}

WorkflowTestFixtureRepository.prototype.encryptFieldsIntoEntity = async function (
  this: WorkflowTestFixtureRepository,
  entity: WorkflowTestFixtureEntity,
  secrets: SecretsServiceLike,
): Promise<void> {
  const input = await encryptJsonToCiphertext(secrets, entity.input ?? null);
  if (input) {
    entity.encryptedInput = input.ciphertext;
    entity.keyVersion = input.keyVersion;
  }
};

WorkflowTestFixtureRepository.prototype.decryptFieldsFromEntity = async function (
  this: WorkflowTestFixtureRepository,
  entity: WorkflowTestFixtureEntity,
  secrets: SecretsServiceLike,
): Promise<WorkflowTestFixturePlaintext> {
  const input = await decryptCiphertextToJson<Record<string, unknown>>(secrets, entity.encryptedInput);
  // Plaintext column dropped; decrypt ciphertext only.
  return { input };
};

WorkflowTestFixtureRepository.prototype.findByIdWithDecryptedFields = async function (
  this: WorkflowTestFixtureRepository,
  id: string,
  secrets: SecretsServiceLike,
): Promise<{ entity: WorkflowTestFixtureEntity; plaintext: WorkflowTestFixturePlaintext }> {
  const entity = await this.findById(id);
  const plaintext = await this.decryptFieldsFromEntity(entity, secrets);
  return { entity, plaintext };
};
