import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  generateId,
  ResourceType,
  SysEventType,
  WorkflowDefinitionRepository,
  WorkflowWebhookSecretFactory,
  WorkflowWebhookSecretRepository,
} from '@arcaai/domains';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { declaredOutputProtocols, declaredTriggerKinds, isCoreGraph, type WorkflowGraph } from '@arcaai/workflow-contract';

/** A graph column read as the contract's shape — a null/garbled column reads as an empty graph. */
function graphOf(value: unknown): Pick<WorkflowGraph, 'nodes'> {
  const nodes = (value as { nodes?: unknown } | null)?.nodes;
  return { nodes: Array.isArray(nodes) ? (nodes as WorkflowGraph['nodes']) : [] };
}
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { IConfigService } from '../baseServices/_meta/config';
import { SecretsService } from '../baseServices/_meta/secrets';
import { IRedisCacheService } from '../baseServices/redis';
import { WebhookService } from '../webhook/webhook.service';
import { IS3Service } from '../baseServices/storage';
import { IConsultationService } from '../consultation/consultation/IConsultationService';
import { GetWorkflowRunResult, HarnessGatewayService, StartWorkflowRunSubject } from '../consultation/harness/harness-gateway.service';
import { IEntitlementsService } from '../entitlements/IEntitlementsService';
import { interpreterSessionId, IWorkflowRunService, WorkflowRunResponse } from '../workflow-run';
import { CLAIM_CHECK_BUCKET, mintCompiledConfigClaimCheckRef } from './claim-check';
import { deterministicRunId } from './deterministic-run-id';
import { exposureBoundaryViolation, reservedIdentityKeysIn } from './exposure-palette-policy';
import { describeWorkflow, type WorkflowSchemaDescription } from './workflow-schema-description';
import {
  InvokeWorkflowRequest,
  WorkflowInvokeResponse,
  WorkflowRunCancelResponse,
  WorkflowRunStatusResponse,
  WorkflowSummaryListResponse,
} from './dto';
import {
  IWorkflowExposureService,
  InvokeWorkflowOptions,
  ListWorkflowOptions,
  WebhookTriggerInput,
  WorkflowRunResponseMode,
  WorkflowWebhookSecretResponse,
} from './IWorkflowExposureService';
import { WorkflowExposureDtoMapper } from './workflow-exposure.dto.mapper';

/** Default self-hosted MinIO bucket for the compiled-config claim-check — mirrors the harness's
 *  own `ClaimCheckConfig.bucket` default (`apps/harness/src/harness/core/config.py`). */

/** Terminal statuses `RecordRunFinishedInput.status` accepts — anything else (e.g. `RUNNING`,
 *  or an interpreter-internal stage label) is left alone; the read-model sync is opportunistic. */
const TERMINAL_RUN_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELED', 'TIMED_OUT']);

const IDEMPOTENCY_KEY_PREFIX = 'idempotency:workflow-invoke:';
const IDEMPOTENCY_TTL_SECONDS = 86_400; // 24h — mirrors ConsultationJobService/HarnessInternalService

/** TASK-864 — the inbound webhook's replay window, in seconds, on `X-Hope-Timestamp`. */
export const WEBHOOK_TRIGGER_REPLAY_WINDOW_SECONDS = 300;
/** The dedicated pepper `Webhook.hashedSecret` already uses — never `API_KEY_PEPPER`. */
const WEBHOOK_SECRET_PEPPER_NAME = 'WEBHOOK_SECRET_PEPPER';

/**
 * TASK-864 §3.4 — which `?mode=` an Output protocol admits. `async` is always allowed (poll
 * `GET …/runs/{runId}`). Pure; exported for the controller test.
 */
export function modeRefusal(graph: unknown, mode: WorkflowRunResponseMode | undefined): string | null {
  if (mode === undefined || mode === 'async') return null;
  const protocols = declaredOutputProtocols(graphOf(graph));
  if (protocols.length === 0) return null; // a legacy palette declares nothing and is unrestricted
  const required = mode === 'blocking' ? 'http' : 'http-sse';
  if (protocols.includes(required)) return null;
  return `mode '${mode}' requires the workflow to publish the '${required}' protocol; it declares [${protocols.join(', ')}]. Use mode=async, or one of the declared protocols.`;
}

/**
 * The string an inbound webhook sender signs: `"<timestamp>.<rawBody>"` under HMAC-SHA256 with
 * the definition's secret, sent as `X-Hope-Signature: sha256=<hex>` (the Stripe/GitHub shape,
 * and the same header family the OUTBOUND deliveries use). Pure; exported for tests and docs.
 */
export function signWebhookTrigger(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
}

