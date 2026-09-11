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
 * `clinicianUserId` (TASK-933) - see that field - OR carries that clinician's STAFF IDENTIFIER
 * inside `context`, in whichever field the tenant's context schema marks as its user identity
 * (TASK-950) - see `context`.
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
   * Honoured ONLY for a service-account caller:
   *   · a JWT / API-key caller that supplies it -> 400 `CLINICIAN_NOT_ALLOWED_FOR_USER_CALLER`
   *     (their clinician is their own identity; naming another would be impersonation);
   *   · a service-account caller that supplies NEITHER this NOR a resolvable user-identity
   *     value in `context` -> 400 `CLINICIAN_REQUIRED`.
   *
   * TASK-950 D-7 - this field and the schema's user-identity field may BOTH be sent, and when
   * both are they must AGREE: naming one clinician while the context payload identifies another
   * is a 400 `CLINICIAN_MISMATCH`, never a silent precedence. Either one alone is enough, which
   * is what keeps every TASK-933 integrator working unchanged while an integrator that knows
   * only its own staff identifiers never has to learn HOPE user ids at all.
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
      'The clinician this consultation belongs to. Required when the caller is a SERVICE ACCOUNT (which has no user of its own) unless `context` carries the value of the schema-declared user-identity field, and refused for every other credential class, whose clinician is the authenticated caller. Both may be sent only when they agree (otherwise 400 `CLINICIAN_MISMATCH`). The named user must belong to the tenant and be able to create consultations; anything else is a 404.',
    format: 'uuid',
    // A synthetic UUIDv7, NOT a seeded id: `check-openapi-coverage.ts` refuses the reserved
    // `70000000-…` / `60000000-…` prefixes in a published example.
    example: '0192f3a1-7c4b-7d2e-9f01-2b3c4d5e6f70',
  })
  @IsOptional()
  @IsString()
  @Matches(PLATFORM_ID_PATTERN, { message: 'clinicianUserId must be a 36-character hyphenated hex user id' })
  clinicianUserId?: string;

  /**
   * TASK-950 §D-6 - the consultation-context payload, as the tenant's own schema declares it.
   *
   * Shape is the ENVELOPE `{ [kindKey]: payload }` - the same shape the agent plane's `context`
   * takes, the same shape `payloadSchemaFromDefinition` derives, and the same shape
   * `@arcaai/vox-codegen --tenant` types. One entry per declared kind the caller has a value
   * for; a key the schema does not declare is a violation, not an ignored extra.
   *
   * WHICH schema it is validated against is the DEPARTMENT-effective bundle (owner answer OD-4):
   * `departmentId` on this same request narrows to the department default, and a tenant with no
   * department-scoped schema falls back to its tenant default - the identical cascade
   * `GET /tenants/me/context-schema` advertises and every case-note write already validates
   * against. Validated live, before anything is written; every problem is reported at once as
   * 400 `CONTEXT_SCHEMA_VIOLATION` with a `problems` array.
   *
   * Only STRUCTURED kinds are accepted here. TEXT / DOCUMENT / IMAGE / STREAM_AUDIO kinds carry
   * no inline `payload` - they are written after open through `POST /consultations/:id/context`
   * and its media routes - so naming one here is refused rather than silently dropped.
   *
   * ## Why this field exists at all: user identity
   *
   * A tenant may mark ONE string property of ONE STRUCTURED kind as its USER IDENTITY field
   * (`userIdentity: { field }` on the kind declaration). For a SERVICE-ACCOUNT caller the value
   * in that field is the clinician's STAFF IDENTIFIER: HOPE resolves it to a tenant user by
   * `UserProfile.staffId` and, when the tenant has auto-provisioning enabled and no such user
   * exists, creates one - and that user becomes `doctorId`. An integrator therefore never has
   * to learn, store or synchronise HOPE user ids: it sends the id its own roster already uses.
   *
   * For a HUMAN caller (JWT or API key) the field is validated as ORDINARY CONTENT and
   * otherwise IGNORED (D-5): that caller - or the key's bound human - already IS the clinician,
   * and resolving someone else from a body field would be impersonation with no gate.
   *
   * ## TASK-951 - the other three mappings, and persistence
   *
   * Identity is no longer the only thing this payload DOES. A tenant may mark three more fields
   * of a STRUCTURED kind, one each per definition, and `open` MAPS every one of them rather than
   * merely validating it (D-1):
   *
   * | Marker | Effect | Refusals |
   * |---|---|---|
   * | `department: { field, by }` | the stated code (default) or name resolves to this tenant's department, and THAT is the consultation's `departmentId` - and the schema every other kind is checked against | 404 `DEPARTMENT_UNKNOWN`, 400 `DEPARTMENT_AMBIGUOUS` (by name, >1 match), 400 `DEPARTMENT_MISMATCH` (disagrees with `departmentId`) |
   * | `visitType: { field }` | alias-matched against the platform vocabulary (`referral` -> `new-visit`, `follow-up` -> `revisit`) and recorded on the row, where it RANKS ABOVE the `parentConsultationId` derivation for prompt and workflow selection | 400 `VISIT_TYPE_INVALID` |
   * | `externalRef: { field }` | the caller's own encounter id, recorded on the row. NOT part of the re-open idempotency key, which stays `(patientId, appointmentDate, doctorId)` | - |
   *
   * And the payload IS now persisted (D-5), which it was not under TASK-950: on CREATE, every
   * validated kind becomes a PRE context item carrying its `kindKey`, and a kind the schema marks
   * `materializeAs: 'CASE_NOTE'` additionally becomes one `CASE_NOTE` item per entry - so the
   * warm-start pre-summary sees notes a client sent at open, and an integrator no longer needs a
   * separate "push the prior notes" loop. On a RE-open (the get-or-create branch) nothing is
   * persisted again, and the same validated payload is threaded into the governing workflow's
   * trigger context (D-6).
   *
   * Declared here because it has to be: the gateway's global pipe runs `forbidNonWhitelisted`,
   * so an undeclared field REJECTS THE WHOLE OPEN with a 400 rather than being ignored.
   */
  @ApiPropertyOptional({
    description:
      "The consultation-context payload as `{ [kindKey]: payload }`, validated against the DEPARTMENT-effective context schema (`departmentId` narrows; the tenant default is the fallback). STRUCTURED kinds only. Violations answer 400 `CONTEXT_SCHEMA_VIOLATION` listing every problem. Fields the schema MARKS are mapped, not just validated: the user-identity field resolves - or provisions - the clinician recorded as `doctorId` for a SERVICE-ACCOUNT caller; a marked department field selects the consultation's department by code or name; a marked visit-type field is recorded and outranks the parent-link derivation; a marked external-reference field is recorded as a label. Every validated kind is also persisted as a PRE context item and threaded into the governing workflow's trigger context.",
    type: 'object',
    additionalProperties: true,
    example: {
      encounter: { doctor_id: 'DR-1042', event_id: 'EVT-88213', department_code: 'GEN', visit_type: 'new-visit' },
      vitals: { bloodPressure: '128/82', heartRate: 72 },
    },
  })
  @IsOptional()
  @IsObject()
  context?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Additional metadata' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
