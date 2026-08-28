import { Injectable } from '@nestjs/common';
import { DataNotFoundException } from '@arcaai/exceptions';

import { Repository } from '../../../common';
import { DocumentSectionEntityMapper } from '../../../mappers';
import { DocumentSectionEntity } from '../../../entities';
import { DocumentSection } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { type SecretsServiceLike, encryptStringToCiphertext, decryptCiphertextToString } from '../../../common/field-encryption';

/**
 * TASK-811 (OD-7) — per-section rows of a live-generated clinical document.
 *
 * POSTURE, deliberately mirroring `TranscriptSegmentRepository`:
 * `DocumentSection` is TENANT-SCOPED per-consultation annotation and is EXEMPT
 * from SOFT-DELETE — it is listed in MODELS_WITHOUT_SOFT_DELETE and has no
 * `resourceStatus` column, so `softDelete()`/`restore()` throw. Sections live
 * and die with their consultation's document; emptying one is a CONTENT update
 * under the section state machine (which additionally requires a transcript
 * contradiction), never a row delete. Cross-tenant isolation is enforced
 * upstream by the shared tenant-scope `$extends` (whose drift guard lists
 * DocumentSection); every finder here is additionally scoped by `tenantId`.
 *
 * WHERE THE OCC LIVES: nowhere new. `updateWithVersion(id, entity, expected)` on
 * the base repository already implements the compare-and-set this model needs —
 * what this table adds is that the `_version` being compared is PER SECTION, so
 * a flush writing `assessment` and a clinician editing `plan` never contend.
 *
 * The encryption helpers are declared inline rather than in a sibling
 * `.encryption.ts` file (the `ContextItemRepository` pattern): that split exists
 * so codegen can re-run `--overwrite` without losing the logic, and this
 * repository is hand-authored — `gen:repository` is broken and never creates
 * files (rule 03 §Generated Code Discipline).
 */
@Injectable()
export class DocumentSectionRepository extends Repository<DocumentSectionEntity, DocumentSection> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'documentSection', DocumentSectionEntityMapper.getInstance());
  }

  /**
   * Every section of one document, ordered by `idx` ascending (render order).
   */
  async findByDocument(tenantId: string, consultationId: string, documentKey: string): Promise<DocumentSectionEntity[]> {
    return this.findAll({
      filters: { tenantId, consultationId, documentKey },
      sort: [{ idx: 'asc' }],
    });
  }

  /**
   * Every section of every document of a consultation, ordered by
   * `(documentKey, idx)` so a multi-document reader gets stable grouping.
   */
  async findByConsultation(tenantId: string, consultationId: string): Promise<DocumentSectionEntity[]> {
    return this.findAll({
      filters: { tenantId, consultationId },
      sort: [{ documentKey: 'asc' }, { idx: 'asc' }],
    });
  }

  /**
   * The single row identified by `(consultationId, documentKey, sectionKey)`, or
   * null. Uses `findFirst` rather than the compound-unique `findUnique` so a
   * miss is `null` instead of a throw — the 404-over-403 posture every finder in
   * this layer follows.
   */
  async findSection(tenantId: string, consultationId: string, documentKey: string, sectionKey: string): Promise<DocumentSectionEntity | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DbFilters<DocumentSection> would require importing the Prisma-generated model type here.
      const result = await this.findFirst({ filters: { tenantId, consultationId, documentKey, sectionKey } as any });
      return result ?? null;
    } catch (err) {
      // Only a genuine miss maps to null. Anything else — most importantly the
      // tenant-scope extension's cross-tenant throw — must SURFACE, or a read
      // targeting a foreign tenant would silently "succeed" as absent. Same
      // treatment as `DocumentTemplateRepository.findFirstTolerant`.
      if (err instanceof DataNotFoundException) return null;
      throw err;
    }
  }

  /**
   * Encrypt the entity's transient plaintext `content` under the PHI Transit key
   * and store the ciphertext in `encryptedContent` (+ key version). Mutates in
   * place; the caller persists. No-op when `content` is empty/null, so it is
   * safe to call unconditionally.
   */
  async encryptContentIntoEntity(entity: DocumentSectionEntity, secrets: SecretsServiceLike): Promise<void> {
    const result = await encryptStringToCiphertext(secrets, entity.content);
    if (!result) return;
    entity.encryptedContent = result.ciphertext;
    entity.contentKeyVersion = result.keyVersion;
  }

  /** Decrypt `encryptedContent`; `null` when the section has no content yet. */
  async decryptContentFromEntity(entity: DocumentSectionEntity, secrets: SecretsServiceLike): Promise<string | null> {
    return decryptCiphertextToString(secrets, entity.encryptedContent);
  }
}
