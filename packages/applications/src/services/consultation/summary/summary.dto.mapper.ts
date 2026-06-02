import { ContextItemEntity } from '@arcaai/domains';
import { SummaryResponse } from './dto';

export class SummaryDtoMapper {
  static toResponse(entity: ContextItemEntity): SummaryResponse {
    // Map SummaryMeta relation to structuredData for backward compatibility
    const summaryMeta = entity.SummaryMeta;
    const structuredData: SummaryResponse['structuredData'] = summaryMeta
      ? {
          modelName: summaryMeta.aiModelId ?? undefined,
          processingTimeMs: summaryMeta.processingTimeMs ?? undefined,
          inputTokens: summaryMeta.inputTokens ?? undefined,
          outputTokens: summaryMeta.outputTokens ?? undefined,
          cacheHit: summaryMeta.cacheHit ?? undefined,
          qualityScore: summaryMeta.qualityScore ?? undefined,
        }
      : undefined;

    return {
      id: entity.id,
      consultationId: entity.consultationId,
      type: entity.type,
      content: entity.content ?? '',
      structuredData,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
    };
  }
}
