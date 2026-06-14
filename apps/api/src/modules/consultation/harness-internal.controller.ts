import {
  HarnessAssembleRequest,
  HarnessAssuranceAck,
  HarnessAssuranceEventRequest,
  HarnessAssuranceService,
  HarnessDraftRequest,
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
} from '@arcaai/applications';
import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { Public } from '../../decorators';
import { HarnessServiceTokenGuard } from './harness-service-token.guard';

/**
 * HarnessInternalController (TASK-330 Phase 1 — Lane G).
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
    // TASK-330 Phase 6 — the durable worker's `fetch_policy` activity reads the
    // effective harness policy here; HarnessPolicyService comes from the
    // HarnessPolicyServiceModule imported by ConsultationModule.
    private readonly harnessPolicyService: HarnessPolicyService,
    private readonly cls: ClsService<IActiveUserContext>,
    // TASK-345 — live harness activity feed; ephemeral Redis publish, no CLS needed.
    private readonly harnessProgressService: HarnessProgressService,
    // TASK-355 Phase D Slice 5d — live per-claim assurance feed; ephemeral Redis
    // publish, no CLS needed (carries no PHI, only ids/sensor keys/verdict labels).
    private readonly harnessAssuranceService: HarnessAssuranceService,
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

  @Post('consultations/:id/entities')
  @ApiOperation({ summary: 'Persist NamedEntity rows extracted by the harness NLP step' })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async persistEntities(@Param('id') id: string, @Body() dto: HarnessPersistEntitiesRequest) {
    return this.harnessInternalService.persistEntities(id, dto);
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
  async persistDraft(@Param('id') id: string, @Body() dto: HarnessDraftRequest) {
    return this.harnessInternalService.persistDraft(id, dto);
  }

  @Post('consultations/:id/gate-decision')
  @ApiOperation({ summary: 'Record the clinician GATE_DECISION (append-only WORM audit) after sign-off' })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async recordGateDecision(@Param('id') id: string, @Body() dto: HarnessGateDecisionRequest) {
    return this.harnessInternalService.recordGateDecision(id, dto);
  }

  // TASK-355 Phase D (optimistic delivery, second phase) — the harness calls this
  // AFTER the inferential assurance pass: backfill the early-persisted SummaryMeta
  // with the verdict + assuranceCompletedAt, flip DRAFT_PENDING_SENSORS →
  // PENDING_REVIEW, record the deferred SENSOR_RUN WORM audit, and publish the
  // terminal `assurance_complete` SSE event that closes the live feed.
  @Post('consultations/:id/assurance')
  @ApiOperation({ summary: 'Finalize optimistic delivery: backfill the draft verdict + close the assurance feed' })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async finalizeAssurance(@Param('id') id: string, @Body() dto: HarnessFinalizeAssuranceRequest) {
    return this.harnessInternalService.finalizeAssurance(id, dto);
  }

  // TASK-355 Phase D Slice 5d (Q5 true mid-pass live feed) — the workflow's
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

  // TASK-345 — the workflow's `report_progress` activity posts one stage event
  // here per phase; the service folds it into the full-state snapshot and
  // publishes to `consultation:harness-progress:{id}` for the browser SSE
  // relay. Best-effort by contract: always acks ({ ok: boolean }), never 5xxs
  // the workflow over a progress hiccup.
  @Post('consultations/:id/progress')
  // TASK-348 / MIN-4: nothing is created — the ack is best-effort and can be
  // `{ ok: false }`, so the default POST 201 would misreport the outcome.
  @HttpCode(200)
  @ApiOperation({ summary: 'Publish a harness workflow progress stage to the live UI feed (ephemeral, best-effort)' })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async reportProgress(@Param('id') id: string, @Body() dto: HarnessProgressRequest): Promise<HarnessProgressAck> {
    return this.harnessProgressService.reportProgress(id, dto);
  }
}
