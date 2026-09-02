import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

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
 * TASK-852 item 6 — ONE realtime node, as it will actually be executed.
 *
 * Every field is READ OFF the resolved lane, never restated from a catalogue: `enabled` is the
 * node's own authored config (items 3-4), `togglable` is whether the contract offers `enabled` on
 * that node type at all, and the budgets are the ones the executor races. A read-out assembled
 * from anywhere else would drift from the runtime the moment either changed.
 */
export class LiveDocRealtimeNodeResponse {
  @ApiProperty({ description: 'Node id as authored in the graph (trajectories cite it)' })
  nodeId: string;

  @ApiProperty({ description: 'Registered node type, e.g. `consultation.realtimeSummary`' })
  type: string;

  @ApiProperty({
    description:
      'The PIPELINE node type this one stands for. `agent.ner` and `agent.transcription` are the target catalogue’s names for existing capabilities and run the same handlers, so a consumer keyed by type must treat the alias and its canonical form as ONE capability.',
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
 * TASK-852 item 6 — which realtime capabilities are actually live for a tenant
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
      'Which tier of the assignment cascade supplied the definition. `platform-default` means no tier had an opinion, or the assigned definition could not be resolved.',
    enum: ['department', 'tenant', 'platform-default'],
  })
  assignmentSource: 'department' | 'tenant' | 'platform-default';

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
