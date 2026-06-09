import { HighlightEntity } from '@arcaai/domains';
import { HighlightResponse } from './dto';

export class HighlightDtoMapper {
  /**
   * Map a HighlightEntity to its API response shape.
   */
  static toResponse(entity: HighlightEntity): HighlightResponse {
    return {
      id: entity.id,
      consultationId: entity.consultationId,
      sourceContextItemId: entity.sourceContextItemId ?? undefined,
      targetKind: entity.targetKind,
      exact: entity.exact,
      prefix: entity.prefix ?? undefined,
      suffix: entity.suffix ?? undefined,
      startOffset: entity.startOffset,
      endOffset: entity.endOffset,
      color: entity.color ?? undefined,
      label: entity.label ?? undefined,
      note: entity.note ?? undefined,
      createdBy: entity.createdBy ?? undefined,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
    };
  }
}
