import {
  EditBurdenResponse,
  EvalRunDetailResponse,
  EvalRunListResponse,
  EvalRunService,
  EvalRunTriggerResponse,
  EvalService,
  GateEditMiningService,
  GateEditCorpusExport,
  GateEditCurationResult,
  GateEditFineTuningExport,
  GoldenCasePromotionService,
  GateQueueResponse,
  GoldenCaseListResponse,
  GoldenCaseMetaResponse,
  GoldenSetListResponse,
  GoldenSetResponse,
  HarnessAuditListResponse,
  HarnessObservabilityService,
  HarnessPolicyResponse,
  HarnessPolicyService,
  IActiveUserContext,
  isSuperAdmin,
  LiveDocEngineConfigResponse,
  LiveDocRealtimeCapabilitiesResponse,
  LiveDocSessionsListResponse,
  LiveDocSessionStatsResponse,
  LiveDocumentationService,
  UpdateHarnessPolicyRequest,
  UpdateLiveDocEngineConfigRequest,
} from '@arcaai/applications';
import { Body, Controller, ForbiddenException, Get, Header, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { Authorize, ExpectedVersion, RequiresIfMatch, ForbidApiKey, RequiredSvcScopes } from '../../decorators';
import { resolveScopedTenantId, resolveScopedTenantIdOptional } from '../../shared/tenant-scope';
import { HarnessOpsClient, HarnessWorkflowActionResult, HarnessWorkflowDetail, HarnessWorkflowListResult } from './harness-ops.client';
import {
  CreateGoldenCaseRequest,
  CreateGoldenSetRequest,
  EditBurdenQuery,
  ExemplarCurationRequest,
  PromoteExemplarRequest,
  SignalWorkflowRequest,
  WorkflowActionRequest,
} from './dto';

/**
 * HarnessAdminController — the admin surface for the clinical
 * documentation harness, mounted at `/admin/harness/*` (global prefix →
 * `/api/v1/admin/harness/*`). Mirrors `PromptManagementController` (`@Authorize`,
 * `If-Match` OCC) and `MyTenantController` (CLS tenant resolution).
 *
 * Four concerns:
 *  - Policy: GET/PATCH the caller-tenant policy (`If-Match` OCC) + the platform
 *    GLOBAL-DEFAULT (`policy/global`, super-admin only).
 *  - Observe: read the WORM audit trail (+ integrity verdict), eval runs, and
 *    the clinician gate queue.
 *  - Datasets: golden sets/cases — list/read + create over
 *    `EvalService`. Case reads are PHI-SAFE metadata (the encrypted
 *    transcript/reference-note payloads are never surfaced).
 *  - Operate: proxy Temporal workflow ops to the harness via `HarnessOpsClient`,
 *    enforcing tenant ownership on destructive ops (platform super-admins bypass).
 *
 * Tenant scoping mirrors `MyTenantController`/`TenantController`: tenant admins
 * are pinned to their CLS tenant; super-admins (`isSuperAdmin`) act cross-tenant
 * (and may target a tenant via `?tenantId=` on reads). The ETag interceptor sets
 * `ETag: "<version>"` on the policy responses (top-level `version`).
 */
@ApiBearerAuth()
@ApiTags('admin-harness')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:harness:manage')
@Controller('admin/harness')
@Authorize()
export class HarnessAdminController {
  constructor(
    private readonly policyService: HarnessPolicyService,
    private readonly observabilityService: HarnessObservabilityService,
    private readonly opsClient: HarnessOpsClient,
    private readonly cls: ClsService<IActiveUserContext>,
    private readonly liveDocumentationService: LiveDocumentationService,
    private readonly evalService: EvalService,
    // APPENDED, never inserted. This controller is constructed
    // positionally in its unit tests, so a mid-list insertion silently shifts
    // `cls` and fails ~35 unrelated specs with "this.cls.get is not a function".
    private readonly gateEditMiningService: GateEditMiningService,
    // APPENDED: backs `POST golden-sets/:id/run`.
    private readonly evalRunService: EvalRunService,
    // APPENDED (TASK-792 W3): backs
    // `POST gate-edit-exemplars/:id/promote-to-golden-set`.
    private readonly goldenCasePromotionService: GoldenCasePromotionService,
  ) {}

  // ───────────────────────── Policy ─────────────────────────

  @Get('policy')
  @Authorize(['read', 'HarnessPolicy'])
  @ApiOperation({ summary: "Get the caller tenant's effective harness policy (tenant row over global default over code default)" })
  @ApiResponse({ status: 200, type: HarnessPolicyResponse })
  @ApiResponse({ status: 400, description: 'Bad request — no tenant context.' })
  async getPolicy(): Promise<HarnessPolicyResponse> {
    return this.policyService.getEffectivePolicy();
  }

  @Patch('policy')
  @Authorize(['manage', 'HarnessPolicy'])
  @RequiresIfMatch()
  @ApiOperation({
    summary: "Update the caller tenant's harness policy (created on first edit)",
    description:
      'Sparse patch over the effective policy. Optimistic concurrency is enforced: the `If-Match` header (RFC 7232) ' +
      "is REQUIRED and CAS'es against the row `_version`; drift → 412, missing → 428. Every edit appends a WORM " +
      '`HarnessPolicyChange` (before/after) in the same transaction.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"1"`).',
    required: true,
    example: '"1"',
  })
  @ApiResponse({ status: 200, type: HarnessPolicyResponse })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async updatePolicy(
    @Body() request: UpdateHarnessPolicyRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<HarnessPolicyResponse> {
    return this.policyService.updatePolicy(request, expectedFromHeader ?? request.expectedVersion);
  }

  @Get('policy/global')
  @Authorize(['read', 'HarnessPolicy'])
  @ApiOperation({ summary: 'Get the platform GLOBAL-DEFAULT harness policy (super-admin only)' })
  @ApiResponse({ status: 200, type: HarnessPolicyResponse })
  @ApiResponse({ status: 403, description: 'Forbidden — platform (super-admin) privileges required.' })
  async getGlobalPolicy(): Promise<HarnessPolicyResponse> {
    this.assertPlatform();
    return this.policyService.getGlobalDefault();
  }

  @Patch('policy/global')
  @Authorize(['manage', 'HarnessPolicy'])
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Update the platform GLOBAL-DEFAULT harness policy (super-admin only)',
    description: 'Same OCC + WORM semantics as `PATCH policy`, targeting the SYSTEM-tenant GLOBAL-DEFAULT row. Restricted to platform super-admins.',
  })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"1"`).',
    required: true,
    example: '"1"',
  })
  @ApiResponse({ status: 200, type: HarnessPolicyResponse })
  @ApiResponse({ status: 403, description: 'Forbidden — platform (super-admin) privileges required.' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async updateGlobalPolicy(
    @Body() request: UpdateHarnessPolicyRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<HarnessPolicyResponse> {
    this.assertPlatform();
    return this.policyService.updateGlobalDefault(request, expectedFromHeader ?? request.expectedVersion);
  }

  // ───────────────────────── Observe ─────────────────────────

  @Get('audit')
  @Authorize(['read', 'HarnessAudit'])
  @ApiOperation({ summary: 'List the WORM audit trail (newest-first) + the chain-integrity verdict' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant. Tenant admins are pinned to their own tenant.' })
  @ApiQuery({ name: 'consultationId', required: false, description: 'Narrow to a single consultation.' })
  @ApiQuery({ name: 'action', required: false, description: 'Narrow to a single HarnessAuditAction (e.g. GATE_DECISION).' })
  @ApiQuery({ name: 'from', required: false, description: 'Inclusive lower bound on createdAt (ISO-8601 instant).' })
  @ApiQuery({ name: 'to', required: false, description: 'Inclusive upper bound on createdAt (ISO-8601 instant).' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size (1–200, default 50).' })
  @ApiQuery({ name: 'offset', required: false, type: Number, description: 'Offset into the newest-first list.' })
  @ApiResponse({ status: 200, type: HarnessAuditListResponse })
  async listAudit(
    @Query() query: { tenantId?: string; consultationId?: string; action?: string; from?: string; to?: string; limit?: string; offset?: string },
  ): Promise<HarnessAuditListResponse> {
    const tenantId = this.resolveReadTenantId(query.tenantId);
    return this.observabilityService.listAuditEvents(tenantId, {
      consultationId: query.consultationId,
      action: query.action,
      from: query.from,
      to: query.to,
      limit: query.limit !== undefined ? Number(query.limit) : undefined,
      offset: query.offset !== undefined ? Number(query.offset) : undefined,
    });
  }

  @Get('eval-runs')
  @Authorize(['read', 'HarnessEval'])
  @ApiOperation({ summary: 'List eval runs (newest-first)' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiQuery({ name: 'goldenSetId', required: false, description: 'Filter to one golden set.' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, type: EvalRunListResponse })
  async listEvalRuns(@Query() query: { tenantId?: string; goldenSetId?: string; page?: string; limit?: string }): Promise<EvalRunListResponse> {
    const tenantId = this.resolveReadTenantId(query.tenantId);
    return this.observabilityService.listEvalRuns(tenantId, {
      goldenSetId: query.goldenSetId,
      page: query.page !== undefined ? Number(query.page) : undefined,
      limit: query.limit !== undefined ? Number(query.limit) : undefined,
    });
  }

  @Get('eval-runs/:id')
  @Authorize(['read', 'HarnessEval'])
  @ApiOperation({ summary: 'Get one eval run with its per-case scores' })
  @ApiParam({ name: 'id', description: 'Eval run id' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiResponse({ status: 200, type: EvalRunDetailResponse })
  @ApiResponse({ status: 404, description: 'Eval run not found for the tenant.' })
  async getEvalRun(@Param('id') id: string, @Query() query: { tenantId?: string }): Promise<EvalRunDetailResponse> {
    const tenantId = this.resolveReadTenantId(query.tenantId);
    return this.observabilityService.getEvalRun(tenantId, id);
  }

  // ─────────────────── Golden datasets ───────────────────────────────────

  @Get('golden-sets')
  @Authorize(['read', 'HarnessEval'])
  @ApiOperation({ summary: 'List golden sets (newest-first)' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, type: GoldenSetListResponse })
  async listGoldenSets(@Query() query: { tenantId?: string; page?: string; limit?: string }): Promise<GoldenSetListResponse> {
    const tenantId = this.resolveReadTenantId(query.tenantId);
    return this.evalService.listGoldenSets(tenantId, {
      page: query.page !== undefined ? Number(query.page) : undefined,
      limit: query.limit !== undefined ? Number(query.limit) : undefined,
    });
  }

  @Get('golden-sets/:id')
  @Authorize(['read', 'HarnessEval'])
  @ApiOperation({ summary: 'Get one golden set' })
  @ApiParam({ name: 'id', description: 'Golden set id' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiResponse({ status: 200, type: GoldenSetResponse })
  @ApiResponse({ status: 404, description: 'Golden set not found for the tenant.' })
  async getGoldenSet(@Param('id') id: string, @Query() query: { tenantId?: string }): Promise<GoldenSetResponse> {
    const tenantId = this.resolveReadTenantId(query.tenantId);
    return this.evalService.getGoldenSet(tenantId, id);
  }

  @Get('golden-sets/:id/cases')
  @Authorize(['read', 'HarnessEval'])
  @ApiOperation({
    summary: "List a golden set's cases — PHI-safe metadata only",
    description: 'The encrypted clinical payloads (`transcript`, `referenceNote`) are never surfaced through this plane.',
  })
  @ApiParam({ name: 'id', description: 'Golden set id' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, type: GoldenCaseListResponse })
  @ApiResponse({ status: 404, description: 'Golden set not found for the tenant.' })
  async listGoldenCases(
    @Param('id') id: string,
    @Query() query: { tenantId?: string; page?: string; limit?: string },
  ): Promise<GoldenCaseListResponse> {
    const tenantId = this.resolveReadTenantId(query.tenantId);
    return this.evalService.listGoldenCases(tenantId, id, {
      page: query.page !== undefined ? Number(query.page) : undefined,
      limit: query.limit !== undefined ? Number(query.limit) : undefined,
    });
  }

  @Post('golden-sets')
  @Authorize(['manage', 'HarnessEval'])
  @ApiOperation({ summary: 'Create a golden set for the caller tenant' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiResponse({ status: 201, type: GoldenSetResponse })
  @ApiResponse({ status: 404, description: 'departmentId does not exist or belongs to a different tenant.' })
  async createGoldenSet(@Body() body: CreateGoldenSetRequest, @Query() query: { tenantId?: string }): Promise<GoldenSetResponse> {
    const tenantId = this.resolveReadTenantId(query.tenantId);
    return this.evalService.addGoldenSet({
      tenantId,
      name: body.name,
      description: body.description,
      pinnedVersion: body.pinnedVersion,
      departmentId: body.departmentId,
      createdBy: this.cls.get('user')?.id ?? null,
    });
  }

  @Post('golden-sets/:id/cases')
  @Authorize(['manage', 'HarnessEval'])
  @ApiOperation({
    summary: 'Add a case to a golden set (PHI encrypted at rest, write-only)',
    description: 'Returns the PHI-safe metadata projection — the transcript/reference note are never echoed back.',
  })
  @ApiParam({ name: 'id', description: 'Golden set id' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiResponse({ status: 201, type: GoldenCaseMetaResponse })
  @ApiResponse({ status: 404, description: 'Golden set not found for the tenant.' })
  async createGoldenCase(
    @Param('id') id: string,
    @Body() body: CreateGoldenCaseRequest,
    @Query() query: { tenantId?: string },
  ): Promise<GoldenCaseMetaResponse> {
    const tenantId = this.resolveReadTenantId(query.tenantId);
    return this.evalService.addGoldenCase({
      tenantId,
      goldenSetId: id,
      transcript: body.transcript,
      referenceNote: body.referenceNote,
      label: body.label,
      createdBy: this.cls.get('user')?.id ?? null,
    });
  }

  @Post('golden-sets/:id/run')
  @Authorize(['manage', 'HarnessEval'])
  @ApiOperation({
    summary: 'Run an eval over a golden set now (synchronous)',
    description:
      'Decrypts the set’s cases, runs the harness eval + release gate, persists the EvalRun (triggerType=MANUAL) + per-case scores, and returns the verdict. Tenant admins run their own sets; a SYSTEM set is super-admin-only (a cross-tenant id 404s).',
  })
  @ApiParam({ name: 'id', description: 'Golden set id' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiResponse({ status: 201, type: EvalRunTriggerResponse })
  @ApiResponse({ status: 404, description: 'Golden set not found for the tenant.' })
  async runGoldenSet(@Param('id') id: string, @Query() query: { tenantId?: string }): Promise<EvalRunTriggerResponse> {
    const tenantId = this.resolveReadTenantId(query.tenantId);
    const outcome = await this.evalRunService.runGoldenSet({ goldenSetId: id, tenantId, triggerType: 'MANUAL' });
    return {
      runId: outcome.run.id,
      passed: outcome.passed,
      failures: outcome.failures,
      aggregates: outcome.aggregates,
    };
  }

  @Get('gate-queue')
  @Authorize(['read', 'HarnessWorkflow'])
  @ApiOperation({ summary: 'List consultations awaiting clinician review with SLA/escalation from the effective policy' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiResponse({ status: 200, type: GateQueueResponse })
  async gateQueue(@Query() query: { tenantId?: string }): Promise<GateQueueResponse> {
    const tenantId = this.resolveReadTenantId(query.tenantId);
    return this.observabilityService.gateQueue(tenantId);
  }

  // The signal existed in `HarnessObservabilityService`
  // unexposed; this wires it to the admin surface. The real
  // service signature is `getEditBurden(tenantId, consultationId)` — a
  // single-consultation lookup, not a date-range aggregate.
  @Get('edit-burden')
  @Authorize(['manage', 'HarnessPolicy'])
  @ApiOperation({
    summary: 'Derived clinician edit-burden telemetry for one consultation (edit distance, deferral rate, time-to-sign)',
    description:
      'Composes over already-persisted WORM audit rows + summary versions — read-only, no new capture, no workflow change. ' +
      'PHI hygiene: only derived scalars are returned; the note text itself never leaves the service.',
  })
  @ApiQuery({ name: 'consultationId', required: true, description: 'Consultation to derive edit-burden telemetry for.' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant. Tenant admins are pinned to their own tenant.' })
  @ApiResponse({ status: 200, type: EditBurdenResponse })
  @ApiResponse({ status: 404, description: 'No edit-burden telemetry recorded for this consultation (absent or belongs to another tenant).' })
  async getEditBurden(@Query() query: EditBurdenQuery): Promise<EditBurdenResponse> {
    const tenantId = this.resolveReadTenantId(query.tenantId);
    // `getEditBurden` verifies consultation existence/tenancy itself and throws
    // `DataNotFoundException` (mapped globally to 404) for both an absent and a
    // cross-tenant consultationId — a zeroed-but-existing result is a normal 200.
    return this.observabilityService.getEditBurden(tenantId, query.consultationId);
  }

  // The learning loop's export half. Mined rows are
  // PROPOSALS: the golden-set programme's SME review decides what becomes
  // corpus, and the payload carries `reviewStatus` so no consumer can mistake
  // this for approved eval data (consumption (a)).
  @Get('gate-edit-exemplars')
  @Authorize(['manage', 'HarnessPolicy'])
  @ApiOperation({
    summary: 'Export gate-edit exemplar candidates for eval regression-corpus review',
    description:
      'Derived, PHI-REDACTED-at-write learning-loop rows mined from the clinician approve-vs-edit signal. ' +
      'Returned as UNREVIEWED candidates (`reviewStatus: PENDING_SME_REVIEW`) — admission to a golden set is a ' +
      'separate, SME-gated decision. Omitting `qualitySignal` returns both APPROVED_CLEAN and HEAVILY_EDITED, ' +
      'because a regression corpus needs the failures as well as the successes.',
  })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant. Tenant admins are pinned to their own tenant.' })
  @ApiQuery({ name: 'departmentId', required: false, description: 'Narrow to one department.' })
  @ApiQuery({ name: 'qualitySignal', required: false, description: 'APPROVED_CLEAN | HEAVILY_EDITED. Omit for both.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size (default 100, hard-capped at 500).' })
  async exportGateEditExemplars(
    @Query() query: { tenantId?: string; departmentId?: string; qualitySignal?: string; limit?: number },
  ): Promise<GateEditCorpusExport> {
    const tenantId = this.resolveReadTenantId(query.tenantId);
    return this.gateEditMiningService.exportCorpusCandidates({
      tenantId,
      departmentId: query.departmentId ?? null,
      qualitySignal: query.qualitySignal,
      // Defaulted here rather than left undefined: an omitted limit must not
      // become an unbounded read of redacted clinical text.
      limit: Number(query.limit) > 0 ? Number(query.limit) : 100,
    });
  }

  // TASK-792 W4 (C-6) — the fine-tuning export. R7's second clause
  // ("used for fine-tuning and training models") had NO implementation at all:
  // nothing assembled (original, edited, context) triples into a dataset
  // artifact. This is that artifact.
  //
  // Two deliberate differences from `GET gate-edit-exemplars` directly above:
  // it admits ONLY curator-APPROVED rows (a training set cannot be un-baked
  // once it is in weights), and it emits JSONL rather than a JSON envelope,
  // because that is what a fine-tuning toolchain actually consumes.
  @Get('gate-edit-exemplars/fine-tuning-export')
  @Authorize(['manage', 'HarnessPolicy'])
  @Header('Content-Type', 'application/x-ndjson; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="gate-edit-finetune.jsonl"')
  @ApiOperation({
    summary: 'Export the curator-APPROVED gate-edit corpus as a JSONL fine-tuning dataset',
    description:
      'One JSON object per line: `{ original, edited, context }` — the AI draft as delivered, the note the clinician ' +
      'actually signed, and the non-text signal that makes the pair interpretable. Both text fields are the ' +
      'PHI-REDACTED forms written at mining time (`phiRedaction: FULL`); raw note text is never reachable from this ' +
      'route. Unlike the sibling candidate export this is curation-GATED with no knob — only exemplars a curator moved ' +
      'to APPROVED are included (`reviewStatus: SME_APPROVED`) — because a training corpus assembled from unreviewed ' +
      'clinical text cannot be retracted once it has been trained on. Every record carries ' +
      "`provenance: CLINICIAN_EDIT`, distinguishing it from the harness's synthetic golden fixture.",
  })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant. Tenant admins are pinned to their own tenant.' })
  @ApiQuery({ name: 'departmentId', required: false, description: 'Narrow to one department.' })
  @ApiQuery({ name: 'qualitySignal', required: false, description: 'APPROVED_CLEAN | HEAVILY_EDITED. Omit for both.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Maximum records (default 100, hard-capped at 500).' })
  @ApiResponse({ status: 200, description: 'JSONL dataset (`application/x-ndjson`). Empty body when nothing is approved yet.' })
  @ApiResponse({ status: 403, description: "Caller may not read this tenant's corpus." })
  async exportGateEditFineTuningDataset(
    @Query() query: { tenantId?: string; departmentId?: string; qualitySignal?: string; limit?: number },
  ): Promise<string> {
    const tenantId = this.resolveReadTenantId(query.tenantId);
    const dataset: GateEditFineTuningExport = await this.gateEditMiningService.exportFineTuningDataset({
      tenantId,
      departmentId: query.departmentId ?? null,
      qualitySignal: query.qualitySignal,
      // Defaulted, never undefined: an omitted limit must not become an
      // unbounded read of redacted clinical text.
      limit: Number(query.limit) > 0 ? Number(query.limit) : 100,
    });
    return this.gateEditMiningService.toJsonl(dataset);
  }

  // The curation half of the learning loop (F-24). Export shows a
  // human the unreviewed proposals; this records what they decided. It is the
  // ONLY write on this table — and it may write exactly one field, because every
  // other column is derived from the WORM audit trail and the redacted diff.
  //
  // No `If-Match`: unlike the policy routes there is no read-one endpoint to
  // source an ETag from, and the service already compare-and-sets on the row's
  // own `_version` after re-reading it, so two curators racing cannot silently
  // clobber each other.
  @Patch('gate-edit-exemplars/:id/curation')
  @Authorize(['manage', 'HarnessPolicy'])
  @ApiOperation({
    summary: 'Record the human curation verdict on one mined gate-edit exemplar',
    description:
      'Moves an exemplar between PENDING / APPROVED / REJECTED. Whether the verdict actually GATES prompt injection is ' +
      'governed separately by `agentic.fewshot.curationMode` (default `off`), so curating a corpus and enforcing the ' +
      'gate are two deliberate, independent steps.',
  })
  @ApiParam({ name: 'id', description: 'GateEditExemplar id.' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant. Tenant admins are pinned to their own tenant.' })
  @ApiResponse({ status: 200, description: 'The recorded verdict (id + previous/new status only — never a note snippet).' })
  @ApiResponse({ status: 400, description: 'Unknown curation status.' })
  @ApiResponse({ status: 404, description: 'No such exemplar (absent, or belongs to another tenant).' })
  async curateGateEditExemplar(
    @Param('id') id: string,
    @Body() request: ExemplarCurationRequest,
    @Query() query: { tenantId?: string },
  ): Promise<GateEditCurationResult> {
    const tenantId = this.resolveReadTenantId(query.tenantId);
    return this.gateEditMiningService.curateExemplar({ id, tenantId, status: request.status });
  }

  // TASK-792 W3 (C-5) — the automated GoldenCase producer. Before
  // this, `GoldenCase` had exactly ONE write path (a manual admin POST), so no
  // eval result in this system was derived from real clinician behaviour, and
  // curation advanced `curationStatus` and then went nowhere.
  //
  // The caller supplies only the DESTINATION set. The transcript is read from
  // the consultation and redacted fail-closed; the reference note is the
  // exemplar's redacted signed note. Notably the AI draft (`redactedBefore`) is
  // NOT used as the transcript — that would grade the model against its own
  // prior output while looking entirely plausible in the data.
  @Post('gate-edit-exemplars/:id/promote-to-golden-set')
  @Authorize(['manage', 'HarnessPolicy'])
  @ApiOperation({
    summary: 'Promote a curator-APPROVED gate-edit exemplar into a golden case',
    description:
      'Derives a `(transcript -> reference note)` golden case from a real signed, clinician-edited consultation. Only ' +
      'curation-APPROVED exemplars are eligible. The transcript is PHI-redacted before persistence and the promotion ' +
      'FAILS CLOSED on a missing transcript or unverifiable redaction — a fabricated golden case is worse than none, ' +
      'because it becomes the yardstick. Each case is labelled `CLINICIAN_DERIVED_PENDING_SME`: it is real clinician ' +
      'behaviour, but it is NOT the SME-authored multi-rater golden set that the harness declares an outstanding ' +
      'prerequisite, and it must not be used to gate a clinical claim on its own.',
  })
  @ApiParam({ name: 'id', description: 'GateEditExemplar id to promote.' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant. Tenant admins are pinned to their own tenant.' })
  @ApiResponse({ status: 201, description: 'The created golden case id + its provenance label.' })
  @ApiResponse({ status: 400, description: 'Exemplar not curation-APPROVED, no transcript, or redaction could not be verified.' })
  @ApiResponse({ status: 404, description: 'No such exemplar or golden set (absent, or belongs to another tenant).' })
  async promoteExemplarToGoldenSet(
    @Param('id') id: string,
    @Body() request: PromoteExemplarRequest,
    @Query() query: { tenantId?: string },
  ): Promise<{ goldenCaseId: string; goldenSetId: string; label: string | null }> {
    const tenantId = this.resolveReadTenantId(query.tenantId);
    const created = await this.goldenCasePromotionService.promoteExemplarToGoldenCase({
      tenantId,
      exemplarId: id,
      goldenSetId: request.goldenSetId,
      createdBy: this.cls.get('user')?.id ?? null,
    });
    // Ids + provenance only — never the transcript or the reference note.
    return { goldenCaseId: created.id, goldenSetId: request.goldenSetId, label: created.label ?? null };
  }

  // ───────────────────────── Operate (Temporal proxy) ─────────────────────────

  @Get('workflows')
  @Authorize(['read', 'HarnessWorkflow'])
  @ApiOperation({ summary: 'List harness Temporal document workflows (tenant-filtered)' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant (omit = all tenants).' })
  @ApiQuery({ name: 'status', required: false, description: 'Temporal status filter (e.g. RUNNING).' })
  @ApiQuery({ name: 'consultationId', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'pageToken', required: false })
  async listWorkflows(
    @Query() query: { tenantId?: string; status?: string; consultationId?: string; limit?: string; pageToken?: string },
  ): Promise<HarnessWorkflowListResult> {
    const tenantFilter = this.resolveWorkflowListTenant(query.tenantId);
    return this.opsClient.listWorkflows({
      tenantId: tenantFilter,
      status: query.status,
      consultationId: query.consultationId,
      limit: query.limit !== undefined ? Number(query.limit) : undefined,
      pageToken: query.pageToken,
    });
  }

  @Get('workflows/:id')
  @Authorize(['read', 'HarnessWorkflow'])
  @ApiOperation({ summary: 'Describe one harness workflow (add ?phase=true for the loop phase)' })
  @ApiParam({ name: 'id', description: 'Temporal workflow id' })
  @ApiQuery({ name: 'phase', required: false, type: Boolean })
  @ApiResponse({ status: 403, description: 'Forbidden — workflow belongs to another tenant.' })
  async describeWorkflow(@Param('id') id: string, @Query() query: { phase?: string }): Promise<HarnessWorkflowDetail> {
    const detail = await this.opsClient.describeWorkflow(id, { phase: query.phase === 'true' });
    this.assertWorkflowOwnership(detail.tenantId);
    return detail;
  }

  @Post('workflows/:id/cancel')
  @Authorize(['manage', 'HarnessWorkflow'])
  @ApiOperation({ summary: 'Cancel a harness workflow (graceful). Tenant admins limited to their own tenant.' })
  @ApiParam({ name: 'id', description: 'Temporal workflow id' })
  @ApiResponse({ status: 403, description: 'Forbidden — workflow belongs to another tenant.' })
  async cancelWorkflow(@Param('id') id: string, @Body() body: WorkflowActionRequest): Promise<HarnessWorkflowActionResult> {
    const ownerTenantId = await this.assertOwnershipForAction(id);
    return this.opsClient.cancelWorkflow(id, { tenantId: ownerTenantId, reason: body.reason });
  }

  @Post('workflows/:id/terminate')
  @Authorize(['manage', 'HarnessWorkflow'])
  @ApiOperation({ summary: 'Terminate a harness workflow (forceful). Tenant admins limited to their own tenant.' })
  @ApiParam({ name: 'id', description: 'Temporal workflow id' })
  @ApiResponse({ status: 403, description: 'Forbidden — workflow belongs to another tenant.' })
  async terminateWorkflow(@Param('id') id: string, @Body() body: WorkflowActionRequest): Promise<HarnessWorkflowActionResult> {
    const ownerTenantId = await this.assertOwnershipForAction(id);
    return this.opsClient.terminateWorkflow(id, { tenantId: ownerTenantId, reason: body.reason });
  }

  @Post('workflows/:id/signal')
  @Authorize(['manage', 'HarnessWorkflow'])
  @ApiOperation({ summary: 'Send a signal to a harness workflow. Tenant admins limited to their own tenant.' })
  @ApiParam({ name: 'id', description: 'Temporal workflow id' })
  @ApiResponse({ status: 403, description: 'Forbidden — workflow belongs to another tenant.' })
  async signalWorkflow(@Param('id') id: string, @Body() body: SignalWorkflowRequest): Promise<HarnessWorkflowActionResult> {
    const ownerTenantId = await this.assertOwnershipForAction(id);
    return this.opsClient.signalWorkflow(id, { tenantId: ownerTenantId, signalName: body.signalName, payload: body.payload });
  }

  // ───────────────────────── Live console ─────────────────────────────────────

  @Get('live/sessions')
  @Authorize(['read', 'HarnessWorkflow'])
  @ApiOperation({ summary: 'List the active live-documentation sessions (PHI-safe stats) for the caller tenant' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant. Tenant admins are pinned to their own tenant.' })
  @ApiResponse({ status: 200, type: LiveDocSessionsListResponse })
  async listLiveSessions(@Query() query: { tenantId?: string }): Promise<LiveDocSessionsListResponse> {
    const tenantId = this.resolveReadTenantId(query.tenantId);
    return this.liveDocumentationService.getActiveSessions(tenantId);
  }

  @Get('live/sessions/:id')
  @Authorize(['read', 'HarnessWorkflow'])
  @ApiOperation({ summary: "Get one live-documentation session's latest PHI-safe stats" })
  @ApiParam({ name: 'id', description: 'Consultation id under live documentation' })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiResponse({ status: 200, type: LiveDocSessionStatsResponse })
  @ApiResponse({ status: 404, description: 'No active session for the tenant (absent or expired).' })
  async getLiveSession(@Param('id') id: string, @Query() query: { tenantId?: string }): Promise<LiveDocSessionStatsResponse> {
    const tenantId = this.resolveReadTenantId(query.tenantId);
    const stats = await this.liveDocumentationService.getSessionStats(tenantId, id);
    if (!stats) throw new NotFoundException('No active live-documentation session for this consultation.');
    return stats;
  }

  @Get('live/capabilities')
  @Authorize(['read', 'HarnessWorkflow'])
  @ApiOperation({
    summary: 'Read which realtime consultation capabilities are live for a tenant (lane source, definition, per-node state)',
    description:
      'Resolves the realtime lane the way a recording session does — graph-executor flag, then the WorkflowAssignment cascade, then the published definition — and reports what would actually execute. Three answers: the executor being OFF returns `laneSource: null` with no nodes (the legacy flush runs and there is no lane); ON with no resolvable assignment returns `platform-default` and the platform lane’s own nodes, because those genuinely run; ON with an assignment returns `tenant-graph` with the governing slug and version. Per node it reports the authored `enabled` state and whether that node type offers the switch at all — registry-class `mandatory` nodes (consent gate, capture binding, PHI hop, persist, finalize) never do.',
  })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant. Tenant admins are pinned to their own tenant.' })
  @ApiQuery({
    name: 'departmentId',
    required: false,
    description: 'Resolve the assignment cascade against a department override. Omitted resolves the tenant default.',
  })
  @ApiResponse({ status: 200, type: LiveDocRealtimeCapabilitiesResponse })
  @ApiResponse({ status: 403, description: 'Forbidden — a tenant admin may not read another tenant’s capabilities.' })
  async getRealtimeCapabilities(@Query() query: { tenantId?: string; departmentId?: string }): Promise<LiveDocRealtimeCapabilitiesResponse> {
    const tenantId = this.resolveReadTenantId(query.tenantId);
    return this.liveDocumentationService.getRealtimeCapabilities(tenantId, query.departmentId ?? null);
  }

  @Get('live/config')
  @Authorize(['read', 'HarnessPolicy'])
  @ApiOperation({ summary: 'Read the live-documentation engine kill-switch (super-admin / global scope)' })
  @ApiResponse({ status: 200, type: LiveDocEngineConfigResponse })
  @ApiResponse({ status: 403, description: 'Forbidden — platform (super-admin) privileges required.' })
  async getLiveConfig(): Promise<LiveDocEngineConfigResponse> {
    this.assertLiveConfigAdmin();
    return this.liveDocumentationService.getEngineConfig();
  }

  @Patch('live/config')
  @Authorize(['manage', 'HarnessPolicy'])
  @ApiOperation({
    summary: 'Toggle the live-documentation engine kill-switch (super-admin / global scope)',
    description:
      'Persists a Redis override that survives restart and fans out to all API instances (no redeploy). ' +
      '`enabled: false` engages the kill-switch — new `start()` calls are refused while in-flight sessions drain.',
  })
  @ApiResponse({ status: 200, type: LiveDocEngineConfigResponse })
  @ApiResponse({ status: 403, description: 'Forbidden — platform (super-admin) privileges required.' })
  async updateLiveConfig(@Body() body: UpdateLiveDocEngineConfigRequest): Promise<LiveDocEngineConfigResponse> {
    this.assertLiveConfigAdmin();
    return this.liveDocumentationService.setEngineEnabled(body.enabled, { userId: this.cls.get('user')?.id, reason: body.reason });
  }

  // ───────────────────────── Helpers ─────────────────────────

  /** Resolve the effective read tenant: tenant admins → own tenant; super-admins → `?tenantId=` (or CLS tenant). */
  private resolveReadTenantId(queryTenantId?: string): string {
    return resolveScopedTenantId(this.cls.get('user'), this.cls.get('tenantId'), queryTenantId);
  }

  /** Workflow-list tenant filter: tenant admins → own tenant; super-admins → optional `?tenantId=` (undefined = all tenants). */
  private resolveWorkflowListTenant(queryTenantId?: string): string | undefined {
    return resolveScopedTenantIdOptional(this.cls.get('user'), this.cls.get('tenantId'), queryTenantId);
  }

  /** Platform (super-admin) gate for the GLOBAL-DEFAULT policy routes. */
  private assertPlatform(): void {
    if (!isSuperAdmin(this.cls.get('user'))) {
      throw new ForbiddenException('Editing the harness global-default policy requires platform (super-admin) privileges.');
    }
  }

  /** Platform (super-admin) gate for the live-documentation engine kill-switch (global scope). */
  private assertLiveConfigAdmin(): void {
    if (!isSuperAdmin(this.cls.get('user'))) {
      throw new ForbiddenException('Reading or toggling the live-documentation engine kill-switch requires platform (super-admin) privileges.');
    }
  }

  /**
   * Enforce tenant ownership of a workflow: super-admins bypass; tenant admins
   * must own the workflow's tenant. Returns the owning tenantId (forwarded to
   * the harness so it can re-scope server-side).
   */
  private async assertOwnershipForAction(workflowId: string): Promise<string | undefined> {
    const detail = await this.opsClient.describeWorkflow(workflowId);
    this.assertWorkflowOwnership(detail.tenantId);
    return detail.tenantId ?? undefined;
  }

  private assertWorkflowOwnership(workflowTenantId: string | null): void {
    const user = this.cls.get('user');
    if (isSuperAdmin(user)) return;
    const callerTenant = this.cls.get('tenantId') ?? user?.tenantId ?? undefined;
    if (!callerTenant || !workflowTenantId || workflowTenantId !== callerTenant) {
      throw new ForbiddenException('You do not have access to this workflow');
    }
  }
}
