import { IsString, IsOptional, IsDateString, IsObject, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Update Consultation Request
 *
 * Partial update of an EXISTING consultation. Only safely-mutable fields are
 * accepted. Identity / ownership fields (`patientId`, `doctorId`, `tenantId`),
 * the structural `parentConsultationId` link, and the typed `status` COLUMN
 * are intentionally NOT mutable here.
 *
 * the `status` field (previously written into the legacy
 * `metadata.status` JSON key) is REMOVED. Lifecycle status now goes
 * exclusively through the dedicated, matrix-guarded routes:
 * `POST :id/prime`, `POST :id/close`, `POST :id/reopen`,
 * `POST :id/recording/start`, `POST :id/recording/stop`.
 */
export class UpdateConsultationRequest {
  @ApiPropertyOptional({
    description: 'Appointment date (YYYY-MM-DD)',
    example: '2026-02-15',
  })
  @IsOptional()
  @IsDateString()
  appointmentDate?: string;

  @ApiPropertyOptional({ description: 'Department ID (from Department lookup table)' })
  @IsOptional()
  @IsString()
  departmentId?: string;

  @ApiPropertyOptional({ description: 'Additional metadata (shallow-merged with existing metadata)' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  /**
   * TASK-1004 (OD-2 (a)) — change the consultation's declared spoken-language mode between
   * recordings, so every LATER live session, batch job and workflow run inherits what the
   * clinician last chose. Normalized like `open`'s; 400 `LANGUAGE_MODE_UNKNOWN` when it names no
   * mode. Never the note's language.
   */
  @ApiPropertyOptional({
    description:
      'Spoken-language mode id (`en`, `ml`, `ml-en`, `vi`, `vi-en`, `auto`, or a BCP-47 tag such as `ml-IN`) inherited by every later live and batch transcription of this consultation that declares none. 400 `LANGUAGE_MODE_UNKNOWN` when it names no mode.',
    example: 'ml-en',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  languageMode?: string;
}
