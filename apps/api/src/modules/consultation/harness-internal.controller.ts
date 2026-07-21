import {
  CreateAgentTrajectoryStepInput,
  HarnessAssembleRequest,
  HarnessAssuranceAck,
  HarnessAssuranceEventRequest,
  HarnessAssuranceService,
  HarnessDraftRequest,
  HarnessEntitiesResponse,
  HarnessEscalationRequest,
  HarnessFinalizeAssuranceRequest,
  HarnessGateDecisionRequest,
  HarnessInternalService,
  HarnessPersistEntitiesRequest,
  HarnessPolicyResponse,
  HarnessPolicyService,
  HarnessProgressAck,
  HarnessProgressRequest,
  HarnessProgressService,
  IActiveUserContext,
  IAgentTrajectoryService,
} from '@arcaai/applications';
import { AgentSessionKind, AgentStepStatus, AgentStepType, JsonValue } from '@arcaai/domains';
import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiParam, ApiProperty, ApiPropertyOptional, ApiQuery } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { ClsService } from 'nestjs-cls';
import { Public } from '../../decorators';
import { HarnessServiceTokenGuard } from './harness-service-token.guard';

/**
 * one ordered trajectory step in the harness `report_trajectory`
 * batch contract. Whitelisted by the global `forbidNonWhitelisted` pipe, so a
 * malformed/oversized batch fails cleanly (4xx) and never 5xxs the clinical loop.
 * `payloadRef` is a claim-check / encrypted pointer only — never plaintext PHI.
 */
class HarnessTrajectoryStepInput {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  tenantId: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  consultationId?: string;

  @ApiProperty({ enum: AgentSessionKind })
  @IsEnum(AgentSessionKind)
  sessionKind: AgentSessionKind;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  sessionId: string;

  @ApiPropertyOptional({ description: 'Temporal runId; "" sentinel otherwise (default).' })
  @IsOptional()
  @IsString()
  runId?: string;

  @ApiProperty({ description: 'Per-(sessionId, runId) monotonic sequence.' })
  @IsInt()
  @Min(0)
  seq: number;

  @ApiProperty({ enum: AgentStepType })
  @IsEnum(AgentStepType)
  stepType: AgentStepType;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ enum: AgentStepStatus })
  @IsEnum(AgentStepStatus)
  status: AgentStepStatus;

  @ApiProperty({ description: 'Step start (ISO-8601).' })
  @IsISO8601()
  startedAt: string;

  @ApiPropertyOptional({ description: 'Step end (ISO-8601).' })
  @IsOptional()
  @IsISO8601()
  endedAt?: string;

  // Accept any number (emitters may compute fractional ms); the mapping floors
  // it into the `Int` column. Rejecting a fractional value here would 400 the
  // whole batch, which the harness fire-and-forget then silently drops.
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsNumber()
  durationMs?: number;

  @ApiPropertyOptional({ nullable: true, description: 'AD-1 GenerationStats on LLM_CALL steps.' })
  @IsOptional()
  @IsObject()
  stats?: Record<string, unknown>;

  @ApiPropertyOptional({ nullable: true, description: 'Claim-check ref / encrypted pointer — never plaintext content.' })
  @IsOptional()
  @IsObject()
  payloadRef?: Record<string, unknown>;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  errorCode?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  correlationId?: string;
}

/** the `POST /internal/harness/trajectory` batch body. */
class ReportTrajectoryRequest {
  @ApiProperty({ type: [HarnessTrajectoryStepInput] })
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => HarnessTrajectoryStepInput)
  steps: HarnessTrajectoryStepInput[];
}

/** best-effort ingest ack. */
class ReportTrajectoryAck {
  @ApiProperty({ description: 'Number of steps accepted for idempotent persistence.' })
  accepted: number;
}

