import { IsString, IsOptional, IsDateString, IsObject } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Open Consultation Request
 *
 * Simplified request for opening a consultation session.
 * Uses get-or-create pattern - if consultation exists for (patientId, doctorId, date),
 * returns existing; otherwise creates new.
 *
 * Note: doctorId is NOT in request - it comes from authenticated user (API key).
 */
export class OpenConsultationRequest {
  @ApiProperty({ description: 'Patient identifier' })
  @IsString()
  patientId: string;

  @ApiPropertyOptional({
    description: 'Appointment date (YYYY-MM-DD). Defaults to today if not provided.',
    example: '2026-01-29',
  })
  @IsOptional()
  @IsDateString()
  appointmentDate?: string;

  @ApiPropertyOptional({ description: 'Department ID (from Department lookup table)' })
  @IsOptional()
  @IsString()
  departmentId?: string;

  @ApiPropertyOptional({ description: 'Parent consultation ID (for re-visits/referrals)' })
  @IsOptional()
  @IsString()
  parentConsultationId?: string;

  @ApiPropertyOptional({ description: 'Additional metadata' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
