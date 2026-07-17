import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * TASK-506 — diagnosis suggestions. Proxied to the NLP service
 * `POST /api/v1/diagnosis/suggestions`; the controller maps `minConfidence`
 * to the upstream snake_case `min_confidence` and injects `model_name` from
 * the tenant's effective `nlp.classification` default (fail-open).
 */
export class SuggestDiagnosisRequest {
  @ApiProperty({ description: 'Clinical text to derive diagnosis suggestions from.', maxLength: 20_000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20_000)
  text!: string;

  @ApiPropertyOptional({ description: 'Minimum confidence threshold for returned suggestions (0–1).', minimum: 0, maximum: 1 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  minConfidence?: number;

  @ApiPropertyOptional({ description: 'Language of the text (upstream default: English).' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  language?: string;
}
