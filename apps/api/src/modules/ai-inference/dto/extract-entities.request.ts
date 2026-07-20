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

  // TASK-506 — explicit model override (the AiModel row's sourceUri, an HF id).
  // When omitted, the gateway injects the tenant's effective `nlp.ner` default.
  // TASK-527 (D-12): there is deliberately NO caller-supplied `modelPath`. The
  // upstream `model_path` is derived from the MATCHED registry row's `localPath`
  // (default lane and override lane alike), so a caller can never point the
  // clinical NLP service at an arbitrary filesystem path. Admins change the
  // weight location by PATCHing the `AiModel` row, not by sending a request field.
  @ApiPropertyOptional({
    description:
      'Explicit HF model id overriding the tenant nlp.ner default (forwarded as model_name). The weight path is taken from the matched registry row, never from the request.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  modelName?: string;
}
