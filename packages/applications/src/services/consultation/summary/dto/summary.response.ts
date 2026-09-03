import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SummaryResponse {
  @ApiProperty()
  id: string;

  @ApiProperty()
  consultationId: string;

  @ApiProperty({ enum: ['summary', 'pre_summary'] })
  type: string;

  @ApiProperty()
  content: string;

  @ApiPropertyOptional({ description: 'Summary metadata including LLM info' })
  structuredData?: {
    llmProvider?: string;
    modelName?: string;
    processingTimeMs?: number;
    dnaStyleId?: string;
    inputTokens?: number;
    outputTokens?: number;
    entities?: Record<string, unknown>[];
    cacheHit?: boolean;
    qualityScore?: number;
    promptResolvedFrom?: 'preferred' | 'department' | 'default';
    resolvedPromptId?: string;
  };

  @ApiProperty()
  createdAt: string;

  @ApiProperty()
  updatedAt: string;

  /**
   * `SummaryDtoMapper.toResponse` maps this DTO from the
   * underlying `ContextItemEntity` (the summary IS a ContextItem row), so
   * `_version` is the same OCC compare-and-set counter `ContextItemResponse`
   * exposes. Echo back via `If-Match: "<version>"` (or the body-field
   * `expectedVersion`) on `PATCH :id/summary/:summaryId` and
   * `POST :id/summary/:contextItemId/approve`.
   */
  @ApiProperty({
    description: 'Row version for optimistic concurrency control. Echo back as `If-Match: "<version>"` or `expectedVersion` on PATCH.',
    example: 7,
  })
  version!: number;
}
