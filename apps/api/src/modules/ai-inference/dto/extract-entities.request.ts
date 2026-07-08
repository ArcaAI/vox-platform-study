import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Agent Playground → NER tab (TASK-446). Proxied to the NLP service
 * `POST /api/v1/classify/tokens`; the controller maps `aggregationStrategy`
 * to the upstream snake_case `aggregation_strategy`.
 */
export class ExtractEntitiesRequest {
  @ApiProperty({ description: 'Text to extract medical entities from.', maxLength: 20_000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20_000)
  text!: string;

  @ApiPropertyOptional({ description: 'Entity aggregation strategy. Defaults to "simple".', default: 'simple' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  aggregationStrategy?: string;

  @ApiPropertyOptional({ description: 'Language of the text (upstream default: English).' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  language?: string;
}
