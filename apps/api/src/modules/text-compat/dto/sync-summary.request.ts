import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsDefined, IsInt, IsNumber, IsObject, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';
import { SessionDataDto } from './session-data.dto';

/**
 * v1 `SyncSummaryRequest` for `POST /api/smr/api/v1/summary/sync`.
 * (TEXT_Summary_Endpoints.md; frozen)
 *
 * Strict DTO — the global `ValidationPipe` runs `whitelist +
 * forbidNonWhitelisted + forbidUnknownValues`, so every accepted field is
 * declared here. `@ValidateNested` on `session_data` is paired with
 * `@IsDefined` so a missing `session_data` is rejected (a bare
 * `@ValidateNested()` silently passes when the value is absent).
 */
export class SyncSummaryRequest {
  @ApiProperty({ description: 'The session to summarize', type: SessionDataDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => SessionDataDto)
  session_data!: SessionDataDto;

  @ApiPropertyOptional({ description: 'Override the system prompt' })
  @IsOptional()
  @IsString()
  system_prompt?: string;

  @ApiPropertyOptional({ description: 'Override the user prompt template' })
  @IsOptional()
  @IsString()
  user_prompt_template?: string;

  @ApiPropertyOptional({ description: 'Sampling temperature 0.0–2.0' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;

  @ApiPropertyOptional({ description: 'Max output tokens 1–32768' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(32768)
  max_tokens?: number;

  @ApiPropertyOptional({ description: 'Free-form extra context' })
  @IsOptional()
  @IsObject()
  context?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'true → EnhancedMedicalSummary; false → SimplifiedMedicalSummary', default: false })
  @IsOptional()
  @IsBoolean()
  use_enhanced_format?: boolean;

  @ApiPropertyOptional({ description: 'Explicit department for prompt selection' })
  @IsOptional()
  @IsString()
  department?: string;

  @ApiPropertyOptional({ description: 'Explicit visit type' })
  @IsOptional()
  @IsString()
  visit_type?: string;

  @ApiPropertyOptional({
    description:
      "Requesting doctor id . When set and the tenant+doctor DNA gate is on, the doctor's DNA writing-style is applied to the summary. Omit ⇒ department + visit-type only.",
  })
  @IsOptional()
  @IsString()
  doctor_id?: string;

  @ApiPropertyOptional({ description: 'Medical specialty' })
  @IsOptional()
  @IsString()
  specialty?: string;

  @ApiPropertyOptional({ description: 'Encounter context' })
  @IsOptional()
  @IsString()
  encounter_type?: string;

  @ApiPropertyOptional({ description: 'Include session_data.pre_summary_text in the summarization context', default: false })
  @IsOptional()
  @IsBoolean()
  include_pre_summary_in_context?: boolean;

  @ApiPropertyOptional({ description: 'DEPRECATED / ignored — use pre_summary_text + include_pre_summary_in_context', default: true })
  @IsOptional()
  @IsBoolean()
  include_previous_visit_summary?: boolean;

  @ApiPropertyOptional({
    description: 'true → stream the summary as text/event-stream (delta* + terminal result); default false → single JSON body',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  stream?: boolean;

  @ApiPropertyOptional({
    description:
      'true → translate the transcript to English via Sarvam BEFORE summarizing . Fail-open: on a translation error the original transcript is summarized. Default false.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  translate_to_english?: boolean;
}
