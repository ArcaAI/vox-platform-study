import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * v1 `PreSummaryRequest` for `POST /api/smr/api/v1/presummary`.
 * (SMR_Summary_Endpoints.md §4.1; frozen)
 *
 * All fields optional. `temperature`/`max_tokens` defaults (0.2 / 800) are
 * applied by the controller so an omitted value round-trips as absent through
 * the strict `ValidationPipe`.
 */
export class PreSummaryRequest {
  @ApiPropertyOptional({ description: 'Current department (null → "General")' })
  @IsOptional()
  @IsString()
  current_department?: string;

  @ApiPropertyOptional({ description: 'Type of visit (null → "Medical examination")' })
  @IsOptional()
  @IsString()
  visit_type?: string;

  @ApiPropertyOptional({ description: 'Patient age as a string' })
  @IsOptional()
  @IsString()
  age?: string;

  @ApiPropertyOptional({ description: 'Date of birth as a string' })
  @IsOptional()
  @IsString()
  dob?: string;

  @ApiPropertyOptional({ description: 'Gender' })
  @IsOptional()
  @IsString()
  gender?: string;

  @ApiPropertyOptional({ description: 'Recent vitals, pre-formatted as text' })
  @IsOptional()
  @IsString()
  formatted_vitals?: string;

  @ApiPropertyOptional({ description: 'Recent test results, pre-formatted as text' })
  @IsOptional()
  @IsString()
  formatted_test_results?: string;

  @ApiPropertyOptional({ description: 'Prior visits, pre-formatted as text' })
  @IsOptional()
  @IsString()
  formatted_previous_visits?: string;

  @ApiPropertyOptional({ description: 'Output language code ("en" / "ml"; default "en")', default: 'en' })
  @IsOptional()
  @IsString()
  language?: string;

  @ApiPropertyOptional({
    description:
      "Requesting doctor id (TASK-599). When set and the tenant+doctor DNA gate is on, the doctor's DNA writing-style is applied to the pre-summary. Omit ⇒ department + visit-type only.",
  })
  @IsOptional()
  @IsString()
  doctor_id?: string;

  @ApiPropertyOptional({ description: 'Sampling temperature 0.0–2.0 (default 0.2)', default: 0.2 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;

  @ApiPropertyOptional({ description: 'Max output tokens 1–65536 (default 800)', default: 800 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65536)
  max_tokens?: number;

  @ApiPropertyOptional({
    description: 'true → stream the pre-summary as text/event-stream (delta* + terminal result); default false → single JSON body',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  stream?: boolean;
}
