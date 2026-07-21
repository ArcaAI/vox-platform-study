// Field encryption for the
// append-only, hash-chained WORM table HarnessAuditEvent (sensorScores /
// citations JSONB).
//
// Sibling file mirroring EvalScoreRepository.encryption.ts (declaration merging +
// prototype patching so codegen can re-run with --overwrite). The shared
// Buffer/ciphertext primitives live in common/field-encryption.ts and default to
// the dedicated `hope-phi` Transit key.
//
// IMMUTABILITY NOTE — unlike the mutable-table siblings, this does NOT mutate the
// entity (HarnessAuditEvent has read-only getters / no setters). Encryption must
// happen BEFORE the row is built so the factory can hash over the ciphertext
// (ENCRYPT-BEFORE-HASH); `encryptPayloads` therefore returns the ciphertext for
// the service to thread into `HarnessAuditEventFactory.CreateHarnessAuditEvent`.

import { HarnessAuditEventRepository } from './HarnessAuditEventRepository';
import { HarnessAuditEventEntity } from '../../../entities';
import { type SecretsServiceLike, encryptJsonToCiphertext, decryptCiphertextToJson } from '../../../common/field-encryption';

/** Ciphertext + key version produced by {@link HarnessAuditEventRepository.encryptPayloads}. */
export interface HarnessAuditEventEncryptedPayloads {
  encryptedSensorScores: Buffer | null;
  encryptedCitations: Buffer | null;
  keyVersion: number | null;
}

/** Decrypted view returned by {@link HarnessAuditEventRepository.decryptPayloadsFromEntity}. */
export interface HarnessAuditEventPlaintext {
  sensorScores: unknown;
  citations: unknown;
}

declare module './HarnessAuditEventRepository' {
  interface HarnessAuditEventRepository {
    /**
     * Encrypt the `sensorScores`/`citations` JSON payloads via Vault Transit
     * (hope-phi) and return the ciphertext Buffers + the shared Transit key
     * version. Pure (does not touch the DB or any entity) so the caller can pass
     * the ciphertext to the factory BEFORE the integrity hash is computed
     * (encrypt-before-hash). A null/undefined payload yields a null ciphertext.
     */
    encryptPayloads(
      this: HarnessAuditEventRepository,
      secrets: SecretsServiceLike,
      sensorScores: unknown,
      citations: unknown,
    ): Promise<HarnessAuditEventEncryptedPayloads>;

    /**
     * Decrypt an event's ciphertext payloads, each falling back to its plaintext
     * JSONB column when the ciphertext is null (legacy rows) — for read/display
     * surfaces. On an encrypted row the plaintext column holds only a redaction
     * sentinel, so this is the canonical way to read the real payload back.
     */
    decryptPayloadsFromEntity(
      this: HarnessAuditEventRepository,
      entity: HarnessAuditEventEntity,
      secrets: SecretsServiceLike,
    ): Promise<HarnessAuditEventPlaintext>;
  }
}

HarnessAuditEventRepository.prototype.encryptPayloads = async function (
  this: HarnessAuditEventRepository,
  secrets: SecretsServiceLike,
  sensorScores: unknown,
  citations: unknown,
): Promise<HarnessAuditEventEncryptedPayloads> {
  let keyVersion: number | null = null;

  const ss = await encryptJsonToCiphertext(secrets, sensorScores ?? null);
  if (ss) keyVersion = ss.keyVersion;

  const ct = await encryptJsonToCiphertext(secrets, citations ?? null);
  if (ct) keyVersion = ct.keyVersion;

  return {
    encryptedSensorScores: ss?.ciphertext ?? null,
    encryptedCitations: ct?.ciphertext ?? null,
    keyVersion,
  };
};

HarnessAuditEventRepository.prototype.decryptPayloadsFromEntity = async function (
  this: HarnessAuditEventRepository,
  entity: HarnessAuditEventEntity,
  secrets: SecretsServiceLike,
): Promise<HarnessAuditEventPlaintext> {
  const sensorScores = await decryptCiphertextToJson(secrets, entity.encryptedSensorScores);
  const citations = await decryptCiphertextToJson(secrets, entity.encryptedCitations);
  return {
    sensorScores: sensorScores !== null ? sensorScores : (entity.sensorScores ?? null),
    citations: citations !== null ? citations : (entity.citations ?? null),
  };
};
