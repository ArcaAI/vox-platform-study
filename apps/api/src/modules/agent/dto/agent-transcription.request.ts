import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * TASK-1004 — the body of `POST agents/:slug/transcriptions`, now a real DTO.
 *
 * Unlike `invocations` (whose body is the AGENT's own `inputSchema` and so must stay open-ended —
 * TASK-971 F-F1), a transcription body has a FIXED shape the gateway owns: which media, which
 * consultation, which spoken language. Declaring it lets the global pipe refuse an undeclared field
 * instead of silently dropping it, and documents `languageMode` like every other language edge.
 */
export class AgentTranscriptionRequest {
  @ApiProperty({ description: 'Id of the uploaded media object to transcribe. Another tenant’s id is a 404, like an unknown one.' })
  @IsString()
  @IsNotEmpty()
  mediaId!: string;

  @ApiPropertyOptional({
    description:
      "Consultation the transcript belongs to. When the request declares no language, the job inherits this consultation's declared spoken-language mode (an unknown or foreign id is then a 404).",
  })
  @IsOptional()
  @IsString()
  consultationId?: string;

  @ApiPropertyOptional({
    description:
      'Spoken language as a BCP-47 tag (`en-US`, `ml-IN`) or a mode id — normalized to one spoken-language mode. `languageMode` wins when both are sent. 400 `LANGUAGE_MODE_UNKNOWN` when it names no mode.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  language?: string;

  @ApiPropertyOptional({
    description:
      "Spoken-language mode id: 'en', 'ml', 'ml-en', 'vi', 'vi-en', 'auto'. Takes precedence over `language`; omit both to inherit the consultation's declared mode, else the agent's own default. It never chooses the engine — the named agent always serves. 400 `LANGUAGE_MODE_UNKNOWN` when it names no mode.",
    example: 'ml-en',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  languageMode?: string;
}
