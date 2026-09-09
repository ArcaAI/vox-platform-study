import { IsString, IsOptional, IsDateString, IsObject, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WORKFLOW_DEFINITION_SLUG_PATTERN } from '@arcaai/workflow-contract';
import { SUMMARY_LANGUAGE_PATTERN } from '../summary-language';

/**
 * TASK-933 — the platform's own id GRAMMAR (8-4-4-4-12 hex), NOT `@IsUUID()`.
 *
 * `class-validator`'s `isUUID()` enforces an RFC-4122 version nibble, and the platform's reserved
 * ids are hand-authored sentinels that carry none — `isUUID()` is FALSE for the seeded ArcaAI
 * doctor. `compute-draft.request.ts` and `resync-department-agents.request.ts` already document
 * this trap for tenant ids; naming a real seeded clinician must not be a 400. The shape check is
 * still worth having: it refuses a free-text value at the edge, before any tenant read.
 */
const PLATFORM_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Open Consultation Request
 *
 * Simplified request for opening a consultation session.
 * Uses get-or-create pattern - if consultation exists for (patientId, doctorId, date),
 * returns existing; otherwise creates new.
 *
 * Note: doctorId is NOT in request for a HUMAN caller - it comes from the authenticated user
 * (JWT or API key). A SERVICE ACCOUNT has no user, so it names the clinician it acts for with
 * `clinicianUserId` (TASK-933) - see that field.
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

  /**
   * TASK-933 §3.2 - the clinician a MACHINE caller is acting for.
   *
   * `Consultation.doctorId` names a PERSON and always will: DNA writing style, the redaction
   * gate, the doctor's report at finalize, the preferred prompt template and the audit trail
   * all read that column. A service account has no CLS `user` (deliberately - a machine's
   * actions must not be recorded against a human), so without this field it could not open a
   * consultation at all, and papering over that by writing the account's own id into `doctorId`
   * would corrupt every one of those consumers at once.
   *
   * Honoured ONLY for a service-account caller, and REQUIRED for one:
   *   · a JWT / API-key caller that supplies it -> 400 `CLINICIAN_NOT_ALLOWED_FOR_USER_CALLER`
   *     (their clinician is their own identity; naming another would be impersonation);
   *   · a service-account caller that omits it -> 400 `CLINICIAN_REQUIRED`.
   *
   * The named user is then validated like any other cross-aggregate reference - tenant
   * membership - PLUS their own CASL ability must grant `create:Consultation`. Every failure is
   * a 404: the user id space is not the caller's to probe.
   *
   * Declared here because it has to be: the gateway's global pipe runs `forbidNonWhitelisted`,
   * so an undeclared field REJECTS THE WHOLE OPEN with a 400 rather than being ignored.
   */
  @ApiPropertyOptional({
    description:
      'The clinician this consultation belongs to. Required when the caller is a SERVICE ACCOUNT (which has no user of its own) and refused for every other credential class, whose clinician is the authenticated caller. The named user must belong to the tenant and be able to create consultations; anything else is a 404.',
    format: 'uuid',
    // A synthetic UUIDv7, NOT a seeded id: `check-openapi-coverage.ts` refuses the reserved
    // `70000000-…` / `60000000-…` prefixes in a published example.
    example: '0192f3a1-7c4b-7d2e-9f01-2b3c4d5e6f70',
  })
  @IsOptional()
  @IsString()
  @Matches(PLATFORM_ID_PATTERN, { message: 'clinicianUserId must be a 36-character hyphenated hex user id' })
  clinicianUserId?: string;

  @ApiPropertyOptional({ description: 'Additional metadata' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