/**
 * HarnessInternalController.
 *
 * The inbound half of the apps/api <-> apps/harness gate adapter. Service-to-service
 * only (guarded by HarnessServiceTokenGuard / `X-Service-Token`), so it is excluded
 * from public Swagger. With the global `api/v1` prefix the effective paths are
 * `/api/v1/internal/harness/consultations/:id/{entities,assemble,draft,gate-decision}`.
 *
 * The harness calls these out-of-band of the API edge ClsModule middleware, so each
 * request carries `tenantId` in the body and the service re-establishes CLS from it.
 *
 * `@Public()` exempts these routes from the user-JWT/permission auth chain (and the
 * boot-time route-permission audit): they are authenticated service-to-service by the
 * class-level `HarnessServiceTokenGuard`, NOT by an end-user token. `@Public()` only
 * sets the skip-auth label — it does not disable the explicitly-applied token guard.
 */
@ApiExcludeController()
@Public()
@UseGuards(HarnessServiceTokenGuard)
@Controller('internal/harness')
export class HarnessInternalController {
  constructor(
    private readonly harnessInternalService: HarnessInternalService,
    // The durable worker's `fetch_policy` activity reads the effective
    // harness policy here; HarnessPolicyService comes from the
    // HarnessPolicyServiceModule imported by ConsultationModule.
    private readonly harnessPolicyService: HarnessPolicyService,
    private readonly cls: ClsService<IActiveUserContext>,
    // Live harness activity feed; ephemeral Redis publish, no CLS needed.
    private readonly harnessProgressService: HarnessProgressService,
    // Live per-claim assurance feed; ephemeral Redis publish, no CLS needed
    // (carries no PHI, only ids/sensor keys/verdict labels).
    private readonly harnessAssuranceService: HarnessAssuranceService,
    // ordered-trajectory batch ingest (idempotent, tenant-scoped).
    @Inject(IAgentTrajectoryService) private readonly agentTrajectoryService: IAgentTrajectoryService,
  ) {}

