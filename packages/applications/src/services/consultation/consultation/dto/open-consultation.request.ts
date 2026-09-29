import { IsString, IsOptional, IsDateString, IsObject, Matches, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WORKFLOW_DEFINITION_SLUG_PATTERN } from '@arcaai/workflow-contract';

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
 * `POST /consultations/open` is the ONLY entry to a consultation (TASK-1020 D-1): one clinical
 * ENCOUNTER = one consultation, get-or-create on the encounter key.
 *
 * The key (TASK-1020 D-2/D-3):
 *   - WITH an encounter id (`externalRef` — the schema-marked field of `context`, or
 *     `metadata.externalRef`): `(patientId, clinician, externalRef)`. The same ref returns the same
 *     consultation (retries and reconnects are safe); a NEW ref opens a NEW consultation even on a
 *     day that already has one — that is how a same-day return visit is opened. A ref this tenant
 *     already used for another patient is 409 `EXTERNAL_REF_CONFLICT`.
 *   - WITHOUT one: the legacy `(patientId, appointmentDate, clinician)`, newest match. Naming the
 *     match (or an unrelated consultation) as `parentConsultationId` opens a new follow-up instead.
 *
 * A match is returned whatever its status; `recordable: false` on the response says it can no
 * longer be recorded (SIGNED, CLOSED_COMPLETE, TIMED_OUT, REOPENED). A new consultation whose
 * visit type is `revisit` and that names no parent is chained to the patient's latest consultation
 * of the same day (any clinician).
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
    description:
      "Appointment date (YYYY-MM-DD). Defaults to today in the tenant's time zone (setting `consultation.appointmentDay.timeZone`, UTC unless configured).",
    example: '2026-01-29',
  })
  @IsOptional()
  @IsDateString()
  appointmentDate?: string;

  @ApiPropertyOptional({ description: 'Department ID (from Department lookup table)' })
  @IsOptional()
  @IsString()
  departmentId?: string;

  @ApiPropertyOptional({
    description:
      'The consultation this visit follows (re-visit / referral). Must belong to the same patient (400 `PARENT_PATIENT_MISMATCH`). Without an `externalRef`, naming the consultation the legacy key would return opens a new follow-up instead of returning it. When absent and the visit type resolves to `revisit`, the latest consultation of the same patient and day is linked.',
  })
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
   * Consultation-open dispatch fires on CREATE only: an `open` that returns an
   * existing consultation has no dispatch left to steer, so the selection is
   * logged and has no effect there (`GET /consultations/:id/workflow` reports
   * what actually governs).
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
   * The consultation's SOURCE language — what is spoken and transcribed — as a BCP-47 tag or a
   * catalog mode id. TASK-1004: normalized at the edge to ONE spoken-language mode (`en-US` → `en`,
   * `ml-IN` → `ml`, `ml-en`, `auto`) and stored in `Consultation.spokenLanguageMode`; a value that
   * names no mode is 400 `LANGUAGE_MODE_UNKNOWN` (checked in the service, which answers with the
   * code and the catalog — a class-validator message cannot carry either). Prefer `languageMode`.
   *
   * It does NOT choose the language the notes are WRITTEN in (owner decision 2026-09-23): that is
   * the tenant's output-language policy, else the platform default (English) — see
   * `resolveOutputLanguage` in `../summary-language.ts`. Absent means undeclared.
   *
   * TASK-1004: re-opening an ALREADY-OPEN consultation with an
   * explicit, DIFFERENT mode updates the consultation's declaration (audited `ResourceUpdated`);
   * omitting it keeps the declaration the consultation already has.
   */
  @ApiPropertyOptional({
    description:
      "The consultation's SOURCE (spoken) language: a BCP-47 tag (`en-US`, `ml-IN`) or a spoken-language mode id (`en`, `ml`, `ml-en`, `vi`, `vi-en`, `auto`). Normalized to one mode and inherited by every live and batch transcription of this consultation that declares none. 400 `LANGUAGE_MODE_UNKNOWN` when it names no mode. Never the language the notes are written in. Prefer `languageMode`.",
    example: 'ml-en',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  language?: string;

  /**
   * TASK-1004 — the same declaration as `language`, as a spoken-language MODE id. Preferred: when
   * both are sent this one wins. Inherited by every live session (`POST
   * audio/transcription-jobs/stream/session`) and batch job of this consultation that declares no
   * mode of its own; change it later with `PATCH consultations/:id { languageMode }`.
   */
  @ApiPropertyOptional({
    description:
      'Spoken-language mode id (`en`, `ml`, `ml-en`, `vi`, `vi-en`, `auto`) — preferred over `language`, and wins when both are sent. Inherited by every live and batch transcription of this consultation that declares none. On an already-open consultation a different value updates its declaration. 400 `LANGUAGE_MODE_UNKNOWN` when it names no mode.',
    example: 'ml-en',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  languageMode?: string;

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
   * | `externalRef: { field }` | the caller's own encounter id, recorded on the row (`Consultation.externalRef`) and, since TASK-1020, the open KEY: same ref = same consultation, new ref = new consultation | 409 `EXTERNAL_REF_CONFLICT` (ref already used for another patient) |
   *
   * And the payload IS now persisted (D-5), which it was not under TASK-950: on CREATE, every
   * validated kind becomes a PRE context item carrying its `kindKey`, and a kind the schema marks
   * `materializeAs: 'CASE_NOTE'` additionally becomes one `CASE_NOTE` item per entry - so the
   * warm-start pre-summary sees notes a client sent at open, and an integrator no longer needs a
   * separate "push the prior notes" loop. The validated payload is also threaded into the
   * governing workflow's trigger context (D-6) — on CREATE only, since that is the only time a
   * workflow is dispatched. On a RE-open (an `open` that returns an existing consultation) the
   * payload is validated and its markers still decide the key, but nothing is persisted again and
   * nothing is dispatched: the consultation keeps the context and the workflow of its own open.
   *
   * Declared here because it has to be: the gateway's global pipe runs `forbidNonWhitelisted`,
   * so an undeclared field REJECTS THE WHOLE OPEN with a 400 rather than being ignored.
   */
  @ApiPropertyOptional({
    description:
      "The consultation-context payload as `{ [kindKey]: payload }`, validated against the DEPARTMENT-effective context schema (`departmentId` narrows; the tenant default is the fallback). STRUCTURED kinds only. Violations answer 400 `CONTEXT_SCHEMA_VIOLATION` listing every problem. Fields the schema MARKS are mapped, not just validated: the user-identity field resolves - or provisions - the clinician recorded as `doctorId` for a SERVICE-ACCOUNT caller; a marked department field selects the consultation's department by code or name; a marked visit-type field is recorded and outranks the parent-link derivation; a marked external-reference field is recorded and is the open KEY (same ref = same consultation, new ref = new consultation; 409 `EXTERNAL_REF_CONFLICT` when the ref belongs to another patient). On a new consultation every validated kind is also persisted as a PRE context item and threaded into the governing workflow's trigger context.",
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
