import { IsString, IsOptional, IsDateString, IsObject, IsIn } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Consultation lifecycle status (TASK-321).
 *
 * The Consultation model has no dedicated open/closed column; lifecycle
 * state is stored in `metadata.status` and surfaced as `ConsultationResponse.status`.
 * An absent value is treated as OPEN.
 */
export const CONSULTATION_STATUS = {
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
} as const;

export type ConsultationLifecycleStatus = (typeof CONSULTATION_STATUS)[keyof typeof CONSULTATION_STATUS];

export const CONSULTATION_STATUS_VALUES: ConsultationLifecycleStatus[] = Object.values(CONSULTATION_STATUS);

/**
 * Update Consultation Request (TASK-321)
 *
 * Partial update of an EXISTING consultation. Only safely-mutable fields are
 * accepted. Identity / ownership fields (`patientId`, `doctorId`, `tenantId`)
 * and the structural `parentConsultationId` link are intentionally NOT mutable.
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

  @ApiPropertyOptional({
    description: 'Lifecycle status. Stored in metadata.status.',
    enum: CONSULTATION_STATUS_VALUES,
  })
  @IsOptional()
  @IsIn(CONSULTATION_STATUS_VALUES)
  status?: ConsultationLifecycleStatus;

  @ApiPropertyOptional({ description: 'Additional metadata (shallow-merged with existing metadata)' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