function signaturesMatch(expected: string, presented: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

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
    // TASK-864 — the inbound webhook trigger's per-definition secret row and the pepper that
    // encrypts it. Both optional so a minimal fixture constructs; absent, the webhook plane
    // fails loud (a 404 on the public route, a 400 on rotation) rather than running unsigned.
    @Optional() private readonly webhookSecretRepository?: WorkflowWebhookSecretRepository,
    @Optional() private readonly secretsService?: SecretsService,
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

    // TASK-864 §3.4 — a `core` graph declares WHICH trigger kinds may start it and WHICH
    // protocols its Output publishes. A kind the Trigger did not declare is a 404 (the same
    // "not a product on this plane" posture as the palette boundary); a `?mode=` the Output
    // does not publish is a 400 naming the declared protocols — the caller is authenticated
    // and the definition is theirs, so there is nothing to hide, only something to fix.
    if (isCoreGraph(graphOf(definition.graph))) {
      const kinds = declaredTriggerKinds(graphOf(definition.graph));
      const requiredKind = opts.trigger === 'webhook' ? 'webhook' : consultationBound ? 'consultation' : 'api';
      if (!kinds.includes(requiredKind)) {
        this.broadcastSysEvent(SysEventType.ResourceViewed, {
          resourceId: definition.id,
          data: { action: 'invokeRefusedByTriggerKind', slug: definition.slug, requiredKind, declaredKinds: kinds },
        });
        throw new NotFoundException(`Workflow '${slug}' not found.`);
      }
      const refusal = modeRefusal(definition.graph, opts.mode);
      if (refusal) throw new BadRequestException(refusal);
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
      trigger: opts.trigger ?? 'api invoke',
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

    // TASK-864 (G9): the read model records CANCELED HERE, at the cancel, instead of waiting for
    // a later status read to notice. The interpreter's own terminal event, when it arrives,
    // re-records the same status idempotently.
    try {
      await this.workflowRunService.recordRunFinished({
        tenantId,
        sessionId: run.sessionId,
        runId: run.runId,
        status: 'CANCELED',
        terminalReason: 'cancelled_by_caller',
      });
    } catch {
      // Best-effort read-model write — the cancel signal already reached the run.
    }

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: run.workflowVersionId,
      data: { action: 'cancel', runId },
    });

    return WorkflowExposureDtoMapper.toCancelResponse(runId, result.status);
  }

  // ============================================================
  // TASK-864 §3.4 — the INBOUND webhook trigger and its secret
  // ============================================================

  async triggerByWebhook(hookId: string, input: WebhookTriggerInput): Promise<WorkflowInvokeResponse> {
    // Every refusal on this UNAUTHENTICATED plane is the same 404: the hook id is the only
    // public handle, and a distinguishable failure would be an oracle over it.
    const refuse = (): never => {
      throw new NotFoundException('Not found.');
    };
    if (!this.webhookSecretRepository || !input.signature || !input.timestamp) refuse();

    const row = await this.webhookSecretRepository!.findById(hookId).catch(() => null);
    if (!row) refuse();

    // Replay window on the SIGNED timestamp.
    const sentAt = Number(input.timestamp);
    if (!Number.isFinite(sentAt) || Math.abs(Date.now() / 1000 - sentAt) > WEBHOOK_TRIGGER_REPLAY_WINDOW_SECONDS) refuse();

    const pepper = (await this.secretsService?.getSecretOptional(WEBHOOK_SECRET_PEPPER_NAME)) ?? undefined;
    let secret: string;
    try {
      secret = WebhookService.decryptSecret(row!.encryptedSecret, pepper);
    } catch {
      return refuse();
    }
    if (!signaturesMatch(signWebhookTrigger(secret, input.timestamp!, input.rawBody), input.signature!)) refuse();

    let body: unknown;
    try {
      body = JSON.parse(input.rawBody);
    } catch {
      throw new BadRequestException('The webhook body must be a JSON object — the trigger payload.');
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new BadRequestException('The webhook body must be a JSON object — the trigger payload.');
    }

    // The secret row names the tenant; from here the run is the tenant's, exactly as an API
    // invoke is. The signature just proved possession of that tenant's key.
    this.clsService.set('tenantId', row!.tenantId);
    return this.invoke(
      row!.workflowSlug,
      { input: body as Record<string, unknown> },
      {
        idempotencyKey: input.idempotencyKey,
        trigger: 'webhook',
        mode: 'async',
      },
    );
  }

  async describe(slug: string): Promise<WorkflowSchemaDescription> {
    this.assertExposureEnabled();
    const tenantId = this.requireTenantId();
    const definition = await this.workflowDefinitionRepository.findPublishedBySlug(tenantId, slug);
    if (!definition || exposureBoundaryViolation(definition, {}) !== null) {
      throw new NotFoundException(`Workflow '${slug}' not found.`);
    }
    return describeWorkflow(definition.slug, definition.versionNumber, graphOf(definition.graph));
  }

  async rotateWebhookSecret(slug: string): Promise<WorkflowWebhookSecretResponse> {
    const tenantId = this.requireTenantId();
    if (!this.webhookSecretRepository) {
      throw new BadRequestException('Inbound webhook secrets are unavailable: no secret store is configured.');
    }
    // 404-over-403: an unknown or foreign slug reads as absent.
    const definition = await this.workflowDefinitionRepository.findPublishedBySlug(tenantId, slug);
    if (!definition) throw new NotFoundException(`Workflow '${slug}' not found.`);

    const raw = randomBytes(32).toString('hex');
    const pepper = (await this.secretsService?.getSecretOptional(WEBHOOK_SECRET_PEPPER_NAME)) ?? undefined;
    const encrypted = WebhookService.encryptSecret(raw, pepper);
    const rotatedAt = new Date();

    const existing = await this.webhookSecretRepository.findByTenantSlug(tenantId, slug);
    let saved;
    if (existing) {
      existing.encryptedSecret = encrypted;
      existing.rotatedAt = rotatedAt;
      existing.updatedBy = this.requestUserId ?? undefined;
      saved = await this.webhookSecretRepository.updateWithVersion(existing.id, existing, existing.version);
    } else {
      saved = await this.webhookSecretRepository.create(
        WorkflowWebhookSecretFactory.CreateWorkflowWebhookSecret({
          tenantId,
          workflowSlug: slug,
          encryptedSecret: encrypted,
          rotatedAt,
          createdBy: this.requestUserId ?? undefined,
        }),
      );
    }

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: definition.id,
      data: { action: 'rotateWebhookSecret', slug, hookId: saved.id },
    });

    return { slug, secret: raw, rotatedAt: rotatedAt.toISOString(), hookUrl: `/api/v1/hooks/workflows/${saved.id}` };
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
