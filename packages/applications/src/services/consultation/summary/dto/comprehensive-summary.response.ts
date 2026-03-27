import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * A section in the comprehensive summary input, representing content
 * from one consultation in the chain.
 */
export class ChainSectionDto {
  @ApiProperty({ description: 'Source consultation ID' })
  consultationId: string;

  @ApiPropertyOptional({ description: 'Department name or code' })
  department?: string;

  @ApiPropertyOptional({ description: 'Doctor name or ID' })
  doctor?: string;

  @ApiProperty({
    description: 'Content type',
    enum: ['transcript', 'summary', 'case_note', 'pre_summary', 'lab_result'],
  })
  type: string;

  @ApiProperty({ description: 'Text content' })
  content: string;

  @ApiPropertyOptional({ description: 'ISO-8601 timestamp' })
  createdAt?: string;
}

/**
 * Response DTO for the comprehensive cross-chain summary.
 *
 * Extends the standard SummaryResponse with chain-specific metadata
 * such as source consultations, NER entities, and section breakdown.
 */
export class ComprehensiveSummaryResponse {
  @ApiProperty({ description: 'The created comprehensive summary context item ID' })
  id: string;

  @ApiProperty({ description: 'The consultation that requested the comprehensive summary' })
  consultationId: string;

  @ApiProperty({ description: 'Context item type (RAW_SUMMARY)' })
  type: string;

  @ApiProperty({ description: 'The generated comprehensive summary text' })
  content: string;

  @ApiPropertyOptional({ description: 'Summary metadata' })
  structuredData?: {
    modelName?: string;
    processingTimeMs?: number;
    inputTokens?: number;
    outputTokens?: number;
  };

  @ApiProperty({ description: 'Consultation IDs that contributed to this summary' })
  sourceConsultationIds: string[];

  @ApiProperty({ description: 'Number of sections aggregated' })
  sectionCount: number;

  @ApiPropertyOptional({ description: 'Aggregated named entities grouped by class' })
  namedEntities?: Record<
    string,
    Array<{
      text: string;
      confidence?: number;
      sourceConsultationId: string;
    }>
  >;

  @ApiProperty({ description: 'ISO-8601 creation timestamp' })
  createdAt: string;

  @ApiProperty({ description: 'ISO-8601 update timestamp' })
  updatedAt: string;
}
