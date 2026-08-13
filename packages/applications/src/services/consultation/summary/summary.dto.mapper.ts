import { ContextItemEntity, SummaryMetaEntity } from '@arcaai/domains';
import { SummaryResponse, SummaryProvenanceResponse, CitedSegmentResponse } from './dto';

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
          promptResolvedFrom: (summaryMeta.promptResolvedFrom as 'preferred' | 'department' | 'default' | null) ?? undefined,
          resolvedPromptId: summaryMeta.resolvedPromptId ?? undefined,
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

  /**
   * Map a SummaryMeta entity to the read-only provenance
   * DTO (citationsMap + sensor scores + modelName). The harness persists its
   * full sensor-score detail object in the `guardrailDecisions` column, so we
   * surface that as `sensorScores` for provenance consumers.
   */
  static toProvenanceResponse(meta: SummaryMetaEntity, citedSegments: CitedSegmentResponse[] = []): SummaryProvenanceResponse {
    return {
      contextItemId: meta.contextItemId,
      modelName: meta.modelName ?? null,
      entityFaithfulnessScore: meta.entityFaithfulnessScore ?? null,
      coverageScore: meta.coverageScore ?? null,
      ragTriadScore: meta.ragTriadScore ?? null,
      sensorScores: (meta.guardrailDecisions ?? null) as Record<string, unknown> | null,
      citationsMap: meta.citationsMap ?? null,
      generatedAt: meta.generatedAt ? meta.generatedAt.toISOString() : null,
      // Cited transcript segments, resolved by the service
      // (best-effort; [] when unresolvable, never blocking this read).
      citedSegments,
    };
  }
}
