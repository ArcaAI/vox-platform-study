import { IsString, IsOptional, IsDateString, IsObject } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Update Consultation Request
 *
 * Partial update of an EXISTING consultation. Only safely-mutable fields are
 * accepted. Identity / ownership fields (`patientId`, `doctorId`, `tenantId`),
 * the structural `parentConsultationId` link, and the typed `status` COLUMN
 * are intentionally NOT mutable here.
 *
 * TASK-711 — the `status` field (previously written into the legacy
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
}
