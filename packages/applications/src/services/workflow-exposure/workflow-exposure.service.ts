import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  ConsultationContextSchemaRepository,
  generateId,
  ResourceType,
  SysEventType,
  WorkflowDefinitionRepository,
  WorkflowWebhookSecretFactory,
  WorkflowWebhookSecretRepository,
} from '@arcaai/domains';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { declaredOutputProtocols, declaredTriggerKinds, isCoreGraph } from '@arcaai/workflow-contract';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { IConfigService } from '../baseServices/_meta/config';
import { SecretsService } from '../baseServices/_meta/secrets';
import { IRedisCacheService } from '../baseServices/redis';
import { idempotencyCanonicalJson } from '../consultation/jobs/job-idempotency.service';
import { WORKFLOW_EXPOSURE_ENABLED_KEY } from '../settings-registry/descriptors/feature-availability.descriptors';
import { WORKFLOW_RUNS_DEFAULTS, WORKFLOW_RUNS_RESULT_URL_TTL_SECONDS_KEY } from '../settings-registry/descriptors/workflow-runs.descriptors';
import { TenantSettingsService } from '../settings-registry/tenant-settings.service';
import { WebhookService } from '../webhook/webhook.service';
import { IBlobStorageService, IS3Service } from '../baseServices/storage';
import { IConsultationService } from '../consultation/consultation/IConsultationService';
import { GetWorkflowRunResult, HarnessGatewayService, StartWorkflowRunSubject } from '../consultation/harness/harness-gateway.service';
import { IBillingService } from '../billing/IBillingService';
import { IEntitlementsService } from '../entitlements/IEntitlementsService';
import { IContextUserIdentityService, extractUserIdentityValue } from '../user/identity';
import type { UserIdentityBinding } from '../consultation-context-schema/context-schema-definition';
import {
  deliveredRunResultFrom,
  interpreterSessionId,
  isResultKeyInTenantPrefix,
  IWorkflowRunService,
  principalScopedIdempotencyKey,
  readPersistedRunResult,
  RunPrincipalAccessService,
  terminalStatusOf,
  workflowRunNotFound,
  WorkflowRunResponse,
} from '../workflow-run';
import { effectiveExposureSettings, isWorkflowEntryAllowed, type WorkflowEntry } from '../workflow-definition/exposure-settings';
import { CLAIM_CHECK_BUCKET, mintCompiledConfigClaimCheckRef } from './claim-check';
import { EffectiveTriggerSchemaService } from './effective-trigger-schema.service';
import { deterministicRunId } from './deterministic-run-id';
import { exposureBoundaryViolation, reservedIdentityKeysIn } from './exposure-palette-policy';
import { describeWorkflow, graphOf, type WorkflowContextSchemaBinding, type WorkflowSchemaDescription } from './workflow-schema-description';
import {
  InvokeWorkflowRequest,
  ReviewDecisionRequest,
  WorkflowInvokeResponse,
  WorkflowReviewDecisionResponse,
  WorkflowReviewResponse,
  RUN_NOT_TERMINAL,
  WorkflowRunCancelResponse,
  WorkflowRunResult,
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

/** TASK-982 settled-node counts (TASK-1036 B6b: derived on the status read path). */
interface SettledNodeCounts {
  nodeCount: number;
  failedNodeCount: number;
  degradedNodeCount: number;
  skippedNodeCount: number;
}

/**
 * The four counts from the harness state query's settled `stages` (each node `{ status }`) — the
 * harness's own `_settled_node_counts`. `undefined` when no node settled (nothing to report, never
 * a fabricated zero). Pure.
 */
export function settledNodeCountsFromStages(stages: readonly unknown[] | undefined): SettledNodeCounts | undefined {
  const statuses: string[] = [];
  for (const stage of stages ?? []) {
    const nodes = (stage as { nodes?: unknown } | null)?.nodes;
    if (!Array.isArray(nodes)) continue;
    for (const node of nodes) {
      const status = (node as { status?: unknown } | null)?.status;
      if (typeof status === 'string') statuses.push(status);
    }
  }
  if (statuses.length === 0) return undefined;
  const count = (wanted: string) => statuses.filter((status) => status === wanted).length;
  return { nodeCount: statuses.length, failedNodeCount: count('FAILED'), degradedNodeCount: count('DEGRADED'), skippedNodeCount: count('SKIPPED') };
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
    // TASK-932 D-4 - the exposure kill-switch moved from `WORKFLOW_EXPOSURE_ENABLED`
    // (env, one value for the whole deployment, needs a redeploy) to the
    // `global-kv` cascade, so a platform admin can withdraw the public plane from
    // ONE tenant. `@Optional()` for the same reason every other cross-cutting
    // dependency here is: a minimal fixture must still construct the service, and
    // an unwired settings graph degrades to the pre-TASK-932 env read rather than
    // to a DI error (the `resolveTextTimeoutMs` shape).
    @Optional() private readonly tenantSettings?: TenantSettingsService,
    // TASK-950 (D-6) — the find-or-provision resolver for the schema-declared user identity on a
    // STANDALONE machine run. `@Optional()` like every other cross-cutting dependency here (a
    // minimal fixture must still construct the service), but never silently skipped: a run that
    // HAS a frozen binding, a machine caller and a supplied value and finds no resolver raises
    // 503 rather than dispatching with no acting clinician.
    @Optional() @Inject(IContextUserIdentityService) private readonly userIdentity?: IContextUserIdentityService,
    // TASK-957 F-4 — the tenant's OPTIONAL monthly spend ceiling (D12). `monthlyWorkflowInvocations`
    // above is a COUNT quota: a run under it is free however much it spends, and one run can fan
    // out to dozens of LLM steps. The ceiling is the money control, and it reached consultation
    // summaries only. `@Optional()` like every other cross-cutting dependency here; absent = not
    // enforced, which is what a minimal fixture gets.
    @Optional() @Inject(IBillingService) private readonly billing?: IBillingService,
    // Used for ONE thing: turning the stamped `contextSchemaId` into a slug for the description's
    // `contextSchema` block. `@Optional()` like every other cross-cutting dependency here; absent
    // simply leaves that slug `null`, which is also what an unreadable schema row yields.
    @Optional() private readonly contextSchemaRepository?: ConsultationContextSchemaRepository,
    // Resolves the tenant's CURRENT schema pin for a trigger that binds by it, so the per-run
    // config below is checked against what the tenant has pinned NOW. `@Optional()` like every
    // other cross-cutting dependency here; absent, every trigger runs against its published
    // bytes — the behaviour a follow-latest workflow had before this existed.
    @Optional() private readonly effectiveTriggerSchema?: EffectiveTriggerSchemaService,
    // TASK-1038 D-I — signs the short-lived GET URL for a claim-checked result (the tenant-bucket
    // gate applies). `@Optional()` like every other cross-cutting dependency here; absent, a
    // `ref` result answers 503 rather than a URL nobody can open.
    @Optional() @Inject(IBlobStorageService) private readonly blobStorage?: IBlobStorageService,
    // TASK-1038 OD-35 — binds every business-plane run read (status — and through it the SSE
    // stream, the socket and the stream-ticket mint — result, cancel) to the principal that
    // started the run, and records that principal at `invoke`. Provided by
    // `WorkflowRunServiceModule` (imported by this service's module); `@Optional()` only so the
    // positional unit fixtures keep constructing — absent, reads are tenant-scoped as before.
    @Optional() private readonly runAccess?: RunPrincipalAccessService,
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

    // TASK-1038 OD-35 — who is starting this run: the API key, the service account, or the human
    // of a JWT (`null` on the public webhook plane). Recorded on the row; every business-plane read
    // of the run is bound to it.
    const startedBy = this.runAccess?.currentPrincipal() ?? null;

    // step 6. With an `Idempotency-Key` the run id is DERIVED, so a retry addresses the
    // same durable row and the same Temporal workflow id with no coordination. Without one, a
    // fresh id per call is correct — the caller asked for a new run.
    //
    // OD-35 — the key is scoped to the principal presenting it: two credentials that happen to
    // send the same key derive two runs, so one can never join (or learn the id of) the other's.
    const scopedIdempotencyKey = opts.idempotencyKey ? principalScopedIdempotencyKey(startedBy, opts.idempotencyKey) : undefined;
    const runId = scopedIdempotencyKey ? deterministicRunId(tenantId, slug, scopedIdempotencyKey) : generateId();

    const idempotencyRedisKey = scopedIdempotencyKey ? `${IDEMPOTENCY_KEY_PREFIX}${tenantId}:${slug}:${scopedIdempotencyKey}` : null;
    // TASK-1038 E2 (fix 11) — the agent-run semantic on workflow runs: the key names ONE intent.
    // Same key + same body joins; a DIFFERENT body is 409 `IDEMPOTENCY_KEY_REUSED`. The body is
    // the caller's `input` plus the server-resolved consultation the run is bound to.
    const requestBodyHash = opts.idempotencyKey ? workflowInvokeBodyHash(dto, opts.consultationId) : null;
    if (idempotencyRedisKey && requestBodyHash) {
      const cached = await this.tryReadIdempotencyCache(idempotencyRedisKey);
      if (cached) {
        if (cached.requestBodyHash !== undefined && cached.requestBodyHash !== requestBodyHash) throw idempotencyKeyReused();
        return cached.response;
      }
      // The DURABLE layer, consulted when the cache misses (eviction, cold node, Redis down —
      // all of which the cache read swallows by design). A run row under this derived id means a
      // prior delivery already started it; JOIN it rather than dispatching a second billed run.
      const joined = await this.tryJoinExistingRun(tenantId, slug, runId, requestBodyHash);
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

    // TASK-1036 (OD-4, lane B6b) — the workflow's SETTINGS decide which entry points it admits:
    // frozen at publish (`compiledConfig.settings`), else the graph's own `settings`. The entry is
    // the caller's connection (`api`, `webhook`) or the `consultation` source; `?mode=stream`
    // additionally needs `sse`. A refused entry is the same 404 as below; a refused mode the same
    // 400. Only a definition with NO settings falls through to the legacy checks (D-4).
    const exposure = effectiveExposureSettings({ compiledConfig: definition.compiledConfig, graph: definition.graph });
    if (exposure.origin !== 'legacy') {
      const entry: WorkflowEntry = opts.trigger === 'webhook' ? 'webhook' : consultationBound ? 'consultation' : 'api';
      if (!isWorkflowEntryAllowed(exposure, entry)) {
        this.broadcastSysEvent(SysEventType.ResourceViewed, {
          resourceId: definition.id,
          data: {
            action: 'invokeRefusedByExposureSettings',
            slug: definition.slug,
            requiredEntry: entry,
            connections: exposure.connections,
            sources: exposure.sources,
          },
        });
        throw new NotFoundException(`Workflow '${slug}' not found.`);
      }
      if (opts.mode === 'stream' && !isWorkflowEntryAllowed(exposure, 'sse')) {
        throw new BadRequestException(
          `mode 'stream' requires the workflow to admit the 'sse' connection; it admits [${exposure.connections.join(', ')}]. Use mode=async, or mode=blocking.`,
        );
      }
    } else if (isCoreGraph(graphOf(definition.graph))) {
      // TASK-864 §3.4 (legacy, D-4 — one release) — a `core` graph declares WHICH trigger kinds may
      // start it and WHICH protocols its Output publishes. A kind the Trigger did not declare is a
      // 404 (the same "not a product on this plane" posture as the palette boundary); a `?mode=`
      // the Output does not publish is a 400 naming the declared protocols — the caller is
      // authenticated and the definition is theirs, so there is nothing to hide, only something to fix.
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
    // TASK-957 F-4 — and the tenant's own spend ceiling, OUTSIDE that branch on purpose: the
    // enforcement kill-switch governs the allowance plane, while the ceiling is a limit the
    // tenant set for itself. Checked before the run row and the dispatcher, so a refusal leaves
    // nothing half-started. -> 402 when over; a no-op (no draft computed) when unset.
    await this.billing?.assertSpendLimit(tenantId);

    if (!definition.compiledConfig) {
      // Should be unreachable — `findPublishedBySlug` only returns PUBLISHED rows, and publish()
      // always stamps compiledConfig — but a defensive 400 beats crashing on a null read.
      throw new BadRequestException(`Workflow '${slug}' has no compiled configuration.`);
    }

    // TASK-950 (D-6, OD-5) — the trigger schema's USER-IDENTITY field, for a STANDALONE machine
    // run only.
    //
    // A CONSULTATION-BOUND run resolves nothing: identity is fixed at `open` and read from the
    // row (`Consultation.doctorId`), so a field arriving here is ordinary content and is IGNORED
    // rather than re-decided per run. Two answers for one consultation is the failure OD-5 rules
    // out; `subject` above is untouched on that lane.
    //
    // Placed HERE — after the reserved-key gate and the definition lookup, before the claim-check
    // mint and `recordRunStarted` — so a refusal from the resolver (400/404/409) leaves no
    // half-started run row behind and nothing billed.
    const actingUserId = consultationBound ? null : await this.resolveTriggerUserIdentity(definition.compiledConfig, tenantId, dto.input);

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
    // The per-run config. A trigger the author bound to the tenant's PIN is re-resolved here,
    // immediately before dispatch, so a schema version published since this workflow shipped is
    // what the run is validated against — the same rewrite the consultation dispatcher performs,
    // through the same pure helper, because one plane honouring "follow latest" and the other
    // ignoring it would be a difference no caller could see until a run failed.
    const effective = this.effectiveTriggerSchema
      ? await this.effectiveTriggerSchema.resolve(tenantId, definition.compiledConfig, definition.contextSchemaFollowsLatest)
      : { config: definition.compiledConfig };
    const configRef = await mintCompiledConfigClaimCheckRef(effective.config, bucket, (b, key, data, contentType) =>
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
      // TASK-950 (decision 2, fast win) — the DURABLE half of standalone-run attribution. The
      // `ResourceCreated` event below already carries `actingUserId`, but an audit row is not
      // queryable beside the run it describes; `_metadata->>'actingUserId'` on this row is.
      //
      // OMITTED rather than `{ actingUserId: null }`, because `actingUserId` is null for three
      // different reasons (human caller · consultation-bound run · schema declares no identity
      // field) and none of them is a fact about this run worth storing. An absent key is the one
      // honest spelling of all three.
      //
      // TASK-1038 B3a — a CONSULTATION-BOUND run also stamps the server-resolved consultation id
      // (`subject.consultationId`, from the request PATH — never `input`): the internal
      // consultation-read route admits an exposure-plane run only when its row names the
      // consultation it was bound to.
      //
      // TASK-1038 E2 (fix 11) — an `Idempotency-Key` start also stamps its body fingerprint, the
      // DURABLE half of "a different body under the same key is a 409".
      //
      // TASK-1038 OD-35 — and the principal that started it (`startedBy`), which every
      // business-plane read of the run is bound to.
      metaData:
        actingUserId || subject?.consultationId || requestBodyHash || startedBy
          ? {
              ...(actingUserId ? { actingUserId } : {}),
              ...(subject?.consultationId ? { consultationId: subject.consultationId } : {}),
              ...(requestBodyHash ? { requestBodyHash } : {}),
              ...(startedBy ? { startedBy } : {}),
            }
          : undefined,
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

    const serviceAccount = this.requestServiceAccount;
    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: definition.id,
      data: {
        action: 'invoke',
        runId,
        slug: definition.slug,
        workflowVersionNumber: definition.versionNumber,
        // TASK-950 — a SERVICE ACCOUNT used to be recorded as `'user'` here, which is the one
        // principal class this plane cannot have: `requestUserId` is null for a machine, so the
        // event named a person who was never in the request. The three classes are mutually
        // exclusive (a key is bound to a human, a service-account token carries no human), so the
        // order below is a readability choice, not a precedence rule.
        principalType: opts.apiKeyId ? 'apiKey' : serviceAccount ? 'serviceAccount' : 'user',
        apiKeyId: opts.apiKeyId ?? null,
        serviceAccountId: serviceAccount?.id ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
        // Attributable by construction: which consultation this run may write to, as the SERVER
        // resolved it. Never the caller's claim.
        consultationId: subject?.consultationId ?? null,
        // TASK-950 — the clinician this run acts FOR, as resolved from the trigger schema's
        // identity field. Business data beside the actor, never instead of it (D-11): the ACTOR
        // stays `responsibleServiceAccountId` on the envelope, which `BaseService` stamps.
        // `null` on a human caller, on a consultation-bound run, and whenever the schema declares
        // no identity field — three different reasons, one honest absence.
        actingUserId,
      },
    });

    const response = WorkflowExposureDtoMapper.toInvokeResponse(runId, definition.slug, started.status);

    if (idempotencyRedisKey && requestBodyHash) {
      await this.tryWriteIdempotencyCache(idempotencyRedisKey, response, requestBodyHash);
    }

    return response;
  }

  async getRunStatus(slug: string, runId: string): Promise<WorkflowRunStatusResponse> {
    const tenantId = this.requireTenantId();
    const run = await this.resolveReadableRun(tenantId, slug, runId);

    let upstream: GetWorkflowRunResult;
    // TASK-1036 (lane B6b) — the v2 terminal event carries no node counts; when the row has none
    // (no completion watcher recorded them) the harness's settled stages are the source.
    let derived: SettledNodeCounts | undefined;
    try {
      upstream = await this.harnessGateway.getWorkflowRun(runId);
      if (run.nodeCount == null && terminalStatusOf(upstream.status) !== null) derived = settledNodeCountsFromStages(upstream.stages);
      await this.syncTerminalStatus(tenantId, run, upstream, derived);
    } catch (err) {
      // TASK-1038 — the harness keeps a run only as long as Temporal does; once it has no record
      // (404) the durable read model is the answer, not a failed status read. Any OTHER failure
      // still propagates: "the harness is down" must never read as "the run is in this state".
      if (!isHarnessNotFound(err)) throw err;
      upstream = { runId: run.runId, status: run.status, stages: [], startedAt: run.startedAt ?? null, endedAt: run.endedAt ?? null };
    }

    // TASK-982 (E6) — the SAME fold `WorkflowRunCompletionService.recordTerminal` applies, so the
    // live surface and the persisted row say the same thing for the same run: RUNNING/DEGRADED/
    // SUCCEEDED/CANCELLED never reach the caller as-is. A non-terminal upstream status (RUNNING,
    // or an interpreter-internal stage label) folds to `null` and falls back to `RUNNING`.
    const status = terminalStatusOf(upstream.status) ?? 'RUNNING';

    return WorkflowExposureDtoMapper.toStatusResponse(
      run.workflowSlug,
      run.workflowVersionNumber,
      upstream,
      run.resultRef ?? null,
      run.actingUserId ?? null,
      status,
      run.nodeCount ?? derived?.nodeCount ?? null,
      derived?.failedNodeCount ?? run.failedNodeCount ?? null,
      run.degradedNodeCount ?? derived?.degradedNodeCount ?? null,
      run.skippedNodeCount ?? derived?.skippedNodeCount ?? null,
    );
  }

  async getRunResult(slug: string, runId: string): Promise<WorkflowRunResult> {
    const tenantId = this.requireTenantId();
    let run = await this.resolveReadableRun(tenantId, slug, runId);

    // The read model can lag the run by one missed completion event: ask the live status (which
    // reconciles the row) before refusing, then re-read the row for the result it now carries.
    if (terminalStatusOf(run.status) === null) {
      const live = await this.getRunStatus(slug, runId);
      if (terminalStatusOf(live.status) === null) {
        throw new ConflictException({
          code: RUN_NOT_TERMINAL,
          message: `Run '${runId}' has not finished yet; its result is available once it is terminal.`,
          status: live.status,
        });
      }
      run = await this.resolveReadableRun(tenantId, slug, runId);
    }
    const status = terminalStatusOf(run.status) ?? run.status;
    const stored = readPersistedRunResult(run.resultRef);

    // The delivered output is clinical content: every read is an audited PHI access.
    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: run.workflowVersionId,
      forceAuditLog: true,
      data: { action: 'readResult', runId, slug: run.workflowSlug, kind: stored?.kind ?? 'none' },
    });

    if (stored === null) return { runId, status, kind: 'none' };
    if (stored.kind === 'inline') return { runId, status, kind: 'inline', value: stored.value };
    if (stored.kind === 'expired') return { runId, status, kind: 'expired', expiredAt: stored.expiredAt };

    // TASK-1038 E2 (fix 13) — sign only an object under the run tenant's prefix. A key outside it
    // (another tenant's, a shared content-addressed key, a legacy un-prefixed key) is not provably
    // this tenant's: the house 404, and nothing is signed.
    // `tenantId` is the run's own tenant: `resolveOwnedRun` read the row under it.
    if (!isResultKeyInTenantPrefix(tenantId, stored.key)) {
      throw new NotFoundException(`Run '${runId}' has no readable result.`);
    }
    if (!this.blobStorage) {
      throw new ServiceUnavailableException('This run delivered a stored result, but no object storage is configured to sign a download URL for it.');
    }
    const ttlSeconds = this.resultUrlTtlSeconds();
    const issuedAt = Date.now();
    const url = await this.blobStorage.presignGet({ bucket: stored.bucket, key: stored.key, expiresInSeconds: ttlSeconds });
    return {
      runId,
      status,
      kind: 'ref',
      url,
      expiresAt: new Date(issuedAt + ttlSeconds * 1000).toISOString(),
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
    };
  }

  private resultUrlTtlSeconds(): number {
    try {
      const value = this.tenantSettings?.resolvePlatform<number>(WORKFLOW_RUNS_RESULT_URL_TTL_SECONDS_KEY).value;
      return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : WORKFLOW_RUNS_DEFAULTS.resultUrlTtlSeconds;
    } catch {
      return WORKFLOW_RUNS_DEFAULTS.resultUrlTtlSeconds;
    }
  }

  async cancelRun(slug: string, runId: string): Promise<WorkflowRunCancelResponse> {
    const tenantId = this.requireTenantId();
    const run = await this.resolveReadableRun(tenantId, slug, runId);

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

    // UNSCOPED by construction (black-box J6). This route is `@Public()`, so there is no CLS
    // tenant — and `WorkflowWebhookSecret` is a tenant-scoped model, so the ordinary
    // `findById` does not merely miss, it THROWS `TenantScope: tenant context required` and
    // every signed delivery was refused ~1 ms in, before the HMAC was ever compared. The row
    // being read is the only thing that can name the tenant, so it cannot also be filtered by
    // one; possession of the secret, verified below, is what authenticates the caller.
    const row = await this.webhookSecretRepository!.findByHookIdUnscoped(hookId).catch(() => null);
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

  async getReview(slug: string, runId: string, nodeId: string): Promise<WorkflowReviewResponse> {
    this.assertExposureEnabled();
    const tenantId = this.requireTenantId();
    // Ownership FIRST, and through the same lookup `getRunStatus` uses: a foreign run, or one
    // whose lineage is not this slug's, must be indistinguishable from a run that never existed
    // — and must never reach the interpreter, which authenticates as the platform and would
    // happily answer for anyone's run.
    await this.resolveOwnedRun(tenantId, slug, runId);

    // Deliberately NOT wrapped in try/catch. `exists: false` is the interpreter's own answer for
    // "no live child"; a transport failure or a 503 is a different fact and stays one (the
    // gateway's `ExceptionInterceptor` maps an uncaught downstream error to 503 + Retry-After).
    const state = await this.harnessGateway.getWorkflowRunReview(runId, nodeId, tenantId);

    return {
      runId: state.runId ?? runId,
      nodeId: state.nodeId ?? nodeId,
      exists: state.exists === true,
      phase: state.phase ?? null,
      escalations: state.escalations ?? null,
      decided: state.decided === true,
      // `null`, never `'approved'`: the review workflow's whole invariant is that a timeout
      // never approves, and a default here would reintroduce exactly that.
      decision: state.decision === 'approved' || state.decision === 'rejected' ? state.decision : null,
    };
  }

  async decideReview(slug: string, runId: string, nodeId: string, dto: ReviewDecisionRequest): Promise<WorkflowReviewDecisionResponse> {
    this.assertExposureEnabled();
    const tenantId = this.requireTenantId();
    const run = await this.resolveOwnedRun(tenantId, slug, runId);

    // The acting user, from CLS. `dto` is a class-validator DTO with no `reviewerId` field, so
    // the global pipe (`forbidNonWhitelisted`) has already refused a body that carried one —
    // this line is what makes that refusal safe to rely on rather than merely tidy.
    const reviewerId = this.requestUserId ?? null;

    const result = await this.harnessGateway.decideWorkflowRunReview(
      runId,
      nodeId,
      { decision: dto.decision, reviewerId: reviewerId ?? undefined, comment: dto.comment, editedPayload: dto.editedPayload },
      tenantId,
    );

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: run.workflowVersionId,
      data: { action: 'decideReview', slug, runId, nodeId, decision: dto.decision, reviewerId },
    });

    return { runId, nodeId, decision: dto.decision, signaled: result?.signaled === true, reviewerId };
  }

  async describe(slug: string): Promise<WorkflowSchemaDescription> {
    this.assertExposureEnabled();
    const tenantId = this.requireTenantId();
    const definition = await this.workflowDefinitionRepository.findPublishedBySlug(tenantId, slug);
    if (!definition || exposureBoundaryViolation(definition, {}) !== null) {
      throw new NotFoundException(`Workflow '${slug}' not found.`);
    }
    return describeWorkflow(
      definition.slug,
      definition.versionNumber,
      graphOf(definition.graph),
      definition.compiledConfig,
      await this.contextSchemaBindingOf(definition),
    );
  }

  /**
   * The published context-schema binding, for the description's `contextSchema` block.
   *
   * Reads the COLUMNS publish stamped, never the compiled JSON — they are the same answer, and
   * the columns are the ones an index can be built on. Only the slug needs a row read, and it
   * degrades to `null` rather than failing the description: a schema row that has since been
   * deleted must not make an existing workflow undescribable.
   */
  private async contextSchemaBindingOf(definition: {
    tenantId: string;
    contextSchemaId?: string | null;
    contextSchemaVersionNumber?: number | null;
    contextSchemaFollowsLatest?: boolean | null;
  }): Promise<WorkflowContextSchemaBinding | null> {
    const schemaId = definition.contextSchemaId;
    if (!schemaId) return null;

    const schema = (await this.contextSchemaRepository?.findById(schemaId).catch(() => null)) ?? null;
    return {
      schemaId,
      slug: schema && schema.tenantId === definition.tenantId ? schema.slug : null,
      versionNumber: definition.contextSchemaVersionNumber ?? null,
      followsLatest: definition.contextSchemaFollowsLatest === true,
    };
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

  /** The exposure plane's gate. The surface's existence is not disclosed while
   *  gated (404, same posture as `registration.selfSignupEnabled`). */
  private assertExposureEnabled(): void {
    if (!this.isExposureEnabled()) {
      throw new NotFoundException('Not found.');
    }
  }

  /**
   * TASK-932 D-4 — resolved through the tenant → SYSTEM cascade, per call.
   *
   * It used to be one `process.env` read, which made "turn the public plane off
   * for THAT tenant" impossible and "turn it off at all" a redeploy. Every call
   * site here already stands inside a tenant context (`requireTenantId`), so the
   * cascade has the tenant it needs; a webhook or a tenant-less internal path
   * resolves the platform lane, which is the same answer the env read gave.
   *
   * With the settings graph unwired (a minimal fixture, a CLI) it degrades to the
   * pre-TASK-932 env read rather than to the descriptor default: a fixture that
   * pinned the flag must keep meaning what it said.
   */
  private isExposureEnabled(): boolean {
    if (!this.tenantSettings) {
      return this.configService.getConfigValue('WORKFLOW_EXPOSURE_ENABLED') === true;
    }
    return this.tenantSettings.resolve<boolean>(WORKFLOW_EXPOSURE_ENABLED_KEY, this.tenantId ?? null).value === true;
  }

  /**
   * TASK-950 §C5 — the trigger schema's user-identity field for a STANDALONE machine run, or
   * `null` because there is nothing to resolve (human caller / no marker / no value supplied).
   *
   * `dto.input` on this plane is the ENVELOPE the interpreter validates (`payload.<kindKey>` is
   * what a trigger's `context_binding` resolves against), so the value is read at
   * `input[kindKey][field]` and there is no flat-payload variant to consider — unlike the agent
   * invocation route, whose J3-5 rule admits both shapes.
   *
   * ## What this deliberately does NOT do
   *
   * It does not put the resolved user on the run's `subject`. `StartWorkflowRunSubject` requires
   * `consultationId` (`consultation/harness/harness-gateway.service.ts:244-248`), and so does the
   * dispatcher's own `RunSubject` (`apps/harness/src/harness/temporal/interpreter/models.py:174`,
   * `extra="forbid"`) — a subject carrying only `userId` is a 422 from the harness, which would
   * break every standalone run rather than attribute one. Carrying the clinician INTO an unbound
   * run therefore needs both of those to admit a consultation-less subject; until they do, the
   * resolution's effects are the durable ones — the user exists, is reusable by staff id, and the
   * `ResourceCreated` event names it as `actingUserId`.
   *
   * Every refusal from the resolver (400 `USER_IDENTITY_INVALID` /
   * `USER_IDENTITY_DEPARTMENT_UNRESOLVED`, 404 `USER_IDENTITY_UNKNOWN` /
   * `USER_IDENTITY_NOT_USABLE`, 409 `USER_IDENTITY_AMBIGUOUS`, 409 seat quota) propagates verbatim.
   */
  private async resolveTriggerUserIdentity(
    compiledConfig: unknown,
    tenantId: string,
    input: Record<string, unknown> | undefined,
  ): Promise<string | null> {
    const serviceAccount = this.requestServiceAccount;
    // D-5 — a human caller (or an API key bound to one) already IS the clinician.
    if (!serviceAccount) return null;

    const binding = triggerUserIdentityBinding(compiledConfig);
    if (binding === null) return null;

    const staffId = extractUserIdentityValue(input, binding);
    if (staffId === undefined) return null;

    if (!this.userIdentity) {
      throw new ServiceUnavailableException({
        message: 'This workflow binds a context schema that declares a user-identity field, but the identity resolver is not configured.',
        code: 'USER_IDENTITY_RESOLVER_UNAVAILABLE',
      });
    }

    const { userId } = await this.userIdentity.resolveOrProvision({
      tenantId,
      staffId,
      // D-9/OD-8 — an unbound run names no department, so the resolver falls to the tenant
      // `identity.autoProvision.departmentId` setting and fails closed when that is unset too.
      departmentId: null,
      provenance: {
        plane: 'workflow-run',
        kindKey: binding.kindKey,
        field: binding.field,
        serviceAccountId: serviceAccount.id,
      },
    });
    return userId;
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
  private async tryJoinExistingRun(tenantId: string, slug: string, runId: string, requestBodyHash: string): Promise<WorkflowInvokeResponse | null> {
    let storedHash: string | null;
    try {
      const existing = await this.workflowRunService.getRun(tenantId, runId);
      if (existing.workflowSlug !== slug) return null;
      storedHash = await this.workflowRunService.getRunRequestBodyHash(tenantId, runId);
    } catch {
      return null;
    }
    // TASK-1038 E2 (fix 11) — a row started before fingerprints existed carries none and joins.
    if (storedHash !== null && storedHash !== requestBodyHash) throw idempotencyKeyReused();
    return WorkflowExposureDtoMapper.toInvokeResponse(runId, slug, 'already_running');
  }

  /**
   * TASK-1038 OD-35 — {@link resolveOwnedRun} plus the starting-principal binding: a run another
   * principal started answers the SAME 404 as an unknown run (`workflowRunNotFound`), unless the
   * reader is tenant-wide (`RunPrincipalAccessService`). Used by every business-plane run read
   * (status — and through it the SSE stream, the socket and the stream-ticket mint — result,
   * cancel). Reviews stay tenant-scoped: a reviewer is routinely not the run's starter.
   */
  private async resolveReadableRun(tenantId: string, slug: string, runId: string): Promise<WorkflowRunResponse> {
    if (!this.runAccess) return this.resolveOwnedRun(tenantId, slug, runId);
    const { run, startedBy } = await this.workflowRunService.getRunForReader(tenantId, runId);
    // The lineage check keeps its own (pre-existing) answer; the principal check answers exactly
    // what an unknown id answers.
    if (run.workflowSlug !== slug) {
      throw new NotFoundException(`Run '${runId}' not found for workflow '${slug}'.`);
    }
    if (!(await this.runAccess.canRead('workflow', startedBy))) throw workflowRunNotFound(runId);
    return run;
  }

  /** Cross-tenant `runId`, or a `runId` whose lineage does not belong to `slug` -> 404 (never 403). */
  private async resolveOwnedRun(tenantId: string, slug: string, runId: string): Promise<WorkflowRunResponse> {
    const run = await this.workflowRunService.getRun(tenantId, runId);
    if (run.workflowSlug !== slug) {
      throw new NotFoundException(`Run '${runId}' not found for workflow '${slug}'.`);
    }
    return run;
  }

  private async syncTerminalStatus(
    tenantId: string,
    run: WorkflowRunResponse,
    upstream: GetWorkflowRunResult,
    counts?: SettledNodeCounts,
  ): Promise<void> {
    // TASK-982 — fold FIRST, then check membership: `upstream.status` is the interpreter's raw
    // vocabulary (SUCCEEDED/DEGRADED/CANCELLED/…), not the read model's, so comparing it directly
    // against `TERMINAL_RUN_STATUSES` missed every SUCCEEDED/DEGRADED/CANCELLED run.
    const status = terminalStatusOf(upstream.status);
    if (!status || !TERMINAL_RUN_STATUSES.has(status)) return;
    // TASK-1038 D-I — a harness status read that carries the delivered result (the producer's
    // shape, validated) persists it too; one that does not leaves `resultRef` alone.
    const result = deliveredRunResultFrom(upstream as unknown as Record<string, unknown>);
    try {
      await this.workflowRunService.recordRunFinished({
        tenantId,
        sessionId: run.sessionId,
        runId: run.runId,
        status,
        endedAt: upstream.endedAt ? new Date(upstream.endedAt) : undefined,
        ...(result ? { resultRef: result as unknown as Record<string, unknown> } : {}),
        ...(counts ?? {}),
      });
    } catch {
      // Best-effort read-model sync — the live upstream status is still returned to the caller
      // regardless of whether the read-model row could be updated.
    }
  }

  /**
   * The Redis fast path. The record is the invoke response plus the body fingerprint
   * (`requestBodyHash`, TASK-1038 E2 fix 11), which is stripped before the response is replayed.
   * A record written before fingerprints existed has none (`requestBodyHash: undefined`).
   */
  private async tryReadIdempotencyCache(key: string): Promise<{ response: WorkflowInvokeResponse; requestBodyHash: string | undefined } | null> {
    if (!this.redisCache) return null;
    try {
      const cached = await this.redisCache.get(key);
      if (!cached) return null;
      const { requestBodyHash, ...response } = JSON.parse(cached) as WorkflowInvokeResponse & { requestBodyHash?: unknown };
      return { response: response as WorkflowInvokeResponse, requestBodyHash: typeof requestBodyHash === 'string' ? requestBodyHash : undefined };
    } catch {
      return null; // best-effort — a lookup failure falls through to a normal (fresh) invoke
    }
  }

  private async tryWriteIdempotencyCache(key: string, response: WorkflowInvokeResponse, requestBodyHash: string): Promise<void> {
    if (!this.redisCache) return;
    try {
      await this.redisCache.setex(key, IDEMPOTENCY_TTL_SECONDS, JSON.stringify({ ...response, requestBodyHash }));
    } catch {
      // A record failure means a retry within the TTL may start a second run — logged upstream
      // by the cache service itself; never a reason to fail the invoke that already succeeded.
    }
  }
}

/**
 * TASK-1038 E2 (fix 11) — the fingerprint of a workflow start under an `Idempotency-Key`: the
 * caller's `input` (key order irrelevant) and the consultation the run is bound to.
 */
function workflowInvokeBodyHash(dto: InvokeWorkflowRequest, consultationId: string | undefined): string {
  return createHash('sha256')
    .update(idempotencyCanonicalJson({ input: dto?.input ?? {}, consultationId: consultationId ?? null }), 'utf8')
    .digest('hex');
}

/** The 409 for a key reused with a different body — the agent-run shape; it never names the other request's run. */
function idempotencyKeyReused(): ConflictException {
  return new ConflictException({
    code: 'IDEMPOTENCY_KEY_REUSED',
    message: 'This Idempotency-Key already started a run with a different request body. Use a new key for a new request.',
  });
}

/** An axios-style "the harness answered 404" — the harness has no record of the run. */
function isHarnessNotFound(err: unknown): boolean {
  const status = (err as { response?: { status?: unknown } } | null)?.response?.status;
  return status === 404 || err instanceof NotFoundException;
}

/** The graph's one mandatory entry node — the same string `compiledTriggerContextSchema` matches. */
const TRIGGER_NODE_TYPE = 'core.trigger';

function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * TASK-950 (D-3) — the user-identity marker FROZEN onto the compiled `core.trigger` node, or
 * `null`.
 *
 * Structurally identical to `compiledTriggerContextSchema` in `@arcaai/workflow-contract`
 * (`core-contract.ts`), and deliberately reading the same address: the marker sits BESIDE
 * `contextSchema.resolved`, so both facts about the trigger's schema are found the same way and
 * neither depends on a database read at invoke time (TASK-890 invariant 4).
 *
 * A malformed marker reads as ABSENT rather than raising — the publish gate is what refuses a bad
 * one, and an artifact compiled before the marker existed simply carries nothing here.
 */
function triggerUserIdentityBinding(compiledConfig: unknown): UserIdentityBinding | null {
  const stages = asPlainObject(compiledConfig)?.stages;
  if (!Array.isArray(stages)) return null;
  for (const stage of stages) {
    const nodes = asPlainObject(stage)?.nodes;
    if (!Array.isArray(nodes)) continue;
    for (const node of nodes) {
      const compiled = asPlainObject(node);
      if (compiled?.type !== TRIGGER_NODE_TYPE) continue;
      const marker = asPlainObject(asPlainObject(compiled.config)?.contextSchema)?.userIdentity;
      const shape = asPlainObject(marker);
      if (shape === undefined) return null;
      const { kindKey, field } = shape as { kindKey?: unknown; field?: unknown };
      if (typeof kindKey !== 'string' || kindKey.length === 0) return null;
      if (typeof field !== 'string' || field.length === 0) return null;
      return { kindKey, field };
    }
  }
  return null;
}
