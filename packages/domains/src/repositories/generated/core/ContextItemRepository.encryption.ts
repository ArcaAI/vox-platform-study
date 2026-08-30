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
     * This function owns ONE invariant: after it returns, `encryptedContent`
     * AGREES with `content`. `encryptStringToCiphertext` collapses three
     * different meanings into a single `null`, so they are separated here:
     *
     *   - a non-empty string  → new body: encrypt and store.
     *   - `undefined` / `null` → the caller has no opinion about the body: no-op.
     *     This is how a row reconstituted from columns arrives (the plaintext
     *     `content` column was DROPPED, so there is nothing to hydrate), and
     *     treating it as a deletion would blank the body of every item touched
     *     by a write that never mentioned it.
     *   - `''`                 → the body is now empty: CLEAR `encryptedContent`
     *     and `contentKeyVersion` as a pair.
     *
     * The old contract — *"no-op when `content` is empty/null, so it is safe to
     * call unconditionally"* — stated the bug as a feature: a no-op is only safe
     * on a row that has no ciphertext YET. On a row that already has one, an
     * empty write returned before assigning, so `encryptedContent` never entered
     * `entity.changes` and the UPDATE simply omitted the only column that holds
     * the body — while `currentVersionNumber`/`updatedBy` had already advanced
     * and an immutable `ContextItemVersion` snapshot recording the empty body had
     * already been inserted (TASK-825; same defect as TASK-820 on
     * `DocumentSection`).
     *
     * WHETHER an empty write is ALLOWED is a separate question, answered above
     * this layer: `ContextService.updateContext` refuses one on a
     * `requiresContent` type (mirroring `addContext`), and
     * `HarnessInternalService.persistDraft` skips an empty adoption. This
     * function only guarantees that an empty write which IS allowed is actually
     * PERSISTED.
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
  if (result) {
    entity.encryptedContent = result.ciphertext;
    entity.contentKeyVersion = result.keyVersion;
    return;
  }
  if (entity.content !== '') return;
  entity.encryptedContent = null;
  entity.contentKeyVersion = null;
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
