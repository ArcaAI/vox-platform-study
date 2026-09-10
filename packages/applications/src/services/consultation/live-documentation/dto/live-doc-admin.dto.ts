import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * TASK-891 B4 — ONE realtime-lane node that did not succeed on the last flush.
 *
 * The traced 2026-09-07 session degraded `consultation.realtimeSummary` on
 * `timeout of 20000ms exceeded` and `consultation.extractEntities` on
 * `connect ECONNREFUSED …:8864`, 55 times. Both reasons existed only in a gateway WARN
 * line, so the admin console showed a session flushing healthily while it produced zero
 * sections. This is the same typed `RealtimeDegradeEvent` the control channel already
 * carries, mirrored into the stats snapshot so the failure mode is legible from the
 * admin surface without pod access.
 *
 * PHI-safe by construction: node identity, an outcome status and a reason CODE or error
 * name — never clinical text.
 */
export class LiveDocNodeDegradeResponse {
  @ApiProperty({ description: 'Node id as authored in the graph' })
  nodeId: string;

  @ApiProperty({ description: 'Registered node type, e.g. `consultation.realtimeSummary`' })
  type: string;

  @ApiProperty({
    description: 'Non-success outcome of that node on the last flush',
    enum: ['degraded', 'failed', 'skipped', 'timed-out', 'stale'],
  })
  status: string;

  @ApiProperty({ description: 'PHI-safe reason code or error name — never clinical text' })
  reason: string;
}

/**
 * Per-session live-documentation engine stats.
 *
 * The PHI-safe snapshot the {@link LiveDocumentationService} publishes to Redis
 * (`live-doc:stats:{consultationId}`) on each flush and the admin live console
 * reads back. Sizes / latencies / counts only — never transcript or summary text.
 */
export class LiveDocSessionStatsResponse {
  @ApiProperty({ description: 'Consultation under live documentation' })
  consultationId: string;

  @ApiProperty({ description: 'Owning tenant id' })
  tenantId: string;

  @ApiPropertyOptional({ description: 'STT streaming session id bound to this recording' })
  sessionId?: string;

  @ApiProperty({ description: 'ISO-8601 timestamp of when the watcher session started' })
  startedAt: string;

  @ApiProperty({ description: 'ISO-8601 timestamp of the last published flush' })
  lastUpdatedAt: string;

  @ApiProperty({ description: 'Number of flushes published so far' })
  flushCount: number;

  @ApiProperty({ description: 'Monotonic flush generation id of the last flush' })
  generation: number;

  @ApiProperty({ description: 'TEXT running-summary latency of the last flush (ms)' })
  textLatencyMs: number;

  @ApiProperty({ description: 'NLP entity-extraction latency of the last flush (ms)' })
  nlpLatencyMs: number;

  @ApiProperty({ description: 'Whether the last TEXT call failed (prior summary retained)' })
  textFailed: boolean;

  @ApiProperty({ description: 'Whether the last NLP call failed (prior entities retained)' })
  nlpFailed: boolean;

  @ApiProperty({ description: 'Count of superseded (stale) generations dropped without publishing' })
  staleDropCount: number;

  @ApiProperty({ description: 'Number of medical entities in the last published summary' })
  entityCount: number;

  @ApiProperty({ description: 'Number of summary sections in the last published summary' })
  sectionCount: number;

  @ApiProperty({ description: 'Character length of the last running summary (size only, no text)' })
  summaryChars: number;

  @ApiPropertyOptional({
    description:
      'TASK-891 B4 — the realtime lane nodes that did NOT succeed on the last flush, with their reasons. `textFailed`/`nlpFailed` say THAT the two legacy stages failed; this says WHICH node and WHY, which is the difference between reading this endpoint and reading pod logs. Empty/absent on a clean flush and on the legacy (non-graph) engine, which has no nodes.',
    type: [LiveDocNodeDegradeResponse],
  })
  nodeDegrades?: LiveDocNodeDegradeResponse[];

  @ApiProperty({
    description:
      'TASK-939 — NOTE CHURN: how many characters of text the clinician had ALREADY READ this flush rewrote. `0` is the healthy value and the design target: an additive turn appends, so previously published text is a prefix of what replaces it. A non-zero value means a section was rewritten rather than extended, which is the defect this ticket exists to remove — it is legitimate only where the model named a transcript contradiction (`turnSectionsRewritten`). Characters only, never text: this is a PHI-safe size.',
  })
  noteChurnChars: number;

  @ApiProperty({ description: 'TASK-939 — sections this flush EXTENDED (the ordinary, cheap case).' })
  turnSectionsAppended: number;

