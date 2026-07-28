// Envelope field encryption for
// AuditLog.data / AuditLog.previousData (the highest-volume write path).
//
// Sibling file mirroring ContextItemRepository.encryption.ts (declaration merging
// + prototype patching so codegen can re-run with --overwrite). UNLIKE the other
// Phase 3 siblings, AuditLog does NOT use the per-field Vault Transit primitives
// in common/field-encryption.ts: a Vault round-trip PER ROW is far too costly for
// the audit hot path. Instead it uses ENVELOPE ENCRYPTION:
//
//   - A Data Encryption Key (DEK) is generated ONCE per process and wrapped ONCE
//     via Vault Transit (hope-phi). The applications-layer AuditLogEncryptionService
//     owns that DEK lifecycle / cache (this domain file must not import
//     @arcaai/applications, and a process-wide key cache does not belong on a
//     repository singleton).
//   - Each row's data / previousData is encrypted LOCALLY with authenticated
//     AES-256-GCM (the hardened CryptoService) under the DEK — ZERO Vault calls
//     on the hot path.
//
// These helpers are therefore PURE and dependency-light: the caller passes the
// already-resolved DEK + a structural crypto handle at call time (same pattern as
// the SecretsServiceLike param used by the other siblings). The wrapped-DEK
// reference + Transit key version are stored per row so a row stays decryptable
// after key rotation.

import { AuditLogRepository } from './AuditLogRepository';
import { AuditLogEntity } from '../../../entities';

/**
 * Structural subset of CryptoService (applications layer) used by the envelope
 * helpers. Declared here so @arcaai/domains never imports @arcaai/applications.
 * `key` must satisfy `Buffer.from(key, 'utf8').length === 32` (AES-256); the
 * AuditLogEncryptionService generates the DEK as a 32-char ASCII string so this
 * holds and the GCM scheme/format stays identical to CryptoService.encrypt().
 */
export interface EnvelopeCryptoLike {
  encrypt(data: string, key: string): Promise<string>;
  decrypt(encryptedData: string, key: string): Promise<string>;
}

/**
 * A resolved Data Encryption Key + its wrapped reference. Produced/cached by the
 * applications-layer AuditLogEncryptionService and threaded into the pure
 * encrypt helper below.
 */
export interface AuditLogDek {
  /** 32-char ASCII DEK usable directly as the AES-256 key for {@link EnvelopeCryptoLike}. */
  dekKey: string;
  /** Vault-Transit-wrapped DEK (`vault:vN:...`), persisted in `AuditLog.dekWrapped`. */
  dekWrapped: string;
  /** Transit key version that wrapped the DEK, persisted in `AuditLog.dekKeyVersion`. */
  dekKeyVersion: number;
}

/** Decrypted payloads returned by {@link AuditLogRepository.decryptEnvelopeFromEntity}. */
export interface AuditLogPlaintextPayloads {
  data: unknown;
  previousData: unknown;
}

declare module './AuditLogRepository' {
  interface AuditLogRepository {
    /**
     * Encrypt the entity's plaintext `data`/`previousData` locally (AES-256-GCM)
     * under the supplied DEK and store the ciphertext in `encryptedData` /
     * `encryptedPreviousData`, plus the wrapped-DEK reference (`dekWrapped`) and
     * Transit key version (`dekKeyVersion`). Mutates the entity in place; caller
     * persists.
     *
     * Plaintext columns are NOT cleared — they are retained for the dual-read
     * soak (removal is Phase 6, user-gated). Empty/`null`/`undefined` payloads
     * are encrypted as `null`/`{}` JSON faithfully (an audit row always carries
     * both columns), so the round-trip is lossless.
     */
    encryptEnvelopeIntoEntity(this: AuditLogRepository, entity: AuditLogEntity, crypto: EnvelopeCryptoLike, dek: AuditLogDek): Promise<void>;

    /**
     * Decrypt `encryptedData`/`encryptedPreviousData` under the supplied (already
     * unwrapped) DEK key and return the parsed payloads. Falls back to the legacy
     * plaintext JSONB columns when the ciphertext is null (historical rows during
     * the dual-read soak). Pure — does not mutate the entity.
     */
    decryptEnvelopeFromEntity(
      this: AuditLogRepository,
      entity: AuditLogEntity,
      crypto: EnvelopeCryptoLike,
      dekKey: string,
    ): Promise<AuditLogPlaintextPayloads>;
  }
}

AuditLogRepository.prototype.encryptEnvelopeIntoEntity = async function (
  this: AuditLogRepository,
  entity: AuditLogEntity,
  crypto: EnvelopeCryptoLike,
  dek: AuditLogDek,
): Promise<void> {
  // JSON.stringify(undefined) is `undefined` (not a string); normalise to null
  // so an absent payload still produces valid, decryptable ciphertext.
  const dataJson = JSON.stringify(entity.data ?? null);
  const prevJson = JSON.stringify(entity.previousData ?? null);

  const encData = await crypto.encrypt(dataJson, dek.dekKey);
  const encPrev = await crypto.encrypt(prevJson, dek.dekKey);

  entity.encryptedData = Buffer.from(encData, 'utf8');
  entity.encryptedPreviousData = Buffer.from(encPrev, 'utf8');
  entity.dekWrapped = dek.dekWrapped;
  entity.dekKeyVersion = dek.dekKeyVersion;
};

AuditLogRepository.prototype.decryptEnvelopeFromEntity = async function (
  this: AuditLogRepository,
  entity: AuditLogEntity,
  crypto: EnvelopeCryptoLike,
  dekKey: string,
): Promise<AuditLogPlaintextPayloads> {
  const data =
    entity.encryptedData && entity.encryptedData.length > 0
      ? JSON.parse(await crypto.decrypt(Buffer.from(entity.encryptedData).toString('utf8'), dekKey))
      : (entity.data ?? null);

  const previousData =
    entity.encryptedPreviousData && entity.encryptedPreviousData.length > 0
      ? JSON.parse(await crypto.decrypt(Buffer.from(entity.encryptedPreviousData).toString('utf8'), dekKey))
      : (entity.previousData ?? null);

  return { data, previousData };
};
