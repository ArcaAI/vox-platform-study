import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * A single medical entity detected by the NLP service for the running summary.
 *
 * Mirrors the `/api/v1/classify/tokens` NLP response shape, re-keyed for the
 * frontend highlight overlay (`text` → `text`, `entity_type` → `type`).
 *
 * (SOTA C2 · SPEER): NER runs over the RAW TRANSCRIPT (the source of truth), NOT the
 * generated note, so a summary hallucination can never be laundered into a clinical entity. Each
 * entity is then GROUNDED — re-located into `runningSummary` — so `start`/`end` are character
 * offsets into that flat text (the same text the panel renders), letting the UI map each entity
 * into the section it belongs to. Only transcript-supported mentions that also occur in the
 * rendered note are surfaced; a note-only mention with no transcript support is never surfaced.
 */
export class LiveSummaryEntityDto {
  @ApiProperty({ description: 'The recognized text span (NLP `text`)' })
  text: string;

  @ApiProperty({ description: 'Entity class (e.g., MEDICATION, CONDITION, PROCEDURE, ANATOMY)' })
  type: string;

  @ApiPropertyOptional({ description: 'Model confidence (0.0 - 1.0)' })
  confidence?: number;

  @ApiPropertyOptional({
    description:
      'ICD-10-CM code linked to this entity by the NLP OntologyLinker (curated deterministic vocabulary), when one matched. Absent for entities outside the linker vocabulary — never fabricated.',
  })
  icd10?: string;

  @ApiPropertyOptional({ description: 'Character offset start within `runningSummary`' })
  start?: number;

  @ApiPropertyOptional({ description: 'Character offset end within `runningSummary`' })
  end?: number;
}

/**
 * Structured vital signs deterministically extracted by the NLP service
 * (`Vitals`). Every field is optional + null-safe — an un-parsed or
 * out-of-range value stays absent; never fabricated. BP is split into
 * systolic/diastolic integers.
 */
export class LiveSummaryVitalsDto {
  @ApiPropertyOptional({ description: 'Systolic blood pressure (mmHg)' })
  systolic?: number;

  @ApiPropertyOptional({ description: 'Diastolic blood pressure (mmHg)' })
  diastolic?: number;

  @ApiPropertyOptional({ description: 'Heart rate (bpm)' })
  heartRate?: number;

  @ApiPropertyOptional({ description: 'Oxygen saturation (%)' })
  spo2?: number;

  @ApiPropertyOptional({ description: 'Temperature (°C)' })
  temperatureC?: number;

  @ApiPropertyOptional({ description: 'Weight (kg)' })
  weightKg?: number;
}

/**
 * A logical section of the running summary. When the TEXT output parses as a
 * structured SOAP note the service emits the four canonical sections in order
 * (`Subjective`, `Objective`, `Assessment`, `Plan`) — some may have empty
 * `content` until the visit populates them. If the output is unstructured it
 * falls back to a single `Running Summary` section.
 */
export class LiveSummarySectionDto {
  @ApiProperty({ description: 'Section title: "Subjective" | "Objective" | "Assessment" | "Plan", or "Running Summary" (fallback)' })
  title: string;

  @ApiProperty({ description: 'Section body text (a contiguous substring of `runningSummary`); may be empty if not yet populated' })
  content: string;
}

/**
 * Offsets (into `runningSummary`) of a flagged — ungrounded — span.
 * Same offset contract as {@link LiveSummaryEntityDto} so the panel maps spans into
 * sections the way it already maps entity highlights.
 */
export class LiveSummaryFlaggedSpanDto {
  @ApiProperty({ description: 'Character offset start within `runningSummary`' })
  start: number;

  @ApiProperty({ description: 'Character offset end within `runningSummary`' })
  end: number;
}

/**
 * Groundedness verdict for one segment (sentence/line) of `runningSummary`.
 * `grounded` = the self-hosted NLI verified the segment against
 * the source transcript; `ungrounded` = the model contradicts/does not support it;
 * `unverified` = the gate could not check it (disabled, model unavailable, or an
 * error) — NEVER presented as verified.
 */