  @Get('policy')
  @ApiOperation({ summary: 'Effective harness policy for a tenant (worker fetch_policy activity)' })
  @ApiQuery({ name: 'tenantId', required: true, description: 'Tenant whose effective policy to resolve.' })
  async getEffectivePolicy(@Query('tenantId') tenantId?: string): Promise<HarnessPolicyResponse> {
    if (!tenantId) {
      throw new BadRequestException('tenantId query parameter is required');
    }

    // These requests run outside the API-edge ClsModule middleware (like the
    // BullMQ workers + the POST callbacks above), so re-establish a CLS context
    // pinned to the requested tenant. The tenant-scope extension then resolves
    // the tenant row (and the SYSTEM-shared GLOBAL-DEFAULT fallback) correctly.
    return this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      return this.harnessPolicyService.getEffectivePolicy(tenantId);
    });
  }

  /**
   * Resolve an MCP server credential for the worker.
   *
   * The harness has no Vault client by design (ticket §3.1): secret material stays
   * on the gateway side of the boundary. The worker calls this INSIDE the activity
   * that performs the MCP call, uses the token, and discards it — it is never put
   * into workflow state, activity inputs, or heartbeats, because Temporal history
   * is durable storage.
   *
   * `authRef` is allowlisted in the service against registered, ENABLED `McpServer`
   * rows, so this is not an arbitrary secret-path read. An unknown ref returns
   * `{ token: null }` rather than 404: the worker's contract is "no token ⇒ call
   * the server unauthenticated (it must be public / in-boundary)", and a distinct
   * status here would let a caller probe which paths exist.
   */
  @Get('mcp-token')
  @ApiOperation({ summary: 'Resolve an MCP server credential by its registered authRef (worker tool-call activity)' })
  @ApiQuery({ name: 'authRef', required: true, description: 'Vault PATH registered on an enabled McpServer row.' })
  async resolveMcpToken(@Query('authRef') authRef?: string): Promise<{ token: string | null }> {
    if (!authRef) {
      throw new BadRequestException('authRef query parameter is required');
    }
    return { token: await this.harnessInternalService.resolveMcpToken(authRef) };
  }

  // The harness sends a deterministic `Idempotency-Key`
  // (`{run_id}:{activity_id}`) on the WORM/draft callbacks so apps/api can dedup a
  // Temporal activity retry (which would otherwise re-append). The header is
  // forwarded into the service, which caches-and-replays the prior response.
  @Post('consultations/:id/entities')
  @ApiOperation({ summary: 'Persist NamedEntity rows extracted by the harness NLP step' })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async persistEntities(@Param('id') id: string, @Body() dto: HarnessPersistEntitiesRequest, @Headers('Idempotency-Key') idempotencyKey?: string) {
    return this.harnessInternalService.persistEntities(id, dto, idempotencyKey);
  }

  // The read counterpart of persistEntities: the harness
  // `load_entity_priors` activity GETs the persisted NamedEntity rows to reuse them as
  // NER priors (skip the redundant cold transcript re-extraction). `tenantId` rides the
  // query (like `GET /policy`), and the service re-establishes CLS + 404-over-403 from it.
  @Get('consultations/:id/entities')
  @ApiOperation({ summary: 'Read persisted NamedEntity rows the harness reuses as NER priors' })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiQuery({ name: 'tenantId', required: true, description: 'Tenant the harness is acting on behalf of.' })
  async getEntities(@Param('id') id: string, @Query('tenantId') tenantId?: string): Promise<HarnessEntitiesResponse> {
    if (!tenantId) {
      throw new BadRequestException('tenantId query parameter is required');
    }
    return this.harnessInternalService.getEntities(id, tenantId);
  }

  @Post('consultations/:id/assemble')
  @ApiOperation({ summary: 'Resolve prompt tier + assemble the SMR payload (NER-injected, SOAP responseFormat)' })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async assemble(@Param('id') id: string, @Body() dto: HarnessAssembleRequest) {
    return this.harnessInternalService.assemble(id, dto);
  }

  @Post('consultations/:id/draft')
  @ApiOperation({ summary: 'Persist the generated draft (ContextItem + SummaryMeta + PENDING_REVIEW + WORM audit)' })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async persistDraft(@Param('id') id: string, @Body() dto: HarnessDraftRequest, @Headers('Idempotency-Key') idempotencyKey?: string) {
    return this.harnessInternalService.persistDraft(id, dto, idempotencyKey);
  }

  @Post('consultations/:id/gate-decision')
  @ApiOperation({ summary: 'Record the clinician GATE_DECISION (append-only WORM audit) after sign-off' })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async recordGateDecision(@Param('id') id: string, @Body() dto: HarnessGateDecisionRequest, @Headers('Idempotency-Key') idempotencyKey?: string) {
    return this.harnessInternalService.recordGateDecision(id, dto, idempotencyKey);
  }

  // The harness `escalate_gate` activity POSTs here when an
  // un-signed gate passes its SLA; the service records a WORM audit event
  // (GATE_ESCALATED, or GATE_ABANDONED for the terminal `gate_sla_abandoned`).
  @Post('consultations/:id/escalation')
  @ApiOperation({ summary: 'Record a harness gate SLA-breach escalation (WORM audit; terminal = gate abandon)' })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async recordEscalation(@Param('id') id: string, @Body() dto: HarnessEscalationRequest, @Headers('Idempotency-Key') idempotencyKey?: string) {
    return this.harnessInternalService.recordEscalation(id, dto, idempotencyKey);
  }

  // Optimistic delivery, second phase — the harness calls this
  // AFTER the inferential assurance pass: backfill the early-persisted SummaryMeta
  // with the verdict + assuranceCompletedAt, flip DRAFT_PENDING_SENSORS →
  // PENDING_REVIEW, record the deferred SENSOR_RUN WORM audit, and publish the
  // terminal `assurance_complete` SSE event that closes the live feed.
  @Post('consultations/:id/assurance')
  @ApiOperation({ summary: 'Finalize optimistic delivery: backfill the draft verdict + close the assurance feed' })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async finalizeAssurance(
    @Param('id') id: string,
    @Body() dto: HarnessFinalizeAssuranceRequest,
    @Headers('Idempotency-Key') idempotencyKey?: string,
  ) {
    return this.harnessInternalService.finalizeAssurance(id, dto, idempotencyKey);
  }

  // Mid-pass live feed — the workflow's
  // `run_inferential_sensors` activity posts ONE resolved claim verdict here as
  // each claim settles; the service folds it into the full-state snapshot and
  // publishes to `consultation:harness-assurance:{id}` for the browser SSE relay.
  // Best-effort by contract (like progress): always acks ({ ok: boolean }), never
  // 5xxs the workflow over a live-feed hiccup.
  @Post('consultations/:id/assurance-event')
  // Nothing is created — the ack is best-effort and can be `{ ok: false }`, so the
  // default POST 201 would misreport the outcome (mirrors the progress route).
  @HttpCode(200)
  @ApiOperation({ summary: 'Publish one resolved claim verdict to the live assurance feed (ephemeral, best-effort)' })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async reportAssuranceClaim(@Param('id') id: string, @Body() dto: HarnessAssuranceEventRequest): Promise<HarnessAssuranceAck> {
    return this.harnessAssuranceService.reportClaim(id, dto);
  }

  // The workflow's `report_progress` activity posts one stage event
  // here per phase; the service folds it into the full-state snapshot and
  // publishes to `consultation:harness-progress:{id}` for the browser SSE
  // relay. Best-effort by contract: always acks ({ ok: boolean }), never 5xxs
  // the workflow over a progress hiccup.
  @Post('consultations/:id/progress')
  // Nothing is created — the ack is best-effort and can be
  // `{ ok: false }`, so the default POST 201 would misreport the outcome.
  @HttpCode(200)
  @ApiOperation({ summary: 'Publish a harness workflow progress stage to the live UI feed (ephemeral, best-effort)' })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async reportProgress(@Param('id') id: string, @Body() dto: HarnessProgressRequest): Promise<HarnessProgressAck> {
    return this.harnessProgressService.reportProgress(id, dto);
  }

  // the harness `report_trajectory` activity POSTs the
  // ordered step batch here (fire-and-forget, batched at phase boundaries).
  // `recordSteps` is IDEMPOTENT on the composite unique
  // `(tenantId, sessionId, runId, seq)`, so a re-delivered batch (or the
  // optional `Idempotency-Key` retry) persists nothing new — the header is
  // accepted for wire-compat but the dedup is built into the write.
  //
  // Resilient by contract (a trajectory outage must never break the clinical
  // loop): a malformed/oversized batch is rejected by the global ValidationPipe
  // (4xx, never 5xx) and an empty batch is a no-op ack. 202 Accepted — the write
  // is idempotent async telemetry, not a created resource.
  @Post('trajectory')
  @HttpCode(202)
  @ApiOperation({ summary: 'Batch-ingest ordered agentic-trajectory steps from the harness (idempotent, tenant-scoped)' })
  async reportTrajectory(@Body() dto: ReportTrajectoryRequest, @Headers('Idempotency-Key') _idempotencyKey?: string): Promise<ReportTrajectoryAck> {
    const steps = dto.steps ?? [];
    if (steps.length === 0) {
      return { accepted: 0 };
    }

    // Single-tenant batch (recordSteps enforces this too). Re-establish CLS from
    // the batch tenantId — these service-token routes run outside the API-edge
    // ClsModule middleware, so the tenant-scope extension needs the context.
    const tenantId = steps[0].tenantId;
    const mapped: CreateAgentTrajectoryStepInput[] = steps.map((step) => ({
      tenantId: step.tenantId,
      consultationId: step.consultationId ?? undefined,
      sessionKind: step.sessionKind,
      sessionId: step.sessionId,
      runId: step.runId ?? undefined,
      seq: step.seq,
      stepType: step.stepType,
      name: step.name,
      status: step.status,
      startedAt: new Date(step.startedAt),
      endedAt: step.endedAt ? new Date(step.endedAt) : undefined,
      durationMs: step.durationMs != null ? Math.floor(step.durationMs) : undefined,
      stats: (step.stats ?? undefined) as JsonValue | undefined,
      payloadRef: (step.payloadRef ?? undefined) as JsonValue | undefined,
      errorCode: step.errorCode ?? undefined,
      correlationId: step.correlationId ?? undefined,
    }));

    await this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      await this.agentTrajectoryService.recordSteps(mapped);
    });

    return { accepted: steps.length };
  }
}