  @ApiProperty({
    description:
      'TASK-939 — sections this flush REPLACED. Each one should be a transcript contradiction the model named; a session where this is routinely high is regenerating rather than accumulating.',
  })
  turnSectionsRewritten: number;

  @ApiProperty({
    description:
      'TASK-939 — rewrites the turn contract REFUSED because no contradiction was named. The prior text stood. A high count means the model is trying to restate itself and the guard is doing its job.',
  })
  turnRefusedRewrites: number;

  @ApiProperty({
    description:
      'TASK-939 — true when the generation could not be read as a TURN and this flush fell back to a whole-document rewrite (a provider that ignores `response_format`, typically). That is the PRE-ticket behaviour, so a tenant permanently in this state still sees the whole note re-render and is a finding, not a detail.',
  })
  turnDegraded: boolean;

  @ApiProperty({
    description:
      'TASK-946 D6 — true when this flush produced NO note: the document generation did not succeed, or an `onError: "fail"` node stopped the lane. Distinct from both neighbours, which is why it exists: `turnDegraded` is a QUALITY signal about a flush that succeeded (the turn contract fell back to a whole-document rewrite) and `textFailed` names one stage, so before this field a reader of the snapshot had nothing that said the flush failed — the 2026-09-10 trial`s three empty consultations read as ordinary sessions.',
  })
  flushFailed: boolean;

  @ApiPropertyOptional({
    description:
      'TASK-946 D6 — WHY the flush failed, as a code from the closed vocabulary (`no_case_notes`, `context_overflow`, `text_unavailable`, `timeout`, `generation_failed`, or an executor reason code such as `disabled_by_config` / `superseded_after_completion`). ABSENT on a healthy flush. Never a transport string: it used to be `${status}: ${message}`, so this surface carried `degraded: Request failed with status code 502` — the HTTP client`s words on the field whose job is to explain what happened to the note, and the one place a model`s refusal text could reach a PHI-safe surface.',
  })
  degradeReason?: string;
}

/** A tenant's active live-documentation sessions (`GET /admin/harness/live/sessions`). */
export class LiveDocSessionsListResponse {
  @ApiProperty({ description: 'Active recording sessions with their live stats', type: [LiveDocSessionStatsResponse] })
  items: LiveDocSessionStatsResponse[];

  @ApiProperty({ description: 'Number of active sessions' })
  total: number;
}

/** Where the effective live-engine enabled flag was resolved from. */
export type LiveDocEngineConfigSource = 'env-default' | 'redis-override';

/** The effective live-documentation engine config / kill-switch (`GET /admin/harness/live/config`). */
export class LiveDocEngineConfigResponse {
  @ApiProperty({ description: 'Effective enabled state (Redis override if set, else env default)' })
  enabled: boolean;

  @ApiProperty({ description: 'The `LIVE_DOC_ENABLED` env default baked in at boot' })
  envDefault: boolean;

  @ApiProperty({
    description: 'Whether the effective value comes from the env default or a runtime Redis override',
    enum: ['env-default', 'redis-override'],
  })
  source: LiveDocEngineConfigSource;

  @ApiPropertyOptional({ description: 'ISO-8601 timestamp of the last runtime override' })
  updatedAt?: string;

  @ApiPropertyOptional({ description: 'User id that last toggled the runtime override' })
  updatedBy?: string;

  // the effective agentic.context.* knobs the live loop
  // reads (settings-registry namespace; env override → registry code default).
  @ApiPropertyOptional({
    description: 'Effective agentic.context.* knobs the live-documentation loop reads.',
    type: 'object',
    additionalProperties: true,
  })
  contextSettings?: Record<string, unknown>;
}

/**
 * item 6 — ONE realtime node, as it will actually be executed.
 *
 * Every field is READ OFF the resolved lane, never restated from a catalogue: `enabled` is the
 * node's own authored config (items 3-4), `togglable` is whether the contract offers `enabled` on
 * that node type at all, and the budgets are the ones the executor races. A read-out assembled
 * from anywhere else would drift from the runtime the moment either changed.
 */
export class LiveDocRealtimeNodeResponse {
  @ApiProperty({ description: 'Node id as authored in the graph (trajectories cite it)' })
  nodeId: string;

  @ApiProperty({ description: 'Registered node type — since TASK-893 every realtime node is `core.agent`' })
  type: string;

  @ApiProperty({
    description:
      'The CAPABILITY this node runs (`transcribe` | `extractEntities` | `generateDocument` | …), derived from the agent it references. Since TASK-893 the type no longer distinguishes two realtime nodes — every one of them is a `core.agent` — so this is the field a consumer keys on. Falls back to the node type when no capability can be derived.',
  })
  canonicalType: string;

