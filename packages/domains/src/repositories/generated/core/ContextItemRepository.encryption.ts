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
import { type SecretsServiceLike, encryptStringToCiphertext, decryptCiphertextToString } from '../../../common/field-encryption';

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
    encryptContentIntoEntity(this: ContextItemRepository, entity: ContextItemEntity, secrets: SecretsServiceLike): Promise<void>;

    /**
     * Decrypt `encryptedContent` and return the plaintext string. Returns
     * `null` when `encryptedContent` is null (e.g. media-only context items).
     */
    decryptContentFromEntity(this: ContextItemRepository, entity: ContextItemEntity, secrets: SecretsServiceLike): Promise<string | null>;

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

    /**
     * Read-path helper for the warm-start lookup (B-02 / B-06): finds the
     * latest PRE_SUMMARY for a consultation, optionally scoped to a
     * `metaData.subType` value (e.g. 'LIVE_SOAP_SNAPSHOT'), and decrypts its
     * content via `decryptContentFromEntity`.
     *
     * B-02: the plain `findLatestPreSummary` finder never decrypts —
     * consumers reading `.content` off its result got empty text unless the
     * process-wide decrypt-on-read wrap (`phi-read-decrypt.ts`) happened to be
     * wired; this helper decrypts explicitly so the read is correct
     * independent of that global wiring.
     *
     * B-06: `findLatestPreSummary` is not subType-aware, so a case-notes
     * PRE_SUMMARY created after a LIVE_SOAP_SNAPSHOT would shadow it. The
     * optional `subType` filter mirrors harness's `loadLiveSoapSnapshot`
     * in-memory-filter idiom (fetch all pre-summaries, filter, pick newest by
     * createdAt) rather than a DB-side JSON query. Omitting `subType`
     * preserves the legacy "latest pre-summary of any kind" behavior.
     *
     * `secrets` may be omitted (mirrors the write-side `encryptPhiFields`
     * soft no-op in dev/test): the entity's transient `content` — already
     * populated by decrypt-on-read when Vault mode is wired — is returned
     * as-is rather than throwing.
     */
    findLatestPreSummaryWithDecryptedContent(
      this: ContextItemRepository,
      consultationId: string,
      secrets: SecretsServiceLike | undefined,
      options?: { subType?: string },
    ): Promise<{ entity: ContextItemEntity | null; plaintext: string | null }>;
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

ContextItemRepository.prototype.findLatestPreSummaryWithDecryptedContent = async function (
  this: ContextItemRepository,
  consultationId: string,
  secrets: SecretsServiceLike | undefined,
  options?: { subType?: string },
): Promise<{ entity: ContextItemEntity | null; plaintext: string | null }> {
  const preSummaries = await this.findPreSummaries(consultationId);
  const candidates = options?.subType
    ? preSummaries.filter((p) => (p.metaData as Record<string, unknown> | undefined)?.subType === options.subType)
    : preSummaries;
  if (candidates.length === 0) return { entity: null, plaintext: null };

  const entity = candidates.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
  const plaintext = secrets ? await this.decryptContentFromEntity(entity, secrets) : (entity.content ?? null);
  return { entity, plaintext };
};