export class LiveSummaryGroundednessSegmentDto {
  @ApiProperty({ description: 'The segment text (a stripped substring of `runningSummary`)' })
  text: string;

  @ApiProperty({ description: 'Per-segment verdict', enum: ['grounded', 'ungrounded', 'unverified'] })
  verdict: 'grounded' | 'ungrounded' | 'unverified';

  @ApiPropertyOptional({ description: 'NLI entailment score (0.0 - 1.0) when the model ran' })
  score?: number;

  @ApiPropertyOptional({ description: 'Character offset start within `runningSummary`' })
  start?: number;

  @ApiPropertyOptional({ description: 'Character offset end within `runningSummary`' })
  end?: number;
}

/**
 * Output-side groundedness verdict for the running summary.
 *
 * Attached by the live-documentation flush AFTER the note is built and BEFORE it is
 * published, so an ungrounded segment can never reach the clinician unmarked. Worst-state
 * rollup: `ungrounded` > `unverified` > `grounded`. Fail-closed contract: an unavailable
 * or erroring gate yields `unverified` — no error path ever yields `grounded`. The live
 * mark is ephemeral UX; the durable harness remains the system of record.
 */
export class LiveSummaryGroundednessDto {
  @ApiProperty({
    description: 'Worst-state rollup across segments (`ungrounded` > `unverified` > `grounded`)',
    enum: ['grounded', 'ungrounded', 'unverified'],
  })
  verdict: 'grounded' | 'ungrounded' | 'unverified';

  @ApiPropertyOptional({ description: 'Per-segment verdicts', type: [LiveSummaryGroundednessSegmentDto] })
  segments?: LiveSummaryGroundednessSegmentDto[];

  @ApiPropertyOptional({ description: 'Offsets of the ungrounded spans within `runningSummary`', type: [LiveSummaryFlaggedSpanDto] })
  flaggedSpans?: LiveSummaryFlaggedSpanDto[];

  @ApiProperty({ description: 'ISO-8601 timestamp of when the verdict was produced' })
  checkedAt: string;
}

/**
 * AD-1 generation statistics for one live-summary flush.
 *
 * A near-verbatim passthrough of the TEXT `/generate` `stats` block (the program's
 * single normalized GenerationStats contract), minus `engine_native` (the raw
 * per-provider timings/usage blob is kept server-side, never streamed to the
 * browser). Field names mirror the TEXT wire contract (snake_case) so the console
 * / gateway wave consumes the same shape TEXT emits. All fields are optional +
 * nullable: today the non-stream `stop_reason` is often `"stop"` and only the
 * token counts are populated; per-provider fidelity (ttft/tok-s) fills in later
 * engine waves. Never fabricated — a field the engine omitted stays null/absent.
 */
export class LiveSummaryStatsDto {
  @ApiPropertyOptional({ description: 'Normalized stop reason: stop | length | content_filter | tool_call | abort | error | other' })
  stop_reason?: string | null;

  @ApiPropertyOptional({ description: 'Provider-native stop reason, verbatim (e.g. "eosFound", "stopped_limit")' })
  stop_reason_raw?: string | null;

  @ApiPropertyOptional({ description: 'Total generation time in ms (request start → last byte)' })
  total_ms?: number | null;

  @ApiPropertyOptional({ description: 'Time-to-first-token in ms (stream first content/reasoning token, or engine-native)' })
  ttft_ms?: number | null;

  @ApiPropertyOptional({ description: 'Decode throughput (predicted tokens / decode time); engine-native preferred' })
  tokens_per_second?: number | null;

  @ApiPropertyOptional({ description: 'Prompt (input) token count' })
  prompt_tokens?: number | null;

  @ApiPropertyOptional({ description: 'Predicted (completion) token count' })
  predicted_tokens?: number | null;

  @ApiPropertyOptional({ description: 'Total token count' })
  total_tokens?: number | null;

