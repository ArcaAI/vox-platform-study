import { IsString, IsOptional, IsDateString, IsObject, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WORKFLOW_NODE_ID_PATTERN } from '@arcaai/workflow-contract';

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

  /**
   * TASK-813 OD-1 — the caller's workflow SELECTION for this consultation.
   *
   * Declared here because it has to be: the gateway's global pipe runs
   * `forbidNonWhitelisted`, so an undeclared selector does not fall through to
   * the assignment cascade — it REJECTS THE WHOLE OPEN with a 400, exactly as
   * the @deprecated `department` field still does.
   *
   * Absent ⇒ the `department → tenant → platform-default` assignment cascade
   * decides, which is the pre-TASK-813 behaviour and stays the default.
   * Present ⇒ it is AUTHORIZED against the caller's own published, active,
   * `consultation`-palette definitions before anything is written
   * (`ConsultationWorkflowDispatchService.assertSelectableForConsultation`):
   * a slug this tenant cannot see is a 404, one it can see but may not use to
   * govern a consultation is a 403.
   *
   * Grammar is the platform-wide tenant-authored-key grammar
   * (`WORKFLOW_NODE_ID_PATTERN`, `[a-z0-9_]{2,48}`) — the same one
   * `CreateWorkflowDefinitionRequest.slug` enforces, so a value that could
   * never name a real row is refused at the edge.
   *
   * Honoured by `POST /consultations/open` ONLY. Consultation-open dispatch
   * fires on CREATE, so a revisit (`POST /consultations/:id/revisit`) has no
   * dispatch to steer; supplying it there is logged and has no effect.
   */
  @ApiPropertyOptional({
    description:
      "Workflow definition slug to govern this consultation, overriding the assignment cascade. Must be one of the tenant's own published, active `consultation`-palette definitions: an invisible slug is 404, a visible-but-unselectable one 403. Honoured on `open` only.",
    example: 'discharge_summary',
  })
  @IsOptional()
  @IsString()
  @Matches(WORKFLOW_NODE_ID_PATTERN, { message: 'workflowDefinitionSlug must match [a-z0-9_]{2,48}' })
  workflowDefinitionSlug?: string;

  @ApiPropertyOptional({ description: 'Additional metadata' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
