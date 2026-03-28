import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * A single named entity in the aggregate NER response.
 *
 * Richer than the ChainSummaryService's internal representation —
 * includes entity ID, display text, high-confidence flag, and
 * source consultation metadata for cross-department visibility.
 */
export class AggregateNamedEntityItem {
  @ApiProperty({ description: 'Named entity ID' })
  id: string;

  @ApiProperty({ description: 'The recognized text span' })
  text: string;

  @ApiProperty({ description: 'Display text (normalized if available, otherwise original)' })
  displayText: string;

  @ApiPropertyOptional({ description: 'Normalized/canonical form' })
  normalizedText?: string;

  @ApiPropertyOptional({ description: 'Confidence score (0.0 - 1.0)' })
  confidence?: number;

  @ApiProperty({ description: 'Whether confidence is high (>= 0.8)' })
  isHighConfidence: boolean;

  @ApiProperty({ description: 'Source consultation ID where this entity was extracted' })
  sourceConsultationId: string;

  @ApiPropertyOptional({ description: 'Source context item ID' })
  sourceContextItemId?: string;

  @ApiPropertyOptional({ description: 'Source context item type (TRANSCRIPT, RAW_SUMMARY, etc.)' })
  sourceContextType?: string;

  @ApiPropertyOptional({ description: 'AI Model ID used for extraction' })
  aiModelId?: string;

  @ApiProperty({ description: 'ISO-8601 creation timestamp' })
  createdAt: string;
}

/**
 * Source consultation metadata in the aggregate NER response.
 */
export class AggregateNerSource {
  @ApiProperty({ description: 'Consultation ID' })
  consultationId: string;

  @ApiPropertyOptional({ description: 'Department name' })
  department?: string;

  @ApiPropertyOptional({ description: 'Department ID' })
  departmentId?: string;

  @ApiPropertyOptional({ description: 'Doctor display name' })
  doctor?: string;

  @ApiPropertyOptional({ description: 'Doctor user ID' })
  doctorId?: string;
}

/**
 * Aggregate NER response for a consultation or consultation chain.
 *
 * Returns named entities grouped by entity class (MEDICATION, CONDITION,
 * PROCEDURE, etc.) from all consultations in the chain, along with
 * source consultation metadata.
 *
 * Endpoint: GET /api/consultations/:id/named-entities?scope=chain
 */
export class AggregateNerResponse {
  @ApiProperty({ description: 'The consultation ID that was queried' })
  consultationId: string;

  @ApiProperty({
    enum: ['single', 'chain'],
    description: 'Scope: single consultation or full chain + same-day consultations',
  })
  scope: 'single' | 'chain';

  @ApiProperty({
    description: 'Named entities grouped by class (e.g., MEDICATION, CONDITION, PROCEDURE)',
    type: 'object',
    additionalProperties: {
      type: 'array',
      items: { $ref: '#/components/schemas/AggregateNamedEntityItem' },
    },
  })
  entities: Record<string, AggregateNamedEntityItem[]>;

  @ApiProperty({ description: 'Total number of entities across all classes' })
  totalCount: number;

  @ApiProperty({
    description: 'Count of entities per class',
    type: 'object',
    additionalProperties: { type: 'number' },
  })
  countByClass: Record<string, number>;

  @ApiProperty({
    description: 'Source consultations that contributed entities',
    type: [AggregateNerSource],
  })
  sources: AggregateNerSource[];
}