  @ApiProperty({ description: 'Topological stage of the realtime lane; every node in a stage runs concurrently' })
  stageIndex: number;

  @ApiProperty({ description: 'Effective enabled state. Absent config reads as ENABLED; only a literal `false` disables.' })
  enabled: boolean;

  @ApiProperty({
    description:
      'Whether this node type offers the `enabled` switch at all. FALSE for registry-class `mandatory` types (consent gate, capture binding, PHI hop, persist, finalize, HITL gate) — a mandatory node an admin could switch off is that gate being routed around by another means.',
  })
  togglable: boolean;

  @ApiProperty({ description: 'Failure policy: `degrade` contributes nothing and emits an event; `fail` fails the lane', enum: ['fail', 'degrade'] })
  onError: 'fail' | 'degrade';

  @ApiProperty({ description: 'Per-node budget in ms — each node races its own timer, never a shared per-flush one' })
  timeoutMs: number;

  @ApiProperty({ description: 'Per-node retry ceiling from the compiled `retry.maximumAttempts`' })
  maxAttempts: number;
}

/** Where the realtime lane came from. `null` ⇒ there is no lane: the LEGACY engine is running. */
export type LiveDocRealtimeLaneSource = 'platform-default' | 'tenant-graph';

/**
 * WHICH tier supplied the definition — a different question from {@link LiveDocRealtimeLaneSource},
 * which says whether that tier produced an executable lane.
 *
 * `consultation` is the tier ABOVE the assignment cascade: the workflow this
 * consultation itself selected at open. It exists because a per-consultation choice and a
 * per-tenant assignment are not the same decision, and reporting the tenant tier for a
 * clinician-selected workflow is precisely the misattribution this field exists to prevent.
 */
export type LiveDocRealtimeAssignmentSource = 'consultation' | 'department' | 'tenant' | 'platform-default';

/**
 * item 6 — which realtime capabilities are actually live for a tenant
 * (`GET /admin/harness/live/capabilities`).
 *
 * Activation was previously unobservable: the lane source, definition and per-node state existed
 * only in one log line at `start()`. This is the read that lets an admin answer "is the graph I
 * published governing consultations?" without recording one — and it resolves through the SAME
 * code path a session does, so it cannot report a lane the runtime would not execute.
 */
export class LiveDocRealtimeCapabilitiesResponse {
  @ApiProperty({ description: 'Tenant these capabilities were resolved for' })
  tenantId: string;

  @ApiPropertyOptional({ description: 'Department the cascade was resolved against, when one was requested' })
  departmentId?: string | null;

  @ApiPropertyOptional({
    description:
      'Consultation the read-out was resolved FOR, when one was requested. With it, the answer is the lane a live session for that consultation would actually walk — including the workflow the clinician selected at open, which no tenant-level read can show.',
    nullable: true,
  })
  consultationId?: string | null;

  @ApiProperty({
    description:
      'Effective `consultation.realtime.graphExecutor.enabled` for this tenant. FALSE ⇒ the legacy flush runs and there is NO lane — `laneSource` is null and `nodes` is empty.',
  })
  graphExecutorEnabled: boolean;

  @ApiProperty({
    description: 'Where the executing lane came from, or null when the graph executor is off and no lane exists.',
    enum: ['platform-default', 'tenant-graph'],
    nullable: true,
  })
  laneSource: LiveDocRealtimeLaneSource | null;

  @ApiProperty({ description: 'Slug of the governing workflow definition; null on the platform-default lane', nullable: true })
  definitionSlug: string | null;

  @ApiProperty({ description: 'Published version of that definition; null on the platform-default lane', nullable: true })
  definitionVersionNumber: number | null;

  @ApiProperty({
    description:
      'Which tier supplied the definition. `consultation` means THIS consultation selected the workflow at open and it beat the cascade; `department`/`tenant` are the assignment cascade; `platform-default` means no tier had an opinion, or the resolved definition could not be used.',
    enum: ['consultation', 'department', 'tenant', 'platform-default'],
  })
  assignmentSource: LiveDocRealtimeAssignmentSource;

  @ApiProperty({ description: 'The lane’s nodes in execution order', type: [LiveDocRealtimeNodeResponse] })
  nodes: LiveDocRealtimeNodeResponse[];
}

/** Body for `PATCH /admin/harness/live/config` — toggle the kill-switch. */
export class UpdateLiveDocEngineConfigRequest {
  @ApiProperty({ description: 'Desired engine enabled state (false = kill-switch engaged)' })
  @IsBoolean()
  enabled: boolean;

  @ApiPropertyOptional({ description: 'Optional audit reason for the toggle' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
