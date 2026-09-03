import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * / RC-2 — the two realtime-delivery planes the interpreter
 * publishes clinician-facing output through.
 *
 * ## Why these exist
 *
 * enumerated all 18 `/internal/harness/*` routes and found NONE that
 * accepts clinical summary text. The single text-accepting write is
 * `POST .../draft`, which creates a `RAW_SUMMARY` ContextItem — the FINAL note,
 * the wrong kind for a mid-consultation snapshot, and exactly the row the
 * substrate-exclusivity gate governs. So an interpreter graph could compute a
 * realtime summary, a set of suggestions or a list of correction proposals, and
 * none of it could reach a clinician.
 *
 * ## Two planes, deliberately not one
 *
 * `live-summary` publishes VERBATIM onto the EXISTING
 * `consultation:live-summary:{id}` channel, so the existing SSE route,
 * `useArcaLiveSummary`, and the console panel all work unchanged — zero new
 * consumer surface.
 *
 * `live-assist` is a NEW channel because it is a different thing: it is
 * **DECLARED PHI-CARRYING** (a correction proposal quotes the span it would
 * replace, verbatim). It is a sibling of `live-summary`, never of the loop
 * event plane — `EmitLoopEventInput` is `extra="forbid"` and its contract says
 * it carries "ids/keys/labels only, NEVER note or transcript text". Routing
 * proposals through the loop plane would put note text on a transport that
 * explicitly refuses to carry it.
 *
 * ## Why every optional is optional and never nullable
 *
 * The gateway's global pipe runs `whitelist + forbidNonWhitelisted +
 * forbidUnknownValues`, so an undeclared key 400s the entire publish. The
 * harness client therefore PRUNES absent optionals rather than sending `null`
 * (`test_omits_absent_optional_fields`), and these DTOs match that: absent is
 * valid, `null` is not.
 *
 * Contract source of truth:
 * `apps/harness/src/harness/tests/unit/services/test_live_delivery_client.py`.
 */

/** The only `source` value this plane accepts today. */
export const LIVE_SUMMARY_SOURCE_INTERPRETER = 'interpreter';

/** Bounds that keep one malformed publish from becoming an unbounded Redis payload. */
const MAX_SECTIONS = 32;
const MAX_SUGGESTIONS = 50;
const MAX_PROPOSALS = 200;

export class HarnessLiveSummarySectionDto {
  @ApiProperty({ description: 'Section heading, e.g. "Subjective"' })
  @IsString()
  title: string;

  @ApiProperty({ description: 'Section body text' })
  @IsString()
  content: string;
}

/**
 * RC-1 — `POST /internal/harness/consultations/:id/live-summary`.
 *
 * `consultationId` is NOT a body field: it comes from the path, so a body that
 * disagreed with the URL is structurally impossible.
 */
export class HarnessLiveSummaryRequest {
  @ApiProperty({ description: 'Tenant the interpreter run belongs to. Mandatory — a clinical publish must be attributable.' })
  @IsString()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({
    description: 'The running summary as of this flush. MAY be empty: an early flush can legitimately have produced no text yet.',
  })
  @IsString()
  runningSummary: string;

  @ApiProperty({ description: 'The summary split into sections', type: [HarnessLiveSummarySectionDto] })
  @IsArray()
  @ArrayMaxSize(MAX_SECTIONS)
  @ValidateNested({ each: true })
  @Type(() => HarnessLiveSummarySectionDto)
  sections: HarnessLiveSummarySectionDto[];

  @ApiProperty({ description: "Which engine produced this snapshot. Always 'interpreter' on this route." })
  @IsIn([LIVE_SUMMARY_SOURCE_INTERPRETER])
  source: string;

  @ApiPropertyOptional({ description: 'The interpreter node that produced it, e.g. `consultation.realtimeSummary`' })
  @IsOptional()
  @IsString()
  nodeType?: string;

  @ApiPropertyOptional({ description: '1-based position of this flush within the run' })
  @IsOptional()
  @IsInt()
  @Min(0)
  ordinal?: number;

  @ApiPropertyOptional({ description: 'Total flushes expected in the run, when known' })
  @IsOptional()
  @IsInt()
  @Min(0)
  total?: number;

  @ApiPropertyOptional({ description: 'Serving provider for this generation' })
  @IsOptional()
  @IsString()
  provider?: string;

  @ApiPropertyOptional({ description: 'Model id used for this generation' })
  @IsOptional()
  @IsString()
  model?: string;

  @ApiPropertyOptional({ description: 'The AiTaskDefault routing key this generation resolved through' })
  @IsOptional()
  @IsString()
  taskKey?: string;

  @ApiPropertyOptional({ description: 'Clinician the run is acting for' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ description: 'Harness job id' })
  @IsOptional()
  @IsString()
  jobId?: string;

  @ApiPropertyOptional({ description: 'Interpreter run id' })
  @IsOptional()
  @IsString()
  runId?: string;
}

export class HarnessLiveAssistSuggestionDto {
  @ApiProperty({ description: 'Stable id for this suggestion, so the console can accept/dismiss it' })
  @IsString()
  @IsNotEmpty()
  suggestionId: string;

  @ApiProperty({ description: 'The suggestion shown to the clinician' })
  @IsString()
  text: string;

  @ApiPropertyOptional({ description: 'Free-form grouping key, e.g. "history"' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ description: 'Lifecycle state as the interpreter sees it, e.g. PROPOSED' })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ description: 'Attribution, e.g. "lm-studio:a-model"' })
  @IsOptional()
  @IsString()
  proposedBy?: string;
}

/**
 * One PROPOSED correction. Nothing here has been applied to any note — see
 * {@link HarnessLiveAssistCorrectionsDto.applied}.
 *
 * `original` quotes the clinician's own text verbatim, which is why this whole
 * plane is declared PHI-carrying.
 */
export class HarnessLiveAssistProposalDto {
  @ApiProperty({ description: 'Stable id, so an accept/reject decision is attributable to one proposal' })
  @IsString()
  @IsNotEmpty()
  proposalId: string;

  @ApiProperty({ description: 'Character offset where the replaced span starts' })
  @IsInt()
  @Min(0)
  start: number;

  @ApiProperty({ description: 'Character offset where the replaced span ends' })
  @IsInt()
  @Min(0)
  end: number;

  @ApiProperty({ description: 'The existing text, verbatim (PHI)' })
  @IsString()
  original: string;

  @ApiProperty({ description: 'The proposed replacement' })
  @IsString()
  proposed: string;

  @ApiPropertyOptional({ description: 'What kind of correction, e.g. "drugName"' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ description: 'Model/detector confidence, 0.0 - 1.0' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  confidence?: number;

  @ApiPropertyOptional({ description: 'Why the correction is proposed, shown to the clinician' })
  @IsOptional()
  @IsString()
  rationale?: string;

  @ApiPropertyOptional({ description: 'What flagged it, e.g. "nlp.ner"' })
  @IsOptional()
  @IsString()
  detectedBy?: string;

  @ApiPropertyOptional({ description: 'What proposed the replacement, e.g. "lm-studio:a-model"' })
  @IsOptional()
  @IsString()
  proposedBy?: string;

  @ApiPropertyOptional({ description: 'Lifecycle state as the interpreter sees it, e.g. PROPOSED' })
  @IsOptional()
  @IsString()
  status?: string;
}

export class HarnessLiveAssistCorrectionsDto {
  @ApiProperty({ description: 'The proposals, newest run wins', type: [HarnessLiveAssistProposalDto] })
  @IsArray()
  @ArrayMaxSize(MAX_PROPOSALS)
  @ValidateNested({ each: true })
  @Type(() => HarnessLiveAssistProposalDto)
  proposals: HarnessLiveAssistProposalDto[];

  @ApiProperty({
    description:
      'Whether the machine already wrote these corrections into the note. Proposal-first means this is `false`: the clinician decides. Declared REQUIRED precisely so a publish can never be ambiguous about it.',
  })
  @IsBoolean()
  applied: boolean;

  @ApiPropertyOptional({ description: 'How many proposals were auto-applied (0 under proposal-first)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  appliedCount?: number;

  @ApiPropertyOptional({ description: 'How many the interpreter itself discarded before publishing' })
  @IsOptional()
  @IsInt()
  @Min(0)
  rejectedProposals?: number;

  @ApiPropertyOptional({
    description: 'SHA-256 of the text the offsets were computed against, so the console can refuse to apply a proposal to drifted text',
  })
  @IsOptional()
  @IsString()
  @Length(64, 64)
  textSha256?: string;
}

/** RC-2 — `POST /internal/harness/consultations/:id/live-assist`. */
export class HarnessLiveAssistRequest {
  @ApiProperty({ description: 'Tenant the interpreter run belongs to' })
  @IsString()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ description: 'Which branch this publish carries', enum: ['suggestions', 'corrections'] })
  @IsIn(['suggestions', 'corrections'])
  kind: 'suggestions' | 'corrections';

  @ApiPropertyOptional({ description: 'The interpreter node that produced it' })
  @IsOptional()
  @IsString()
  nodeType?: string;

  @ApiPropertyOptional({ description: 'Serving provider' })
  @IsOptional()
  @IsString()
  provider?: string;

  @ApiPropertyOptional({ description: 'Model id' })
  @IsOptional()
  @IsString()
  model?: string;

  @ApiPropertyOptional({ description: 'Clinician the run is acting for' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ description: 'Harness job id' })
  @IsOptional()
  @IsString()
  jobId?: string;

  @ApiPropertyOptional({ description: 'Present on a `suggestions` publish', type: [HarnessLiveAssistSuggestionDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_SUGGESTIONS)
  @ValidateNested({ each: true })
  @Type(() => HarnessLiveAssistSuggestionDto)
  suggestions?: HarnessLiveAssistSuggestionDto[];

  @ApiPropertyOptional({ description: 'Present on a `corrections` publish', type: HarnessLiveAssistCorrectionsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => HarnessLiveAssistCorrectionsDto)
  corrections?: HarnessLiveAssistCorrectionsDto;
}

/** Both routes ack best-effort, exactly like `progress` / `assurance-event` / `loop-event`. */
export interface HarnessRealtimeDeliveryAck {
  ok: boolean;
}

/**
 * The event relayed on `consultation:live-assist:{id}`.
 *
 * Both branches are carried on ONE snapshot so a late-joining clinician sees the
 * current suggestions AND the current proposals; a publish replaces only the
 * branch it carries and leaves the other one standing.
 */
export interface LiveAssistEventDto {
  consultationId: string;
  tenantId?: string;
  suggestions?: HarnessLiveAssistSuggestionDto[];
  corrections?: HarnessLiveAssistCorrectionsDto;
  /** Which node last wrote each branch, for provenance in the panel. */
  suggestionsNodeType?: string;
  correctionsNodeType?: string;
  provider?: string;
  model?: string;
  updatedAt: string;
}