  @ApiPropertyOptional({ description: 'Serving provider (e.g. "vllm", "llama-cpp", "openai_compat")' })
  provider?: string | null;

  @ApiPropertyOptional({ description: 'Model id used for the generation' })
  model?: string | null;

  @ApiPropertyOptional({
    description:
      "The AiTaskDefault routing key this flush's TEXT call resolved through (Lane B) — 'text.live' for the live running-note tier. Lets the console/stat cards show WHICH tier (and therefore which admin-managed model) actually served this flush, distinct from the one-shot/finalize tier.",
  })
  task_key?: string | null;

  @ApiPropertyOptional({
    description:
      "whether this flush's model came from the session agent's frozen `llmOverrides.live` ('agent-override') or from the tenant's per-flush `text.live` AiTaskDefault ('task-default').",
  })
  selection_source?: string | null;
}

/**
 * The agent identity FROZEN for this live session.
 *
 * Resolved once at recording start and served unchanged for the whole session,
 * so every event of a session reports the same `(promptTemplateId,
 * promptVersionNumber)` pin — that stability is the point: it is the same
 * lineage that reaches finalize through the durable snapshot (Lane C5), so a
 * clinician-visible live note and its final note provably share one agent.
 *
 * Absent when the loop fell open to the in-code prompt constants (there is no
 * governed identity to report in that case).
 */
export class LiveSummaryAgentDto {
  @ApiPropertyOptional({ description: 'DepartmentAgent id, or null when a non-agent tier resolved', nullable: true })
  id: string | null;

  @ApiPropertyOptional({ description: 'DepartmentAgent name, or null when a non-agent tier resolved', nullable: true })
  name: string | null;

  @ApiPropertyOptional({ description: 'The governed PromptTemplate serving this session', nullable: true })
  promptTemplateId: string | null;

  @ApiPropertyOptional({ description: 'The IMMUTABLE PromptVersion number pinned for this session', nullable: true })
  promptVersionNumber: number | null;

  @ApiPropertyOptional({ description: "Which tier resolved: 'agent' | 'default' | 'code-default'" })
  resolvedFrom: string;
}

/**
 * Optional per-flush metadata envelope on the live-summary payload.
 * Carries the AD-1 generation {@link LiveSummaryStatsDto | stats} and the
 * session's frozen {@link LiveSummaryAgentDto | agent} identity; kept as a
 * nested envelope so future per-flush telemetry (trajectory refs, etc.) can be
 * added without reshaping the top-level event.
 */
export class LiveSummaryMetadataDto {
  @ApiPropertyOptional({ description: 'AD-1 generation stats for this flush (absent on a legacy idempotency-cache hit)', type: LiveSummaryStatsDto })
  stats?: LiveSummaryStatsDto | null;

  @ApiPropertyOptional({
    description: 'the agent identity frozen for this session. Additive: absent on the code-default tier and on every pre-existing client.',
    type: LiveSummaryAgentDto,
  })
  agent?: LiveSummaryAgentDto;
}

/**
 * Live-summary SSE event payload.
 *
 * Published to the Redis pub/sub channel `consultation:live-summary:{consultationId}`
 * by {@link LiveDocumentationService} and relayed verbatim to clients over
 * `GET /consultations/:id/live-summary/stream`. Transient — never persisted
 * per tick (the last snapshot may optionally be saved as a PRE_SUMMARY on stop).
 */
export class LiveSummaryEventDto {
  @ApiProperty({ description: 'Consultation this running summary belongs to' })
  consultationId: string;

  @ApiProperty({ description: 'Latest AI-generated running summary of the in-progress consultation' })
  runningSummary: string;

  @ApiProperty({ description: 'Summary broken into sections', type: [LiveSummarySectionDto] })
  sections: LiveSummarySectionDto[];

  @ApiProperty({ description: 'Medical entities detected in the running transcript', type: [LiveSummaryEntityDto] })
  entities: LiveSummaryEntityDto[];

