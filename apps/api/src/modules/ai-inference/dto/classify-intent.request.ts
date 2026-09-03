import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Proxied to the NLP service `POST /api/v1/classify/intent`. The
 * tenant's intent list is NEVER caller-supplied — the controller resolves it
 * server-side from `TenantNlpTaskInstructions` and injects it as
 * `instructions`, the same gateway-injection posture `model_name` has on
 * `/ai/nlp/entities`.
 */
export class ClassifyIntentRequest {
  @ApiProperty({ description: 'Text to classify into one of the tenant configured intents.', maxLength: 20_000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20_000)
  text!: string;

  @ApiPropertyOptional({ description: 'Language of the text (upstream default: English).' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  language?: string;
}
