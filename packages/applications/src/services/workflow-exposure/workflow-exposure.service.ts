import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { generateId, ResourceType, SysEventType, WorkflowDefinitionRepository } from '@arcaai/domains';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { IConfigService } from '../baseServices/_meta/config';
import { IRedisCacheService } from '../baseServices/redis';
import { IS3Service } from '../baseServices/storage';
import { GetWorkflowRunResult, HarnessGatewayService } from '../consultation/harness/harness-gateway.service';
import { IEntitlementsService } from '../entitlements/IEntitlementsService';
import { interpreterSessionId, IWorkflowRunService, WorkflowRunResponse } from '../workflow-run';
import { mintCompiledConfigClaimCheckRef } from './claim-check';
import { findDisallowedCloudProvider } from './cloud-provider-guard';
import {
  InvokeWorkflowRequest,
  WorkflowInvokeResponse,
  WorkflowRunCancelResponse,
  WorkflowRunStatusResponse,
  WorkflowSummaryListResponse,
} from './dto';
import { IWorkflowExposureService, InvokeWorkflowOptions } from './IWorkflowExposureService';
import { WorkflowExposureDtoMapper } from './workflow-exposure.dto.mapper';

/** Default self-hosted MinIO bucket for the compiled-config claim-check — mirrors the harness's
 *  own `ClaimCheckConfig.bucket` default (`apps/harness/src/harness/core/config.py`). */
const DEFAULT_CLAIM_CHECK_BUCKET = 'harness-claim-check';

/** Terminal statuses `RecordRunFinishedInput.status` accepts — anything else (e.g. `RUNNING`,
 *  or an interpreter-internal stage label) is left alone; the read-model sync is opportunistic. */
const TERMINAL_RUN_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELED', 'TIMED_OUT']);

const IDEMPOTENCY_KEY_PREFIX = 'idempotency:workflow-invoke:';
const IDEMPOTENCY_TTL_SECONDS = 86_400; // 24h — mirrors ConsultationJobService/HarnessInternalService

/**
 * The exposure plane's application service (TASK-722 Task 5). See
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
  ) {
    super(eventEmitter, clsService, ResourceType.WorkflowDefinition);
  }

  async list(): Promise<WorkflowSummaryListResponse> {
    const tenantId = this.requireTenantId();
    this.assertExposureEnabled();

    const rows = await this.workflowDefinitionRepository.findActivePublishedByTenant(tenantId);

    this.broadcastSysEvent(SysEventType.ResourceViewed, { data: { action: 'listInvokable', count: rows.length } });

    return { data: rows.map((row) => WorkflowExposureDtoMapper.toSummaryResponse(row)) };
  }

  async invoke(slug: string, dto: InvokeWorkflowRequest, opts: InvokeWorkflowOptions): Promise<WorkflowInvokeResponse> {
    this.assertExposureEnabled();
    const tenantId = this.requireTenantId();

    const idempotencyRedisKey = opts.idempotencyKey ? `${IDEMPOTENCY_KEY_PREFIX}${tenantId}:${slug}:${opts.idempotencyKey}` : null;
    if (idempotencyRedisKey) {
      const cached = await this.tryReadIdempotencyCache(idempotencyRedisKey);
      if (cached) return cached;
    }

    // 404-over-403: a foreign tenant's slug, an unpublished/inactive slug, or an unknown slug
    // are ALL indistinguishable "not found" — `findPublishedBySlug` returns null for every case.
    const definition = await this.workflowDefinitionRepository.findPublishedBySlug(tenantId, slug);
    if (!definition) {
      throw new NotFoundException(`Workflow '${slug}' not found.`);
    }

    if (this.entitlements?.isEnforcementEnabled()) {
      await this.entitlements.assertMeterQuota(tenantId, 'monthlyWorkflowInvocations');
    }

    if (!definition.compiledConfig) {
      // Should be unreachable — `findPublishedBySlug` only returns PUBLISHED rows, and publish()
      // always stamps compiledConfig — but a defensive 400 beats crashing on a null read.
      throw new BadRequestException(`Workflow '${slug}' has no compiled configuration.`);
    }

    const allowCloudProviders = this.configService.getConfigValue('WORKFLOW_EXPOSURE_ALLOW_CLOUD_PROVIDERS') === true;
    const disallowedProvider = findDisallowedCloudProvider(definition.compiledConfig, allowCloudProviders);
    if (disallowedProvider) {
      throw new ForbiddenException(
        `Workflow '${slug}' selects the cloud provider '${disallowedProvider}', which this tenant has not opted into for public invocation.`,
      );
    }

    if (!this.s3Service) {
      // No storage backend wired (e.g. a minimal test fixture) — fail loud rather than starting
      // a run the interpreter can never load its config for.
      throw new BadRequestException('Workflow invocation is unavailable: no claim-check storage backend is configured.');
    }
    const bucket = DEFAULT_CLAIM_CHECK_BUCKET;
    const configRef = await mintCompiledConfigClaimCheckRef(definition.compiledConfig, bucket, (b, key, data, contentType) =>
      this.s3Service!.putFile(b, key, data, contentType),
    );

    const runId = generateId();
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

    return WorkflowExposureDtoMapper.toStatusResponse(run.workflowSlug, run.workflowVersionNumber, upstream);
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
