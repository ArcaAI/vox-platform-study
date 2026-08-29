import { DocumentSectionEntity, DocumentSectionState } from '@arcaai/domains';
import { SectionAnnotationDto, SectionProvenanceDto } from '../live-documentation/realtime/dto/section-patch.dto';
import { DocumentSectionResponse } from './dto';

/**
 * The persisted enum -> wire form. Identical to `STATE_WIRE` in `section-store.ts`,
 * and deliberately re-declared rather than exported from there: that copy is the
 * SSE lane's, this one is REST's, and a shared constant would make an SSE-side
 * rename silently reshape the REST contract (or vice versa). Both are pinned by
 * their own tests.
 */
const STATE_WIRE: Readonly<Record<DocumentSectionState, DocumentSectionResponse['state']>> = Object.freeze({
  [DocumentSectionState.EMPTY]: 'empty',
  [DocumentSectionState.PROVISIONAL]: 'provisional',
  [DocumentSectionState.CONFIRMED]: 'confirmed',
  [DocumentSectionState.LOCKED]: 'locked',
});

export class DocumentSectionDtoMapper {
  /**
   * Map one section to its API response.
   *
   * `content` is passed in rather than read off the entity: the persisted column
   * is Vault-Transit CIPHERTEXT and `entity.content` is a transient field that is
   * null on any freshly-read row. The caller decides where the plaintext came
   * from — a decrypt on the read path, or the text it just wrote on the edit path
   * — so this mapper never has to know how to reach Vault.
   */
  static toResponse(entity: DocumentSectionEntity, content: string): DocumentSectionResponse {
    return {
      id: entity.id,
      consultationId: entity.consultationId,
      documentKey: entity.documentKey,
      sectionKey: entity.sectionKey,
      title: entity.title,
      idx: entity.idx,
      state: STATE_WIRE[entity.state],
      revision: entity.revision,
      version: entity.version,
      content,
      ...(entity.annotations ? { annotations: entity.annotations as unknown as SectionAnnotationDto[] } : {}),
      ...(entity.provenance ? { provenance: entity.provenance as unknown as SectionProvenanceDto[] } : {}),
      documentTemplateVersionId: entity.documentTemplateVersionId ?? null,
      confirmedAt: entity.confirmedAt ? entity.confirmedAt.toISOString() : null,
      confirmedBy: entity.confirmedBy ?? null,
      lockedAt: entity.lockedAt ? entity.lockedAt.toISOString() : null,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
    };
  }
}
