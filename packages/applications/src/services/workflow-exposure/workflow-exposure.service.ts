import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { generateId, ResourceType, SysEventType, WorkflowDefinitionRepository } from '@arcaai/domains';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { IConfigService } from '../baseServices/_meta/config';
import { IRedisCacheService } from '../baseServices/redis';
import { IS3Service } from '../baseServices/storage';
import { IConsultationService } from '../consultation/consultation/IConsultationService';
import { GetWorkflowRunResult, HarnessGatewayService, StartWorkflowRunSubject } from '../consultation/harness/harness-gateway.service';
import { IEntitlementsService } from '../entitlements/IEntitlementsService';
import { interpreterSessionId, IWorkflowRunService, WorkflowRunResponse } from '../workflow-run';
import { CLAIM_CHECK_BUCKET, mintCompiledConfigClaimCheckRef } from './claim-check';
import { deterministicRunId } from './deterministic-run-id';
import { exposureBoundaryViolation, reservedIdentityKeysIn } from './exposure-palette-policy';
import {
  InvokeWorkflowRequest,
  WorkflowInvokeResponse,
  WorkflowRunCancelResponse,
  WorkflowRunStatusResponse,
  WorkflowSummaryListResponse,
} from './dto';
import { IWorkflowExposureService, InvokeWorkflowOptions, ListWorkflowOptions } from './IWorkflowExposureService';
import { WorkflowExposureDtoMapper } from './workflow-exposure.dto.mapper';

/** Default self-hosted MinIO bucket for the compiled-config claim-check — mirrors the harness's
 *  own `ClaimCheckConfig.bucket` default (`apps/harness/src/harness/core/config.py`). */

/** Terminal statuses `RecordRunFinishedInput.status` accepts — anything else (e.g. `RUNNING`,
 *  or an interpreter-internal stage label) is left alone; the read-model sync is opportunistic. */
const TERMINAL_RUN_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELED', 'TIMED_OUT']);

const IDEMPOTENCY_KEY_PREFIX = 'idempotency:workflow-invoke:';
const IDEMPOTENCY_TTL_SECONDS = 86_400; // 24h — mirrors ConsultationJobService/HarnessInternalService

/**
 * The exposure plane's application service. See
 * `IWorkflowExposureService` for the per-method contract.
 */
@Injectable()
export class WorkflowExposureService extends BaseService implements IWorkflowExposureService {
  constructor(
    private readonly workflowDefinitionRepository: WorkflowDefinitionRepository,
    private readonly harnessGateway: HarnessGatewayService,
    @Inject(IWorkflowRunService) private readonly workflowRunService: IWorkflowRunService,
    @Inject(IConfigService) private readonly configService: IConfigService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    @Optional() @Inject(IS3Service) private readonly s3Service?: IS3Service,
    @Optional() @Inject(IRedisCacheService) private readonly redisCache?: IRedisCacheService,
    @Optional() @Inject(IEntitlementsService) private readonly entitlements?: IEntitlementsService,
    // lane A. Used for ONE thing: re-resolving the PATH `consultationId` against the
    // caller's tenant before it may become a run's `subject`. Optional so a minimal fixture can
    // construct the service; absent, a consultation-bound invoke fails loud rather than
    // dispatching with an unverified id.
    @Optional() @Inject(IConsultationService) private readonly consultationService?: IConsultationService,
  ) {
    super(eventEmitter, clsService, ResourceType.WorkflowDefinition);
  }

