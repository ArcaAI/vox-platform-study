import { IsString, IsOptional, IsDateString, IsObject, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WORKFLOW_DEFINITION_SLUG_PATTERN } from '@arcaai/workflow-contract';
import { SUMMARY_LANGUAGE_PATTERN } from '../summary-language';

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
   * the caller's workflow SELECTION for this consultation.
   *
   * Declared here because it has to be: the gateway's global pipe runs
   * `forbidNonWhitelisted`, so an undeclared selector does not fall through to
   * the assignment cascade — it REJECTS THE WHOLE OPEN with a 400, exactly as
   * the @deprecated `department` field still does.
   *
   * Absent ⇒ the `department → tenant → platform-default` assignment cascade
   * decides, which is the earlier behaviour and stays the default.
   * Present ⇒ it is AUTHORIZED against the caller's own published, active,
   * `consultation`-palette definitions before anything is written
   * (`ConsultationWorkflowDispatchService.assertSelectableForConsultation`):
   * a slug this tenant cannot see is a 404, one it can see but may not use to
   * govern a consultation is a 403.
   *
   * Grammar is `WORKFLOW_DEFINITION_SLUG_PATTERN` — the same one
   * `CreateWorkflowDefinitionRequest.slug` enforces, so a value that could
   * never name a real row is refused at the edge. AMENDED: the node-id
   * grammar this used to reuse admits no hyphen, and every seeded slug has one.
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
  @Matches(WORKFLOW_DEFINITION_SLUG_PATTERN, {
    message: 'workflowDefinitionSlug must be 2-80 lowercase alphanumerics, - or _, starting and ending alphanumeric',
  })
  workflowDefinitionSlug?: string;

  /**
   * TASK-932 §3.7 — the language the NOTE is written in.
   *
   * NOT the STT language mode, and the distinction is the whole point of the field: a
   * Malayalam-English consultation is routinely documented in English. TASK-891 OD-1 governs
   * DECODING and leaves it undeclared by default ("the code-switch is always enabled"); this
   * governs OUTPUT and is likewise undeclared by default — absent means the agent's own body
   * decides, which is what every consultation did before this ticket. Declaring one never sets
   * the other.
   *
   * Declared here because it has to be: the gateway's global pipe runs `forbidNonWhitelisted`,
   * so an undeclared field REJECTS THE WHOLE OPEN with a 400 rather than being ignored.
   *
   * Honoured on `open` and on `revisit`. A re-open of an ALREADY-OPEN consultation keeps the
   * language it was opened with, exactly as it keeps its governing workflow.
   */
  @ApiPropertyOptional({
    description:
      'BCP-47 language tag the generated notes should be written in (`en`, `ml`, `en-IN`). Independent of the STT language mode: absent means undeclared, and the agent decides.',
    example: 'ml',
  })
  @IsOptional()
  @IsString()
  @Matches(SUMMARY_LANGUAGE_PATTERN, { message: 'language must be a BCP-47 tag such as `en`, `ml` or `en-IN`' })
  language?: string;

  @ApiPropertyOptional({ description: 'Additional metadata' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