  /**
   * Lane N — the IMPORTANT FINDINGS a tenant's own instruction picked out of this
   * consultation, grounded to `runningSummary` exactly as `entities` are.
   *
   * A SEPARATE array rather than a flag on `entities`, because the two are different claims. An
   * entity is what a detector RECOGNISED in the transcript; a finding is what the TENANT ADMIN'S
   * INSTRUCTION said matters. Each finding's `type` is the label that instruction told the model
   * to assign — the platform ships no importance vocabulary, no severity ladder and no red-flag
   * list, because the owner assigned that definition to the tenant admin.
   *
   * Optional and additive: absent when no `agent.important_findings` node is in the tenant's lane,
   * which is every graph authored before this ticket.
   */
  @ApiPropertyOptional({
    description:
      "Important findings picked out by the tenant's own agent instruction, grounded to `runningSummary`. `type` carries the label that instruction assigned — the platform supplies no importance vocabulary. Absent when the tenant's lane runs no important-findings node.",
    type: [LiveSummaryEntityDto],
  })
  findings?: LiveSummaryEntityDto[];

  @ApiPropertyOptional({ description: 'STT segment id of the last final segment folded into this summary' })
  lastSegmentId?: string;

  @ApiPropertyOptional({
    description:
      'Output-side groundedness verdict. Optional and back-compatible: absent when the gate is disabled; `unverified` when the gate could not check (never silently `grounded`).',
    type: LiveSummaryGroundednessDto,
  })
  groundedness?: LiveSummaryGroundednessDto;

  @ApiPropertyOptional({
    description:
      'Per-flush metadata. Carries the AD-1 generation stats under `metadata.stats`; absent when the TEXT call produced no stats (legacy idempotency-cache hit).',
    type: LiveSummaryMetadataDto,
  })
  metadata?: LiveSummaryMetadataDto;

  @ApiPropertyOptional({
    description:
      'Structured vital signs deterministically extracted by the NLP service. Accumulated field-wise across flushes (latest non-null wins) and absent until at least one vital is seen — never fabricated.',
    type: LiveSummaryVitalsDto,
  })
  vitals?: LiveSummaryVitalsDto;

  @ApiPropertyOptional({
    description:
      'True when the most recent TEXT generation call failed. `runningSummary`/`sections` reflect the last successfully generated content (or are empty on a first-flush failure) — never fabricated. Clients should render a visible degraded/stale indicator rather than treating the payload as fresh.',
  })
  textFailed?: boolean;

  /**
   * WHICH engine produced this snapshot.
   *
   * The plane now has two possible publishers: this service's own flush loop
   * (Substrate A's live documentation layer) and a tenant-authored interpreter
   * graph (Substrate B) publishing through
   * `POST /internal/harness/consultations/:id/live-summary`. Additive and
   * back-compatible: ABSENT means the flush loop, which is every payload
   * predating this field, so no existing consumer changes. `'interpreter'`
   * means the graph.
   *
   * A consumer that cannot tell them apart cannot explain what it is showing,
   * which is why this is carried rather than left implicit.
   */
  @ApiPropertyOptional({
    description: "Publisher of this snapshot: absent = the live-documentation flush loop, 'interpreter' = a tenant-authored graph",
  })
  source?: string;

  @ApiPropertyOptional({ description: 'RC-1 — the interpreter node that produced this snapshot, e.g. `consultation.realtimeSummary`' })
  nodeType?: string;

  @ApiPropertyOptional({ description: 'RC-1 — 1-based position of this flush within the interpreter run' })
  ordinal?: number;

  @ApiPropertyOptional({ description: 'RC-1 — total flushes expected in the interpreter run, when known' })
  total?: number;

  @ApiProperty({ description: 'ISO-8601 timestamp of when this snapshot was produced' })
  updatedAt: string;

  @ApiPropertyOptional({ description: 'True on the terminal event published when recording stops; clients may close the stream' })
  closed?: boolean;
}