  async list(opts: ListWorkflowOptions = {}): Promise<WorkflowSummaryListResponse> {
    const tenantId = this.requireTenantId();
    this.assertExposureEnabled();

    const rows = await this.workflowDefinitionRepository.findActivePublishedByTenant(tenantId);

    // W1 (C-8): the catalogue and the invoke gate must agree. Listing a slug that `invoke` then
    // 404s would be an incoherent contract — and would disclose that a non-exposable definition
    // exists. Filtered with the SAME predicate `invoke` enforces, never a second rule — and now
    // with the SAME plane context, so the consultation-bound catalogue and the consultation-bound
    // gate cannot drift apart either.
    const context = { consultationBound: opts.consultationBound === true };
    const invokable = rows.filter((row) => exposureBoundaryViolation(row, context) === null);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        action: 'listInvokable',
        count: invokable.length,
        excludedByPaletteBoundary: rows.length - invokable.length,
        consultationBound: context.consultationBound,
      },
    });

    return { data: invokable.map((row) => WorkflowExposureDtoMapper.toSummaryResponse(row)) };
  }

  async invoke(slug: string, dto: InvokeWorkflowRequest, opts: InvokeWorkflowOptions): Promise<WorkflowInvokeResponse> {
    this.assertExposureEnabled();
    const tenantId = this.requireTenantId();

    // step 6. With an `Idempotency-Key` the run id is DERIVED, so a retry addresses the
    // same durable row and the same Temporal workflow id with no coordination. Without one, a
    // fresh id per call is correct — the caller asked for a new run.
    const runId = opts.idempotencyKey ? deterministicRunId(tenantId, slug, opts.idempotencyKey) : generateId();

    const idempotencyRedisKey = opts.idempotencyKey ? `${IDEMPOTENCY_KEY_PREFIX}${tenantId}:${slug}:${opts.idempotencyKey}` : null;
    if (idempotencyRedisKey) {
      const cached = await this.tryReadIdempotencyCache(idempotencyRedisKey);
      if (cached) return cached;
      // The DURABLE layer, consulted when the cache misses (eviction, cold node, Redis down —
      // all of which the cache read swallows by design). A run row under this derived id means a
      // prior delivery already started it; JOIN it rather than dispatching a second billed run.
      const joined = await this.tryJoinExistingRun(tenantId, slug, runId);
      if (joined) return joined;
    }

    // 404-over-403: a foreign tenant's slug, an unpublished/inactive slug, or an unknown slug
    // are ALL indistinguishable "not found" — `findPublishedBySlug` returns null for every case.
    const definition = await this.workflowDefinitionRepository.findPublishedBySlug(tenantId, slug);
    if (!definition) {
      throw new NotFoundException(`Workflow '${slug}' not found.`);
    }

    // W1: the exposure plane's palette boundary. A consultation-palette graph
    // reached here writes real `ContextItem` rows through the same `persist_draft` activity the
    // live consultation workflow uses — the interpreter's `external_write` suppression is
    // sandbox-only and does not fire on this plane. See `exposure-palette-policy.ts` for why the
    // gate resolves NODE types and not just the declared `paletteKey`.
    //
    // 404, not 403: consistent with `assertExposureEnabled` and with `findPublishedBySlug`'s
    // unpublished/cross-tenant posture — a definition that is not an exposure product simply does
    // not exist on this plane, and the reason is never disclosed to the caller.
    //
    // lane A: the boundary is now PLANE-AWARE. `consultationBound` is true only when
    // the caller reached a consultation-scoped URL, and it widens the allow-list to
    // `CONSULTATION_BOUND_ALLOWED_PALETTES`. The unbound plane's set is untouched.
    const consultationBound = opts.consultationId !== undefined;
    const boundaryViolation = exposureBoundaryViolation(definition, { consultationBound });
    if (boundaryViolation) {
      this.broadcastSysEvent(SysEventType.ResourceViewed, {
        resourceId: definition.id,
        data: {
          action: 'invokeRefusedByPaletteBoundary',
          slug: definition.slug,
          reason: boundaryViolation,
          consultationBound,
          apiKeyId: opts.apiKeyId ?? null,
        },
      });
      throw new NotFoundException(`Workflow '${slug}' not found.`);
    }

    // step 2 (C-8 link 1, at the composition point). A caller may not supply the keys
    // the interpreter reads as identity — 400, never a silent drop: dropping would let a caller
    // believe it had addressed a consultation while the run acted on something else. Checked
    // AFTER the boundary gate so a non-exposable slug still answers a bare 404 and this
    // validation never becomes an existence oracle over the slug space.
    const smuggled = reservedIdentityKeysIn(dto.input);
    if (smuggled.length > 0) {
      throw new BadRequestException(
        `Reserved run-identity field(s) [${smuggled.join(', ')}] may not be supplied in 'input'. ` +
          'Consultation identity comes from the request path and is resolved server-side.',
      );
    }

    // The binding itself: RE-RESOLVED against the caller's tenant, never taken on trust. A
    // foreign or unknown id reads as absent (the Prisma tenant-scope extension filters it) and
    // is a 404 — the same posture the slug lookup above already takes.
    const subject = consultationBound ? await this.resolveConsultationSubject(opts.consultationId as string) : undefined;

    if (this.entitlements?.isEnforcementEnabled()) {
      await this.entitlements.assertMeterQuota(tenantId, 'monthlyWorkflowInvocations');
    }

    if (!definition.compiledConfig) {
      // Should be unreachable — `findPublishedBySlug` only returns PUBLISHED rows, and publish()
      // always stamps compiledConfig — but a defensive 400 beats crashing on a null read.
      throw new BadRequestException(`Workflow '${slug}' has no compiled configuration.`);
    }

    // (owner ruling, 2026-08-20): a publicly-exposed workflow MAY select a cloud AI
    // provider — the tenant carries the risk (BYOK), consistent with the platform's BYO-first
    // posture. This used to gate on `WORKFLOW_EXPOSURE_ALLOW_CLOUD_PROVIDERS` (decision #6, R-8);
    // that restriction is deliberately removed, not merely defaulted on. .

    if (!this.s3Service) {
      // No storage backend wired (e.g. a minimal test fixture) — fail loud rather than starting
      // a run the interpreter can never load its config for.
      throw new BadRequestException('Workflow invocation is unavailable: no claim-check storage backend is configured.');
    }
    const bucket = CLAIM_CHECK_BUCKET;
    const configRef = await mintCompiledConfigClaimCheckRef(definition.compiledConfig, bucket, (b, key, data, contentType) =>
      this.s3Service!.putFile(b, key, data, contentType),
    );

    const sessionId = interpreterSessionId(runId);

    // Write the ownership-anchor row BEFORE calling the harness dispatcher. A durable row for a
    // run the dispatcher then fails to start is a recoverable "stuck" row; the reverse order (a
    // run started but never durably attributable to a tenant) is the worse failure mode — nothing
    // could ever prove who may read/cancel it.
    await this.workflowRunService.recordRunStarted({
      tenantId,
      workflowVersionId: definition.id,
      workflowSlug: definition.slug,
      workflowVersionNumber: definition.versionNumber,
      definitionName: definition.name,
      sessionId,
      runId,
      trigger: 'api invoke',
      isSandbox: false,
    });

    const started = await this.harnessGateway.startWorkflowRun({
      runId,
      sessionId,
      workflowVersionId: definition.id,
      tenantId,
      configRef,
      sandbox: false,
      // The caller's invocation input, forwarded verbatim into `InterpreterInput.payload` —
      // which is what `input.context_binding`'s `bindings[].from` paths resolve against
      // (`'payload.text'` addresses `{"payload": run_payload}`). This was missing: `dto.input`
      // was accepted and validated at the route, then never sent, so every invoked run executed
      // against an EMPTY payload and any graph with a required input binding failed with
      // "required kind '<k>' (from 'payload.<k>') missing from run payload". The field already
      // existed on `StartWorkflowRunInput` for Workbench path; only this call site
      // omitted it.
      //
      // "Verbatim" no longer means "including identity": `dto.input` has been proven free of
      // every `RESERVED_RUN_IDENTITY_KEYS` entry above, and the dispatcher strips them again on
      // its side regardless of what any caller sends.
      payload: dto.input,
      // The server-resolved clinical subject — the ONLY channel run identity travels on.
      subject,
    });

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: definition.id,
      data: {
        action: 'invoke',
        runId,
        slug: definition.slug,
        workflowVersionNumber: definition.versionNumber,
        principalType: opts.apiKeyId ? 'apiKey' : 'user',
        apiKeyId: opts.apiKeyId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
        // Attributable by construction: which consultation this run may write to, as the SERVER
        // resolved it. Never the caller's claim.
        consultationId: subject?.consultationId ?? null,
      },
    });

    const response = WorkflowExposureDtoMapper.toInvokeResponse(runId, definition.slug, started.status);

    if (idempotencyRedisKey) {
      await this.tryWriteIdempotencyCache(idempotencyRedisKey, response);
    }

    return response;
  }

  async getRunStatus(slug: string, runId: string): Promise<WorkflowRunStatusResponse> {
    const tenantId = this.requireTenantId();
    const run = await this.resolveOwnedRun(tenantId, slug, runId);

    const upstream = await this.harnessGateway.getWorkflowRun(runId);
    await this.syncTerminalStatus(tenantId, run, upstream);

    return WorkflowExposureDtoMapper.toStatusResponse(run.workflowSlug, run.workflowVersionNumber, upstream, run.resultRef ?? null);
  }

  async cancelRun(slug: string, runId: string): Promise<WorkflowRunCancelResponse> {
    const tenantId = this.requireTenantId();
    const run = await this.resolveOwnedRun(tenantId, slug, runId);

    const result = await this.harnessGateway.cancelWorkflowRun(runId);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: run.workflowVersionId,
      data: { action: 'cancel', runId },
    });

    return WorkflowExposureDtoMapper.toCancelResponse(runId, result.status);
  }

  // ============================================================
  // Internals
  // ============================================================

  private requireTenantId(): string {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new ArgumentInvalidException('Tenant context required');
    }
    return tenantId;
  }

  /** `WORKFLOW_EXPOSURE_ENABLED` (R-1) — OFF by default; the surface's existence is not
   *  disclosed while gated (404, same posture as `registration.selfSignupEnabled`). */
  private assertExposureEnabled(): void {
    if (this.configService.getConfigValue('WORKFLOW_EXPOSURE_ENABLED') !== true) {
      throw new NotFoundException('Not found.');
    }
  }

  /**
   * The run's clinical subject, re-resolved from the PATH `consultationId` against the caller's
   * tenant (lane A — the invariant states).
   *
   * `IConsultationService.getById` IS the tenant boundary, and it is already two layers deep:
   * the Prisma tenant-scope extension filters a foreign row out of the read (⇒ `null`), and
   * `assertEqualTenants` inside that method fails closed on a row that reached it anyway (a
   * stale CLS, a future unscoped read path) with a generic `NotFoundException`. Both answer 404,
   * never 403 — a caller must not learn that a consultation it cannot touch exists.
   *
   * This method deliberately does NOT re-compare `tenantId` itself: `ConsultationResponse`
   * carries no `tenantId` field (neither the DTO nor its mapper populate one), so such a compare
   * would read `undefined` and pass for every row — a guard that cannot fail is worse than none,
   * because it invites the reader to stop looking for the real one.
   *
   * `userId` is the ACTING principal from CLS, not anything the caller sent. It may legitimately
   * be absent on a machine-credential call, and the consultation activities treat that as "no
   * acting user" rather than substituting one.
   */
  private async resolveConsultationSubject(consultationId: string): Promise<StartWorkflowRunSubject> {
    if (!this.consultationService) {
      // No resolver wired (a minimal fixture) — fail loud rather than dispatching a consultation
      // run with an UNVERIFIED id, which is the C-8 shape itself.
      throw new BadRequestException('Consultation-bound workflow invocation is unavailable: no consultation resolver is configured.');
    }

    // A cross-tenant id raises inside `getById`; an unknown one returns null. Both -> 404 here.
    const consultation = await this.consultationService.getById(consultationId).catch(() => null);
    if (!consultation) {
      throw new NotFoundException(`Consultation '${consultationId}' not found.`);
    }

    return {
      consultationId: consultation.id,
      externalPatientId: consultation.patientId ?? undefined,
      userId: this.requestUserId ?? undefined,
    };
  }

  /**
   * The DURABLE half of idempotency: a run row already exists under the derived id, so a retried
   * delivery joins it instead of dispatching a second billed run.
   *
   * A miss is the normal first-delivery case and must not be an error, so `getRun`'s 404 is
   * swallowed. Any OTHER failure is swallowed too and the invoke proceeds — the same posture the
   * Redis fast path takes, and safe for the same reason: Temporal's own `USE_EXISTING` +
   * `REJECT_DUPLICATE` still refuse a second execution under that workflow id.
   */
  private async tryJoinExistingRun(tenantId: string, slug: string, runId: string): Promise<WorkflowInvokeResponse | null> {
    try {
      const existing = await this.workflowRunService.getRun(tenantId, runId);
      if (existing.workflowSlug !== slug) return null;
      return WorkflowExposureDtoMapper.toInvokeResponse(runId, slug, 'already_running');
    } catch {
      return null;
    }
  }

  /** Cross-tenant `runId`, or a `runId` whose lineage does not belong to `slug` -> 404 (never 403). */
  private async resolveOwnedRun(tenantId: string, slug: string, runId: string): Promise<WorkflowRunResponse> {
    const run = await this.workflowRunService.getRun(tenantId, runId);
    if (run.workflowSlug !== slug) {
      throw new NotFoundException(`Run '${runId}' not found for workflow '${slug}'.`);
    }
    return run;
  }

  private async syncTerminalStatus(tenantId: string, run: WorkflowRunResponse, upstream: GetWorkflowRunResult): Promise<void> {
    if (!TERMINAL_RUN_STATUSES.has(upstream.status)) return;
    try {
      await this.workflowRunService.recordRunFinished({
        tenantId,
        sessionId: run.sessionId,
        runId: run.runId,
        status: upstream.status as 'COMPLETED' | 'FAILED' | 'CANCELED' | 'TIMED_OUT',
        endedAt: upstream.endedAt ? new Date(upstream.endedAt) : undefined,
      });
    } catch {
      // Best-effort read-model sync — the live upstream status is still returned to the caller
      // regardless of whether the read-model row could be updated.
    }
  }

  private async tryReadIdempotencyCache(key: string): Promise<WorkflowInvokeResponse | null> {
    if (!this.redisCache) return null;
    try {
      const cached = await this.redisCache.get(key);
      return cached ? (JSON.parse(cached) as WorkflowInvokeResponse) : null;
    } catch {
      return null; // best-effort — a lookup failure falls through to a normal (fresh) invoke
    }
  }

  private async tryWriteIdempotencyCache(key: string, response: WorkflowInvokeResponse): Promise<void> {
    if (!this.redisCache) return;
    try {
      await this.redisCache.setex(key, IDEMPOTENCY_TTL_SECONDS, JSON.stringify(response));
    } catch {
      // A record failure means a retry within the TTL may start a second run — logged upstream
      // by the cache service itself; never a reason to fail the invoke that already succeeded.
    }
  }
}
