import { IsArray, IsBoolean, IsIn, IsNumber, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * TASK-330 Phase 1 — Lane G internal-harness contract DTOs.
 *
 * Every request carries `tenantId` in the body: the harness calls these
 * endpoints out-of-band of the API edge ClsModule middleware, so the internal
 * service re-establishes CLS from this field (mirroring the BullMQ workers).
 */

// ---------------------------------------------------------------------------
// entities
// ---------------------------------------------------------------------------

export class HarnessEntityItem {
  @ApiProperty({ description: 'Recognized text span' })
  @IsString()
  text: string;

  @ApiProperty({ description: 'Entity class/type (e.g. MEDICATION, CONDITION, PROCEDURE)' })
  @IsString()
  type: string;

  @ApiPropertyOptional({ description: 'Normalized / canonical form' })
  @IsOptional()
  @IsString()
  normalizedText?: string;

  @ApiPropertyOptional({ description: 'Source-text character offset start' })
  @IsOptional()
  @IsNumber()
  startOffset?: number;

  @ApiPropertyOptional({ description: 'Source-text character offset end' })
  @IsOptional()
  @IsNumber()
  endOffset?: number;

  @ApiPropertyOptional({ description: 'Confidence score (0.0 - 1.0)' })
  @IsOptional()
  @IsNumber()
  confidence?: number;

  @ApiPropertyOptional({ description: 'Transcript ContextItem the span maps back to (provenance)' })
  @IsOptional()
  @IsString()
  transcriptContextItemId?: string;

  @ApiPropertyOptional({ description: 'Transcript-span offset start (provenance)' })
  @IsOptional()
  @IsNumber()
  transcriptStartOffset?: number;

  @ApiPropertyOptional({ description: 'Transcript-span offset end (provenance)' })
  @IsOptional()
  @IsNumber()
  transcriptEndOffset?: number;
}

export class HarnessPersistEntitiesRequest {
  @ApiProperty({ description: 'Tenant the harness is acting on behalf of' })
  @IsString()
  tenantId: string;

  @ApiPropertyOptional({ description: 'Responsible user id, if any (falls back to a worker session)' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiProperty({ description: 'The ContextItem (transcript) the entities were extracted from' })
  @IsString()
  contextItemId: string;

  @ApiProperty({ description: 'Recognized named entities to persist', type: [HarnessEntityItem] })
  @IsArray()
  entities: HarnessEntityItem[];
}

export interface HarnessPersistEntitiesResponse {
  savedCount: number;
  entityIds: string[];
}

// ---------------------------------------------------------------------------
// assemble
// ---------------------------------------------------------------------------

export class HarnessAssembleRequest {
  @ApiProperty({ description: 'Tenant the harness is acting on behalf of' })
  @IsString()
  tenantId: string;

  @ApiPropertyOptional({ description: 'Responsible user id, if any' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ description: 'Explicit prompt template override (else resolved via tier chain)' })
  @IsOptional()
  @IsString()
  template?: string;

  @ApiPropertyOptional({ description: 'DNA writing style id' })
  @IsOptional()
  @IsString()
  dnaStyleId?: string;

  @ApiPropertyOptional({ description: 'Conversation language (default en)' })
  @IsOptional()
  @IsString()
  conversationLanguage?: string;
}

export interface HarnessAssembleResponse {
  userPrompt: string;
  systemPrompt: string;
  hyperparameters: Record<string, number>;
  responseFormat: { type: string; json_schema: Record<string, unknown>; strict: boolean } | null;
  promptTemplateId: string | null;
  promptVersion: string | null;
  resolvedFrom: string;
}

// ---------------------------------------------------------------------------
// draft
// ---------------------------------------------------------------------------

/**
 * TASK-355 Phase D — two-phase (optimistic) delivery discriminator on the
 * persist-draft contract.
 *   - `DRAFT_PENDING_SENSORS` (early): persist the readable draft BEFORE the
 *     inferential assurance pass completes. Computational scores only; the
 *     gate verdict + assurance-complete marker are deliberately withheld
 *     (`gateDecision`/`assuranceCompletedAt` stay NULL) and status becomes
 *     `DRAFT_PENDING_SENSORS`. NO SENSOR_RUN audit (no verdict exists yet).
 *   - `FINALIZE` / absent (legacy): single-shot persist — assurance already
 *     complete, so the meta is fully scored, `assuranceCompletedAt` is stamped,
 *     status flips straight to `PENDING_REVIEW`, and SENSOR_RUN is recorded.
 */
export const HARNESS_DRAFT_PHASE = {
  EARLY: 'DRAFT_PENDING_SENSORS',
  FINALIZE: 'FINALIZE',
} as const;
export type HarnessDraftPhase = (typeof HARNESS_DRAFT_PHASE)[keyof typeof HARNESS_DRAFT_PHASE];

export class HarnessDraftRequest {
  @ApiProperty({ description: 'Tenant the harness is acting on behalf of' })
  @IsString()
  tenantId: string;

  @ApiPropertyOptional({ description: 'Responsible user id, if any' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ description: 'SSE job id minted at start, for progress notifications' })
  @IsOptional()
  @IsString()
  jobId?: string;

  @ApiProperty({ description: 'The generated SOAP note content' })
  @IsString()
  content: string;

  @ApiPropertyOptional({ description: 'Generating model name' })
  @IsOptional()
  @IsString()
  modelName?: string;

  @ApiPropertyOptional({ description: 'Generating model version' })
  @IsOptional()
  @IsString()
  modelVersion?: string;

  @ApiPropertyOptional({ description: 'Full sensor score detail object' })
  @IsOptional()
  @IsObject()
  sensorScores?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Per-claim citation/provenance map' })
  @IsOptional()
  @IsObject()
  citationsMap?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Guardrail / inferential-sensor decision detail (safety, groundedness, PHI)' })
  @IsOptional()
  @IsObject()
  guardrailDecisions?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Whether inferential assurance was reduced (judge/safety backend degraded)' })
  @IsOptional()
  @IsBoolean()
  reducedAssurance?: boolean;

  @ApiPropertyOptional({ description: 'Entity-faithfulness sensor score column' })
  @IsOptional()
  @IsNumber()
  entityFaithfulnessScore?: number;

  @ApiPropertyOptional({ description: 'Coverage/omission sensor score column' })
  @IsOptional()
  @IsNumber()
  coverageScore?: number;

  @ApiPropertyOptional({ description: 'RAG-triad score column' })
  @IsOptional()
  @IsNumber()
  ragTriadScore?: number;

  @ApiPropertyOptional({ description: 'Resolved prompt template id (from assemble)' })
  @IsOptional()
  @IsString()
  promptTemplateId?: string;

  @ApiPropertyOptional({ description: 'Resolved prompt version (from assemble)' })
  @IsOptional()
  @IsString()
  promptVersion?: string;

  @ApiPropertyOptional({ description: 'DNA writing style id used for generation' })
  @IsOptional()
  @IsString()
  dnaStyleId?: string;

  @ApiPropertyOptional({ description: 'Gate verdict (PASS | REGEN | FLAG)' })
  @IsOptional()
  @IsString()
  gateDecision?: string;

  @ApiPropertyOptional({ description: 'Whether this draft was produced by an auto-triggered pipeline' })
  @IsOptional()
  @IsBoolean()
  isAutoGenerated?: boolean;

  @ApiPropertyOptional({
    description:
      'TASK-355 Phase D — two-phase delivery discriminator. DRAFT_PENDING_SENSORS = early optimistic persist (assurance deferred to finalizeAssurance); FINALIZE/absent = legacy single-shot (assurance already complete).',
    enum: [HARNESS_DRAFT_PHASE.EARLY, HARNESS_DRAFT_PHASE.FINALIZE],
  })
  @IsOptional()
  @IsString()
  @IsIn([HARNESS_DRAFT_PHASE.EARLY, HARNESS_DRAFT_PHASE.FINALIZE])
  phase?: HarnessDraftPhase;
}

export interface HarnessDraftResponse {
  contextItemId: string;
}

// ---------------------------------------------------------------------------
// finalize-assurance (TASK-355 Phase D — second phase of optimistic delivery)
// ---------------------------------------------------------------------------

/**
 * Completes the two-phase delivery: the inferential assurance pass has finished,
 * so we backfill the early-persisted SummaryMeta with the inferential scores +
 * gate verdict, stamp `assuranceCompletedAt`, flip the consultation
 * `DRAFT_PENDING_SENSORS → PENDING_REVIEW`, and record the SENSOR_RUN (and
 * REDUCED_ASSURANCE) WORM audit. Targets the RAW_SUMMARY persisted in the early
 * phase by its `contextItemId`.
 */
export class HarnessFinalizeAssuranceRequest {
  @ApiProperty({ description: 'Tenant the harness is acting on behalf of' })
  @IsString()
  tenantId: string;

  @ApiPropertyOptional({ description: 'Responsible user id, if any' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ description: 'SSE job id minted at start, for progress notifications' })
  @IsOptional()
  @IsString()
  jobId?: string;

  @ApiProperty({ description: 'The RAW_SUMMARY ContextItem persisted in the early phase (assurance target)' })
  @IsString()
  contextItemId: string;

  @ApiPropertyOptional({ description: 'Full sensor score detail object (computational + inferential)' })
  @IsOptional()
  @IsObject()
  sensorScores?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Per-claim citation/provenance map' })
  @IsOptional()
  @IsObject()
  citationsMap?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Guardrail / inferential-sensor decision detail (safety, groundedness, PHI)' })
  @IsOptional()
  @IsObject()
  guardrailDecisions?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'RAG-triad score column' })
  @IsOptional()
  @IsNumber()
  ragTriadScore?: number;

  @ApiPropertyOptional({ description: 'Gate verdict (PASS | REGEN | FLAG)' })
  @IsOptional()
  @IsString()
  gateDecision?: string;

  @ApiPropertyOptional({ description: 'Whether inferential assurance was reduced (judge/safety backend degraded)' })
  @IsOptional()
  @IsBoolean()
  reducedAssurance?: boolean;

  @ApiPropertyOptional({ description: 'Generating model name (echoed into the SENSOR_RUN audit)' })
  @IsOptional()
  @IsString()
  modelName?: string;

  @ApiPropertyOptional({ description: 'Generating model version (echoed into the SENSOR_RUN audit)' })
  @IsOptional()
  @IsString()
  modelVersion?: string;

  @ApiPropertyOptional({ description: 'Resolved prompt template id' })
  @IsOptional()
  @IsString()
  promptTemplateId?: string;

  @ApiPropertyOptional({ description: 'Resolved prompt version' })
  @IsOptional()
  @IsString()
  promptVersion?: string;
}

export interface HarnessFinalizeAssuranceResponse {
  recorded: boolean;
  contextItemId: string;
}

// ---------------------------------------------------------------------------
// progress (TASK-345 — live harness activity feed)
// ---------------------------------------------------------------------------

/**
 * Stage key the harness sends to close the feed: the service marks every stage
 * completed and publishes a terminal `closed: true` event (ends the SSE relay).
 */
export const HARNESS_PROGRESS_TERMINAL_STAGE = 'completed';

/**
 * Failure terminal pseudo-stage (TASK-348 / MAJ-1): the workflow emits this
 * best-effort when the document loop fails. The service marks the currently
 * active stage `failed`, freezes the rest, and closes the feed (`closed: true`)
 * so the SSE stream ends instead of replaying a lying `active` snapshot.
 * Mirrors `HARNESS_PROGRESS_FAILED_STAGE` in apps/harness `models.py`.
 */
export const HARNESS_PROGRESS_FAILED_STAGE = 'failed';

/**
 * The fixed server-side stage catalog (TASK-348 / MAJ-6 — ENH-4 mirror of
 * `HARNESS_PROGRESS_STAGES` in apps/harness `models.py`). Both sides deploy
 * from this repo: adding a workflow stage requires updating BOTH catalogs, or
 * the internal endpoint rejects the unknown key (fail-closed payload bound).
 */
export const HARNESS_PROGRESS_STAGE_KEYS = [
  'extracting_information',
  'assembling_context',
  'drafting_note',
  'running_safety_sensors',
  'finalizing_draft',
] as const;

// TASK-348 / MAJ-6: payload bounds. The snapshot is rebroadcast to every SSE
// subscriber, so each field is capped at the validation pipe and `stage` is
// pinned to the fixed server-side catalog (both sides ship from this repo —
// a new workflow stage lands by updating both catalog mirrors together).
export class HarnessProgressRequest {
  @ApiProperty({ description: 'Tenant the harness is acting on behalf of' })
  @IsString()
  @MaxLength(256)
  tenantId: string;

  @ApiPropertyOptional({ description: 'Harness job id minted at start (run identity for the fold + ops/log correlation)' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  jobId?: string;

  @ApiProperty({ description: 'Workflow stage key (e.g. drafting_note); `completed`/`failed` close the feed' })
  @IsString()
  @MaxLength(128)
  @IsIn([...HARNESS_PROGRESS_STAGE_KEYS, HARNESS_PROGRESS_TERMINAL_STAGE, HARNESS_PROGRESS_FAILED_STAGE])
  stage: string;

  @ApiPropertyOptional({ description: 'Human-readable stage label rendered by the UI' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  label?: string;

  @ApiPropertyOptional({ description: '1-based position of the stage in the run' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(50)
  ordinal?: number;

  @ApiPropertyOptional({ description: 'Total number of stages in the run' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(50)
  total?: number;
}

export interface HarnessProgressAck {
  ok: boolean;
}

export type HarnessProgressStageStatus = 'completed' | 'active' | 'pending' | 'failed';

export interface HarnessProgressStageDto {
  stage: string;
  label: string;
  ordinal: number;
  status: HarnessProgressStageStatus;
  /** How many times the stage has been (re)entered — >1 communicates a regen pass. */
  attempt: number;
  /** ISO timestamp of the stage's last activation. */
  at: string;
}

/**
 * The full-state progress event published on
 * `consultation:harness-progress:{consultationId}` (and stored as the late-join
 * snapshot). Every SSE message carries the complete folded state, so clients
 * stay stateless. Carries NO PHI — stage keys/labels/timestamps only.
 */
export interface HarnessProgressEventDto {
  consultationId: string;
  /**
   * Tenant the run belongs to (TASK-348 / MIN-5). Folded from the internal
   * request for ops correlation; the SSE route is independently tenant-guarded
   * (`@TenantOwnedResource`), so this is informational, not an access check.
   */
  tenantId?: string;
  jobId?: string;
  total?: number;
  stages: HarnessProgressStageDto[];
  updatedAt: string;
  closed: boolean;
}

// ---------------------------------------------------------------------------
// gate-decision
// ---------------------------------------------------------------------------

export class HarnessGateDecisionRequest {
  @ApiProperty({ description: 'Tenant the harness is acting on behalf of' })
  @IsString()
  tenantId: string;

  @ApiPropertyOptional({ description: 'Responsible user id, if any' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ description: 'Clinician sign-off decision (e.g. SIGNED | REJECTED)' })
  @IsOptional()
  @IsString()
  decision?: string;

  @ApiPropertyOptional({ description: 'Gate verdict at draft time (PASS | REGEN | FLAG)' })
  @IsOptional()
  @IsString()
  gateDecision?: string;

  @ApiPropertyOptional({ description: 'The signed ContextItemVersion id' })
  @IsOptional()
  @IsString()
  contextItemVersionId?: string;

  @ApiPropertyOptional({ description: 'Attestation hash bound to the signed note' })
  @IsOptional()
  @IsString()
  attestationHash?: string;

  @ApiPropertyOptional({ description: 'Clinician who signed off' })
  @IsOptional()
  @IsString()
  clinicianId?: string;
}

export interface HarnessGateDecisionResponse {
  recorded: boolean;
}

// ---------------------------------------------------------------------------
// assurance live feed (TASK-355 Phase D Slice 5d — Q5 true mid-pass streaming)
// ---------------------------------------------------------------------------

/**
 * Verdict sensors the optimistic assurance pass streams per claim. Pinned at the
 * HTTP edge (defense-in-depth) — the feed is rebroadcast to every SSE viewer.
 */
export const HARNESS_ASSURANCE_SENSOR_KEYS = ['groundedness', 'citation_verify', 'safety'] as const;

/**
 * One per-claim verdict event the harness `run_inferential_sensors` activity
 * publishes AS EACH CLAIM RESOLVES (Q5 true-live). Carries NO PHI — ids, sensor
 * key, verdict label, ordinal/counts only (never the claim text or the note).
 */
export class HarnessAssuranceEventRequest {
  @ApiProperty({ description: 'Tenant the harness is acting on behalf of' })
  @IsString()
  @MaxLength(256)
  tenantId: string;

  @ApiPropertyOptional({ description: 'Harness job id minted at start (run identity for the fold + ops correlation)' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  jobId?: string;

  @ApiProperty({ description: 'Stable id of the claim being verified (no PHI)' })
  @IsString()
  @MaxLength(256)
  claimId: string;

  @ApiProperty({ description: 'Which inferential sensor produced the verdict' })
  @IsString()
  @MaxLength(64)
  @IsIn([...HARNESS_ASSURANCE_SENSOR_KEYS])
  sensor: string;

  @ApiProperty({ description: 'The per-claim verdict (e.g. grounded | ungrounded | pass | flag)' })
  @IsString()
  @MaxLength(64)
  verdict: string;

  @ApiPropertyOptional({ description: 'Optional human-readable label for the claim/section' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  label?: string;

  @ApiPropertyOptional({ description: '1-based position of this claim in the pass' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(1000)
  ordinal?: number;

  @ApiPropertyOptional({ description: 'Total claims expected in the pass (for an N/M counter)' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(1000)
  total?: number;
}

export interface HarnessAssuranceAck {
  ok: boolean;
}

/** One resolved claim verdict held in the accumulated assurance snapshot. */
export interface HarnessAssuranceClaimDto {
  claimId: string;
  sensor: string;
  verdict: string;
  label?: string;
  ordinal?: number;
  /** ISO timestamp the verdict resolved. */
  at: string;
}

/**
 * The full-state assurance event published on
 * `consultation:harness-assurance:{consultationId}` (and stored as the late-join
 * snapshot). Every SSE message carries the complete accumulated state, so
 * clients stay stateless. Carries NO PHI. The terminal `assurance_complete`
 * event sets `closed: true` and the aggregate verdict fields.
 */
export interface HarnessAssuranceEventDto {
  consultationId: string;
  tenantId?: string;
  jobId?: string;
  total?: number;
  claims: HarnessAssuranceClaimDto[];
  /** Aggregate gate verdict (PASS | REGEN | FLAG) — terminal event only. */
  gateDecision?: string | null;
  /** True when the safety sensor FLAGged the note — terminal event only. */
  safetyFlag?: boolean;
  /** True when assurance ran with reduced coverage (a sensor degraded). */
  reducedAssurance?: boolean;
  /**
   * Q2b — the note was already SIGNED (early sign) when this adverse verdict
   * landed; the UI raises an amendment/follow-up alert. Terminal event only.
   */
  postSignAlert?: boolean;
  updatedAt: string;
  closed: boolean;
}
