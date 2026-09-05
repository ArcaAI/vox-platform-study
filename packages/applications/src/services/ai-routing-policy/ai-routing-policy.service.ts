import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ArgumentInvalidException, OptimisticConcurrencyException } from '@arcaai/exceptions';
import {
  AiExplicitProviderMode,
  AiModelRepository,
  AiProviderConnectionRepository,
  AiRoutingPolicyEntity,
  AiRoutingPolicyEntityMapper,
  AiRoutingPolicyFactory,
  AiRoutingPolicyRepository,
  AiRoutingPolicyStatus,
  CoreDatabaseService,
  CoreUnitOfWorkService,
  JsonValue,
  ResourceStatusType,
  ResourceType,
  SYSTEM_TENANT_ID,
  SysEventType,
} from '@arcaai/domains';
import { BaseService } from '../../common';
import { isSuperAdmin } from '../../common/tenant-guards';
import { IActiveUserContext } from '../../interfaces';
import { AI_TASK_KEYS, AI_TASK_KIND_BY_TASK_KEY } from './constants';
import { IProviderConnectionService, ProviderService } from '../ai-provider-connection/IProviderConnectionService';
import {
  GenerationCapabilitySelector,
  IAiRoutingPolicyService,
  ResolveDefaultOptions,
  ResolveRoutingOptions,
  ResolvedGenerationCapabilities,
  ResolvedTaskDefault,
} from './IAiRoutingPolicyService';
import { AiRoutingPolicyDtoMapper } from './ai-routing-policy.dto.mapper';
import { TaskSelectionVetoedError } from './task-selection-veto';
import { AiRoutingPolicyResponse, CreateAiRoutingPolicyRequest, EffectiveRoutingPolicyResponse, UpdateAiRoutingPolicyRequest } from './dto';
import { FundedCandidate, RoutingHopRejection, evaluateHop } from './routing-gates';
import {
  RoutingCandidate,
  RoutingFallbackContract,
  matchSpecificity,
  matchesRequest,
  parseCandidates,
  parseFallback,
  parseMatch,
} from './routing-policy.contract';
import {
  ConfigurationRefs,
  EXPORT_NOTICE,
  ExportedProviderConfiguration,
  ProviderConfigurationExport,
  ProviderConfigurationRow,
  assertNoSecretMaterial,
  rowToCandidate,
  toExportedConfiguration,
} from './provider-configuration';

/**
 * The capability discriminator a routing candidate's `connectionRef` resolves
 * under. This plane routes LLM traffic (`taskKey` is `text.*`), and `llm` is
 * the `AiProviderConnection.service` value for that capability — a DOMAIN fact
 * fixed by the connection model's own key, not a tunable. The provider name,
 * endpoint, region, model and credential all still come from configuration.
 */
const ROUTING_CONNECTION_SERVICE: ProviderService = 'llm';

/**
 * Is this row SERVABLE? The two ways an administrator parks a configuration —
 * soft-disabling the record (`resourceStatus`) and clearing the candidate's own
 * `enabled` switch — mean the same thing to a resolver, so they are asked once,
 * here, rather than re-spelled at each call site.
 *
 * It mirrors `AiRoutingPolicyRepository.findCandidates`' default WHERE clause on
 * purpose: `resolveDefault` reads with `includeParked` and re-applies the filter
 * in memory, so the two must agree on what "live" means or the veto would fire
 * on rows the database would have served.
 */
function isLiveRow(row: AiRoutingPolicyEntity): boolean {
  return row.resourceStatus === ResourceStatusType.ENABLED && row.enabled === true;
}

/** Machine-readable refusals a caller can branch on */
const REJECTION = {
  providerUnavailable: 'provider_unavailable',
  providerNotInPolicy: 'provider_not_in_policy',
  noPolicy: 'no_policy',
  killSwitchEngaged: 'kill_switch_engaged',
  noEligibleCandidate: 'no_eligible_candidate',
} as const;

/**
 * Provider ROUTING POLICY service
 *
 * ## Resolution is tenant → SYSTEM, and there is no third tier
 *
 * `getEffective` reads the request tenant's ACTIVE policies and widens to the
 * reserved SYSTEM tenant (`00000000-…`) ONLY when the tenant has authored
 * none. `50000000-…` ("Global") is a CUSTOMER tenant — the platform-admin
 * playground for trialling config before promoting it into SYSTEM — and it
 * never appears in the cascade. A resolver that fell back to it would serve one
 * customer's routing configuration, and therefore one customer's vendor choice
 * for PHI, to every other tenant.
 *
 * Two independent things enforce that here:
 *   1. the widening set this service builds is literally `[requestTenant,
 *      SYSTEM_TENANT_ID]` — there is no code path that adds a third id; and
 *   2. `AiRoutingPolicy` is a SYSTEM-shared READ model, so on the extended
 *      client the tenant-scope extension itself pins `tenantId IN [caller,
 *      SYSTEM]` and THROWS on any other pinned value.
 *
 * ## Writes are super-admin-only, imperatively
 *
 * The permission decorators express `action + subject` and cannot express
 * "super admins only", so the controller carries `@CanManage('AiRoutingPolicy')`
 * to keep the deny-by-default boot audit green and the real boundary is
 * enforced here — a `ForbiddenException` (403), because this is a PRIVILEGE
 * rule on a resource the caller is otherwise addressing legitimately, not the
 * 404-over-403 cross-tenant posture. A cross-tenant ID still returns 404.
 * Same shape as `AiTaskDefaultService`'s `SUPER_ADMIN_ONLY_TASK_PREFIXES` gate.
 *
 * ## Funding is derived, never stamped
 *
 * Which tier supplied a candidate's credential decides `BYOK` vs `CLOUD`, and
 * that answer comes from `IProviderConnectionService.resolveConnection` — the
 * one cascade that already knows it (`row.tenantId === SYSTEM_TENANT_ID`).
 * This service maps its `'tenant' | 'system'` source onto the wire
 * labels and does not re-derive it.
 */
@Injectable()
export class AiRoutingPolicyService extends BaseService implements IAiRoutingPolicyService {
  constructor(
    private readonly aiRoutingPolicyRepository: AiRoutingPolicyRepository,
    // the two FKs that replaced F-6's string joins are read back
    // through their own repositories. Both reads are by PRIMARY KEY, so neither
    // re-implements a cascade; the tenant → SYSTEM cascade stays in exactly one
    // place per plane (`readCandidateRows` here, `resolveConnection` there).
    private readonly aiProviderConnectionRepository: AiProviderConnectionRepository,
    private readonly aiModelRepository: AiModelRepository,
    @Inject(IProviderConnectionService) private readonly providerConnectionService: IProviderConnectionService,
    // The UNSCOPED base client backs the super-admin cross-tenant lane only —
    // never a tenant-facing read. Mirrors `AiTaskDefaultService`.
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    // The DOMAINS `CoreUnitOfWorkService`, not the identically named unwired
    // class under `services/baseServices`. REQUIRED, not optional: the default
    // election unsets the incumbent and sets the successor, and degrading
    // silently to a non-transactional pair would leave a fail-closed selection
    // with NO default in the window between them.
    private readonly unitOfWork: CoreUnitOfWorkService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.AiRoutingPolicy);
  }

  // ──────────────────────────────── reads ────────────────────────────────

  async list(tenantId: string, taskKey?: string): Promise<AiRoutingPolicyResponse[]> {
    this.assertSuperAdmin('list routing policies');
    const filters: Record<string, unknown> = { tenantId };
    if (taskKey !== undefined) {
      this.assertKnownTaskKey(taskKey);
      filters.taskKey = taskKey;
    }
    const rows = await this.readPolicies([tenantId], filters);
    return rows
      .sort((a, b) => (a.taskKey === b.taskKey ? b.policyVersion - a.policyVersion : a.taskKey.localeCompare(b.taskKey)))
      .map((row) => AiRoutingPolicyDtoMapper.toResponse(row));
  }

  async getById(id: string, tenantId: string): Promise<AiRoutingPolicyResponse> {
    this.assertSuperAdmin('read a routing policy');
    return AiRoutingPolicyDtoMapper.toResponse(await this.loadOwnedRow(id, tenantId));
  }

  /**
   * TASK-862 — see the interface. The SAME tier rule as `getEffective` steps
   * 1-3b (tenant on presence, SYSTEM on absence, `isDefault` outranks
   * ordering) without the match predicate, the funding derivation or the
   * fallback chain: a non-agent consumer (guardrail, NER defaults, the harness
   * judge, embeddings) asks "which one", not "in what order".
   *
   * Not behind the super-admin gate: a tenant resolving what serves ITSELF is
   * ordinary runtime work; the controllers that let one tenant address
   * another already gate that (`resolveScopedTenantId`).
   */
  async resolveDefault(tenantId: string, taskKey: string, options: ResolveDefaultOptions = {}): Promise<ResolvedTaskDefault> {
    this.assertKnownTaskKey(taskKey);
    const tenantIds = options.systemOnly
      ? [SYSTEM_TENANT_ID]
      : options.noWiden || tenantId === SYSTEM_TENANT_ID
        ? [tenantId]
        : [tenantId, SYSTEM_TENANT_ID];
    // TASK-872 — read PARKED rows too, so the three states stay distinguishable
    // (see `isLiveRow` and `assertNotVetoed`). Rows that are not live are
    // filtered out immediately below; nothing parked can ever be SELECTED here.
    const rows = await this.readCandidateRows(tenantIds, taskKey, { includeParked: true });
    const liveRows = rows.filter((row) => isLiveRow(row));
    const tenantRows = tenantId === SYSTEM_TENANT_ID ? [] : liveRows.filter((row) => row.tenantId === tenantId);
    const systemRows = liveRows.filter((row) => row.tenantId === SYSTEM_TENANT_ID);

    // THE VETO. An EMPTY live tenant tier has two very different causes, and
    // before this they were indistinguishable: the tenant never configured the
    // task (absence ⇒ widen), or it configured the task and then switched its
    // own election OFF (a veto ⇒ refuse). Only the parked ELECTED row separates
    // them, which is why the read above had to see it.
    if (tenantId !== SYSTEM_TENANT_ID && !options.systemOnly && tenantRows.length === 0) {
      const vetoed = rows.some((row) => row.tenantId === tenantId && row.isDefault && !isLiveRow(row));
      if (vetoed) throw new TaskSelectionVetoedError(tenantId, taskKey);
    }

    const tier = tenantRows.length > 0 ? tenantRows : systemRows;
    const source: ResolvedTaskDefault['source'] = tenantRows.length > 0 ? 'tenant' : systemRows.length > 0 ? 'system' : null;
    const policy = tier.find((row) => row.isDefault) ?? tier[0] ?? null;

    // The FK names the catalogue row; a model the caller may not read, or one
    // that is not ENABLED, is "no model" — the caller fails closed on null,
    // exactly as it did on an unresolvable `AiTaskDefault.modelSlug`.
    const model = policy?.modelId ? await this.aiModelRepository.findById(policy.modelId).catch(() => null) : null;
    return { tenantId, taskKey, source, policy, model: model && model.resourceStatus === ResourceStatusType.ENABLED ? model : null };
  }

  /**
   * The resolution the router consumes.
   *
   * Order of operations, each step observable in the response:
   *   1. read `[tenant, SYSTEM]` ACTIVE policies for the task;
   *   2. pick the winning TIER — tenant on presence, SYSTEM only on absence;
   *   3. within that tier pick the most-specific `match`, ties by `priority`
   *      then by authored `policyVersion`;
   * 4. honour an explicitly named provider under 's STRICT ruling;
   *   5. derive each candidate's funding from its connection row;
   *   6. run the three hard gates on every hop and bound the chain by
   *      `fallback.maxDepth`.
   */
  async getEffective(tenantId: string, taskKey: string, options: ResolveRoutingOptions = {}): Promise<EffectiveRoutingPolicyResponse> {
    this.assertKnownTaskKey(taskKey);
    // Resolution is the RUNTIME path — a tenant resolving what serves ITSELF is
    // ordinary work, so this is deliberately not behind the unconditional
    // super-admin gate the writes carry. Resolving for ANOTHER tenant is not
    // ordinary: it is a platform-governance read, and it needs the privilege.
    if (tenantId !== this.tenantId) {
      this.assertSuperAdmin(`resolve routing for tenant '${tenantId}'`);
    }

    // STEP 1-2 — the two-tier cascade. `readCandidateRows` is handed exactly
    // two ids and can never be handed a third.
    const rows = await this.readCandidateRows([tenantId, SYSTEM_TENANT_ID], taskKey);
    const tenantRows = tenantId === SYSTEM_TENANT_ID ? [] : rows.filter((row) => row.tenantId === tenantId);
    const systemRows = rows.filter((row) => row.tenantId === SYSTEM_TENANT_ID);
    // A tenant with ANY live configuration for this task has expressed an
    // opinion, so SYSTEM is not consulted — widening happens on ABSENCE, never
    // on a miss inside a tier the tenant does own.
    const tier = tenantRows.length > 0 ? tenantRows : systemRows;
    const source = tenantRows.length > 0 ? 'tenant' : systemRows.length > 0 ? 'system' : null;

    // STEP 3 — per-ROW match. At the grain each row carries its own
    // `matchJson`, so a narrowing predicate drops that CANDIDATE rather than
    // the whole policy. Order: most-specific first, then `priority` ASC (lower
    // serves first), then the newest authored revision.
    const admitted = tier
      .map((row) => ({ row, specificity: matchSpecificity(parseMatch(row.matchJson)) }))
      .filter((entry) => matchesRequest(parseMatch(entry.row.matchJson), options))
      .sort((a, b) => b.specificity - a.specificity || a.row.priority - b.row.priority || b.row.policyVersion - a.row.policyVersion)
      .map((entry) => entry.row);

    if (admitted.length === 0 || !source) {
      return this.emptyResolution(tenantId, taskKey, source, {
        code: REJECTION.noPolicy,
        message: `No ACTIVE routing configuration matches task '${taskKey}' for this tenant or the platform default.`,
        retryable: false,
      });
    }

    // STEP 3b — THE ELECTION. `isDefault` outranks ordering: it is the row an
    // administrator deliberately elected, and the partial unique index
    // guarantees at most one of them per (tenant, taskKey). Only when the
    // elected default did not survive the match predicate does the ordering
    // decide, which is the same "most specific wins" rule as before.
    const winner = admitted.find((row) => row.isDefault) ?? admitted[0];

    const base = this.baseResolution(tenantId, taskKey, source, winner);
    if (winner.killSwitch) {
      return {
        ...base,
        rejection: {
          code: REJECTION.killSwitchEngaged,
          message: `Routing configuration '${winner.id}' (revision ${winner.policyVersion}) has its kill switch engaged; it serves nothing.`,
          retryable: false,
        },
      };
    }

    // The primary is anchored FIRST so every hop is measured against what
    // actually serves, then the remaining rows follow in their admitted order.
    const ordered = [winner, ...admitted.filter((row) => row.id !== winner.id)];
    const contract = parseFallback(winner.fallbackJson);
    const unhealthy = new Set(options.unhealthyProviders ?? []);
    const rejected: { candidate: RoutingCandidate; reason: RoutingHopRejection }[] = [];

    // STEP 5 — derive funding once per row, from the connection row its FK
    // names. Never stamped: `resolveConnection` is the one cascade that knows
    // AiProviderConnection's three states, so the DISABLED veto still applies
    // in both tiers and BYOK-vs-CLOUD still comes from which tier answered.
    const funded = await Promise.all(ordered.map((row, index) => this.fundRow(row, tenantId, index)));

    // STEP 4 — an explicitly named provider.
    if (options.explicitProvider) {
      return this.resolveExplicit(base, winner, funded, contract, options, unhealthy);
    }

    const primaryIndex = funded.findIndex((entry) => this.isServable(entry, unhealthy, rejected));
    if (primaryIndex < 0) {
      return {
        ...base,
        rejectedCandidates: rejected.map((r) => AiRoutingPolicyDtoMapper.toRejectedCandidate(r.candidate, r.reason)),
        rejection: {
          code: REJECTION.noEligibleCandidate,
          message: `No candidate for task '${taskKey}' can serve: every configuration was refused (see rejectedCandidates).`,
          // Every remaining reason is either a health ejection (recoverable) or
          // an unresolvable connection (a configuration fix). Neither is a gate
          // crossing, so a retry is not categorically pointless.
          retryable: true,
        },
      };
    }

    const primary = funded[primaryIndex];
    // STEP 6 — gate every hop against the primary, bounded by maxDepth.
    const chain = this.buildFallbackChain(primary, funded.slice(primaryIndex + 1), contract, unhealthy, rejected);

    return {
      ...base,
      primary: AiRoutingPolicyDtoMapper.toResolvedCandidate(primary, 0),
      fallbackChain: chain.map((entry, index) => AiRoutingPolicyDtoMapper.toResolvedCandidate(entry, index + 1)),
      rejectedCandidates: rejected.map((r) => AiRoutingPolicyDtoMapper.toRejectedCandidate(r.candidate, r.reason)),
      relaxedGates: this.relaxedGates(contract),
      rejection: null,
    };
  }

  /**
   * finding F-32 — what GENERATION hyper-parameters the configuration a workflow node
   * binds to actually accepts.
   *
   * Answers the authoring-time question the workflow publish gate asks: *"this node tunes
   * `presencePenalty` — will that reach anything?"* The answer is a property of the RESOLVED
   * configuration, so it is derived here, in the plane that owns the cascade, rather than
   * re-derived by the caller. A second copy of a two-tier cascade is the failure mode
   * `resolveContextSchemaVersionId` names: *"a second, silently-diverging copy of a resolution
   * the platform already has one answer for."*
   *
   * ## Both `providerConfigRef` shapes, each through the resolution that already exists
   *
   * | Selector | Path |
   * |---|---|
   * | `routingPolicyId` | the pinned row, read on the `[tenant, SYSTEM]` lane — a tenant graph may legitimately pin the platform default |
   * | `taskKey` | `getEffective`, whose election (tier, match, `isDefault`) is the runtime's own |
   *
   * Either way the winning row's `modelId` FK names the `AiModel` whose `_metadata` carries the
   * declaration. `50000000-…` ("Global") cannot enter either path: `readCandidateRows` is handed
   * exactly `[tenantId, SYSTEM_TENANT_ID]`, and the pinned read goes through the same two ids.
   *
   * ## Never throws, and `undefined` params is a real answer
   *
   * A capability question must not be the thing that fails a publish. Every miss — no row, a
   * killed row, no `modelId`, a model the caller cannot read, a row that declares nothing —
   * resolves to `supportedGenerationParams: undefined`, which the contract reads as UNKNOWN and
   * reports as a WARNING. That is deliberate and is not the `failMode: closed` rule being
   * relaxed: SELECTION still fails closed at runtime. These are tuning knobs, and refusing every
   * graph bound to an unprofiled configuration would block the platform on data entry.
   */
  async resolveGenerationCapabilities(tenantId: string, selector: GenerationCapabilitySelector): Promise<ResolvedGenerationCapabilities> {
    const row = await this.resolveConfigurationRow(tenantId, selector).catch(() => null);
    if (!row) {
      // Name what the AUTHOR wrote. A problem that cannot be traced back to the field that
      // caused it is a problem the author cannot act on.
      const unresolved = selector.routingPolicyId ? `routingPolicyId '${selector.routingPolicyId}'` : `taskKey '${selector.taskKey ?? ''}'`;
      return { label: unresolved, supportedGenerationParams: undefined };
    }

    const label = row.displayName ?? `${row.taskKey} (revision ${row.policyVersion})`;
    if (!row.modelId) return { label, supportedGenerationParams: undefined };

    // Mirrors `resolveRefs`: the un-laned read goes through the tenant-scope extension, which
    // pins `tenantId IN [caller, SYSTEM]` itself — so a SYSTEM-owned model stays readable and
    // another customer's does not.
    const model = await this.aiModelRepository.findById(row.modelId).catch(() => null);
    if (!model) return { label, supportedGenerationParams: undefined };

    const declared = (model.metaData as Record<string, unknown> | null | undefined)?.supportedGenerationParams;
    const named = model.slug ? `${label} → ${model.slug}` : label;
    if (!Array.isArray(declared)) return { label: named, supportedGenerationParams: undefined };

    return { label: named, supportedGenerationParams: declared.filter((entry): entry is string => typeof entry === 'string') };
  }

  /** The winning `AiRoutingPolicy` row for a node's `providerConfigRef`, or `null`. */
  private async resolveConfigurationRow(tenantId: string, selector: GenerationCapabilitySelector): Promise<AiRoutingPolicyEntity | null> {
    if (selector.routingPolicyId) {
      return this.readPinnedRow(tenantId, selector.routingPolicyId);
    }
    if (!selector.taskKey || !AI_TASK_KEYS.includes(selector.taskKey as (typeof AI_TASK_KEYS)[number])) return null;

    const effective = await this.getEffective(tenantId, selector.taskKey);
    return effective.policyId ? this.readPinnedRow(tenantId, effective.policyId) : null;
  }

  /**
   * One row BY ID, admissible only if it belongs to the request tenant or to SYSTEM.
   *
   * A pinned id may legitimately name the tenant's OWN row or the SYSTEM default it inherited —
   * `PROVIDER_CONFIG_REF_PROPERTY`'s doc comment contemplates both. Nothing else is reachable, and
   * the ownership test is made HERE rather than left to the tenant-scope extension: `loadOwnedRow`
   * asserts `row.tenantId` for the same reason. An extension is a backstop, not the statement of
   * intent, and a guarantee that lives only in a `$extends` hook is one no test of this method can
   * see. A foreign row answers `null` — the capability set is then UNKNOWN, which is the
   * 404-over-403 posture expressed in the only currency this method has.
   */
  private async readPinnedRow(tenantId: string, id: string): Promise<AiRoutingPolicyEntity | null> {
    const rows = await this.readPolicies([tenantId, SYSTEM_TENANT_ID], { id });
    const row = rows[0];
    if (!row || (row.tenantId !== tenantId && row.tenantId !== SYSTEM_TENANT_ID)) return null;
    return row;
  }

  // ─────────────────────────────── writes ────────────────────────────────

  async create(tenantId: string, dto: CreateAiRoutingPolicyRequest): Promise<AiRoutingPolicyResponse> {
    this.assertSuperAdmin('author a routing policy');
    this.assertKnownTaskKey(dto.taskKey);
    // a configuration must name a model. `candidates` is still
    // accepted for a pre-844 chain revision, and validated the old way when it
    // is the only thing supplied, so an existing caller is not broken.
    this.assertBindingUsable(dto);

    const existing = await this.readPolicies([tenantId], { tenantId, taskKey: dto.taskKey });
    const nextVersion = dto.policyVersion ?? existing.reduce((max, row) => Math.max(max, row.policyVersion), 0) + 1;
    if (existing.some((row) => row.policyVersion === nextVersion)) {
      throw new ArgumentInvalidException(
        `Routing policy revision ${nextVersion} already exists for task '${dto.taskKey}' on this tenant. Revisions are supersede-only — author the next one.`,
      );
    }

    const entity = AiRoutingPolicyFactory.CreateAiRoutingPolicy({
      tenantId,
      taskKey: dto.taskKey,
      // DERIVED, never taken from the request: the mapping is
      // `AI_TASK_KIND_BY_TASK_KEY`, and letting a caller assert a kind that
      // disagrees with its own task key is how the two axes drift apart.
      taskKind: AI_TASK_KIND_BY_TASK_KEY[dto.taskKey as keyof typeof AI_TASK_KIND_BY_TASK_KEY] ?? null,
      displayName: dto.displayName ?? null,
      providerConnectionId: dto.providerConnectionId ?? null,
      modelId: dto.modelId ?? null,
      modelRef: dto.modelRef ?? null,
      // A create never elects. Election is `setDefault`, which unseats the
      // incumbent in one transaction; allowing it here would make every create
      // race the partial unique index.
      isDefault: false,
      enabled: dto.enabled ?? true,
      residency: dto.residency ?? null,
      baaCovered: dto.baaCovered ?? null,
      configJson: (dto.configJson ?? null) as JsonValue,
      candidatesJson: (dto.candidates ?? null) as JsonValue,
      policyVersion: nextVersion,
      // A new revision is always a DRAFT — see CreateAiRoutingPolicyRequest.
      status: AiRoutingPolicyStatus.DRAFT,
      strategy: dto.strategy,
      explicitProviderMode: dto.explicitProviderMode,
      priority: dto.priority,
      killSwitch: dto.killSwitch,
      matchJson: (dto.match ?? null) as JsonValue,
      fallbackJson: (dto.fallback ?? null) as JsonValue,
      healthJson: (dto.health ?? null) as JsonValue,
      affinityJson: (dto.affinity ?? null) as JsonValue,
      maxConcurrentStreams: dto.maxConcurrentStreams ?? null,
      requestsPerMinute: dto.requestsPerMinute ?? null,
      tokensPerMinute: dto.tokensPerMinute ?? null,
      createdBy: this.requestUserId ?? undefined,
    });

    const saved = await this.aiRoutingPolicyRepository.create(entity, this.crossTenantLane(tenantId));
    // a routing-policy change can redirect PHI to a different vendor,
    // so HIPAA audit controls apply. `before` is null on a create;
    // `after` is the full authored revision.
    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: {
        taskKey: saved.taskKey,
        policyTenantId: saved.tenantId,
        policyVersion: saved.policyVersion,
        status: saved.status,
        before: null,
        after: AiRoutingPolicyDtoMapper.toResponse(saved),
      },
    });
    return AiRoutingPolicyDtoMapper.toResponse(saved);
  }

  async update(id: string, tenantId: string, dto: UpdateAiRoutingPolicyRequest): Promise<AiRoutingPolicyResponse> {
    this.assertSuperAdmin('change a routing policy');
    const existing = await this.loadOwnedRow(id, tenantId);
    const before = AiRoutingPolicyDtoMapper.toResponse(existing);

    const changes = this.buildUpdateChanges(existing, dto);
    await this.updateEntity(existing, changes);
    // RFC 7232 evaluates preconditions independently of the payload, so a
    // stale client must see 412 even when its body would change nothing.
    this.assertExpectedVersion(existing, dto.expectedVersion);
    if (dto.expectedVersion === undefined) {
      // A compare-and-set with no token cannot be verified. `@RequiresIfMatch()`
      // 428s at the HTTP layer before this, so reaching here means a non-HTTP
      // caller skipped the precondition — surface it as a concurrency error
      // rather than writing unguarded (the `AiTaskDefaultService` precedent).
      throw new OptimisticConcurrencyException(String(ResourceType.AiRoutingPolicy), existing.id, {
        expectedVersion: dto.expectedVersion,
        currentVersion: existing.version,
      });
    }

    const previousVersion = existing.version;
    const updated = await this.aiRoutingPolicyRepository.updateWithVersion(
      existing.id,
      existing,
      dto.expectedVersion,
      this.crossTenantLane(tenantId),
    );
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: {
        taskKey: updated.taskKey,
        policyTenantId: updated.tenantId,
        policyVersion: updated.policyVersion,
        previousVersion,
        newVersion: updated.version,
        before,
        after: AiRoutingPolicyDtoMapper.toResponse(updated),
      },
    });
    return AiRoutingPolicyDtoMapper.toResponse(updated);
  }

  async activate(id: string, tenantId: string, expectedVersion?: number): Promise<AiRoutingPolicyResponse> {
    this.assertSuperAdmin('activate a routing policy');
    const draft = await this.loadOwnedRow(id, tenantId);
    if (draft.status !== AiRoutingPolicyStatus.DRAFT) {
      throw new ArgumentInvalidException(`Routing policy '${id}' is ${draft.status}; only a DRAFT revision can be activated.`);
    }
    // a revision is activatable when it names something to route TO.
    // Before the re-grain this asserted the `candidatesJson` chain; at this
    // grain the row IS the candidate, so the binding is what must be present.
    this.assertBindingUsable({ modelId: draft.modelId, modelRef: draft.modelRef, candidates: draft.candidatesJson ?? undefined });
    const before = AiRoutingPolicyDtoMapper.toResponse(draft);

    const tx = this.crossTenantLane(tenantId);
    // The revision being superseded: the newest ACTIVE one for the same
    // (tenant, taskKey). It is ARCHIVED, never deleted — requires the
    // previous version to stay addressable for a one-click rollback.
    const superseded = (await this.readPolicies([tenantId], { tenantId, taskKey: draft.taskKey, status: AiRoutingPolicyStatus.ACTIVE })).sort(
      (a, b) => b.policyVersion - a.policyVersion,
    )[0];

    if (superseded) {
      superseded.status = AiRoutingPolicyStatus.ARCHIVED;
      if (this.requestUserId) superseded.updatedBy = this.requestUserId;
      const archived = await this.aiRoutingPolicyRepository.updateWithVersion(superseded.id, superseded, superseded.version, tx);
      this.broadcastSysEvent(SysEventType.ResourceUpdated, {
        resourceId: archived.id,
        data: {
          taskKey: archived.taskKey,
          policyTenantId: archived.tenantId,
          policyVersion: archived.policyVersion,
          reason: 'superseded',
          supersededBy: draft.policyVersion,
          before: AiRoutingPolicyDtoMapper.toResponse(superseded),
          after: AiRoutingPolicyDtoMapper.toResponse(archived),
        },
      });
    }

    draft.status = AiRoutingPolicyStatus.ACTIVE;
    draft.activatedAt = new Date();
    draft.supersedesVersion = superseded?.policyVersion ?? null;
    if (this.requestUserId) draft.updatedBy = this.requestUserId;
    const activated = await this.aiRoutingPolicyRepository.updateWithVersion(draft.id, draft, expectedVersion ?? before.version, tx);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: activated.id,
      data: {
        taskKey: activated.taskKey,
        policyTenantId: activated.tenantId,
        policyVersion: activated.policyVersion,
        reason: 'activated',
        supersedesVersion: activated.supersedesVersion,
        previousVersion: before.version,
        newVersion: activated.version,
        before,
        after: AiRoutingPolicyDtoMapper.toResponse(activated),
      },
    });
    return AiRoutingPolicyDtoMapper.toResponse(activated);
  }

  /**
   * ELECT a configuration as the default for its `(tenant, taskKey)`.
   *
   * ## Why this is one call and not two
   *
   * The product rule is "exactly one default per task; setting a second must be
   * refused, or must atomically unset the first". A caller who had to unset the
   * incumbent and then set the successor would leave the selection with NO
   * default in between — and selection is `failMode: closed`, so that window is
   * an outage, not a degraded state. Worse, if their second write failed they
   * would have to know to roll back.
   *
   * So the unset and the set happen in ONE transaction, and the partial unique
   * index `AiRoutingPolicy_tenant_task_default_unique` is what makes that
   * correct rather than merely tidy: the constraint is evaluated inside the
   * transaction, so two administrators electing different rows at the same
   * moment cannot both win — one commits and the other is refused by the
   * database. A service-level guard alone is exactly the pattern that produced
   * finding F-7.
   *
   * Re-electing the row that is ALREADY the default is a no-op that still
   * returns 200: this is an idempotent administrative assertion ("make this the
   * default"), not a toggle.
   */
  async setDefault(id: string, tenantId: string, expectedVersion?: number): Promise<AiRoutingPolicyResponse> {
    this.assertSuperAdmin('elect a default routing configuration');
    const row = await this.loadOwnedRow(id, tenantId);
    const before = AiRoutingPolicyDtoMapper.toResponse(row);

    if (row.resourceStatus === ResourceStatusType.DELETED) {
      throw new BadRequestException(`Routing configuration '${id}' is deleted and cannot be elected as the default.`);
    }
    // Electing a candidate that is switched off would make the selection
    // resolve to a row the resolver then skips — a default that defaults to
    // nothing. Refuse it rather than let it look configured.
    if (!row.enabled) {
      throw new BadRequestException(
        `Routing configuration '${id}' is disabled and cannot be elected as the default for '${row.taskKey}'. Enable it first.`,
      );
    }

    const result = await this.unitOfWork.runInTransaction(async (tx) => {
      // Order matters: clear FIRST, then set. The reverse order would have two
      // rows carrying `isDefault = true` at the moment the index is checked.
      const unseated = await this.aiRoutingPolicyRepository.clearDefaultFor(row.tenantId, row.taskKey, row.id, tx, this.requestUserId ?? undefined);

      if (row.isDefault) {
        // Already the default. The clear above removed any stray sibling; there
        // is nothing left to write, so do not bump `_version` for a no-op.
        return { entity: row, unseated };
      }

      row.isDefault = true;
      if (this.requestUserId) row.updatedBy = this.requestUserId;
      const saved = await this.aiRoutingPolicyRepository.updateWithVersion(row.id, row, expectedVersion ?? row.version, tx);
      return { entity: saved, unseated };
    });

    // a routing change can redirect PHI to a different vendor, so
    // HIPAA audit controls apply. The event names how many rows
    // were unseated so the audit trail records the whole election, not just the
    // winner.
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: result.entity.id,
      data: {
        taskKey: result.entity.taskKey,
        policyTenantId: result.entity.tenantId,
        reason: 'default_elected',
        unseatedCount: result.unseated,
        before,
        after: AiRoutingPolicyDtoMapper.toResponse(result.entity),
      },
    });
    return AiRoutingPolicyDtoMapper.toResponse(result.entity);
  }

  /**
   * PROMOTE a configuration from one tenant to another.
   *
   * ## Secrets are never copied, and that is the whole design
   *
   * A provider configuration names a credential; it does not contain one. The
   * copy carries the model binding, the ordering, the residency label and the
   * BAA assertion — everything that describes HOW to route — and points
   * `providerConnectionId` at the TARGET tenant's own connection for the same
   * `(service, provider)`, resolved through the standard cascade. If the target
   * has no such connection, the copy lands with a NULL connection and the
   * operator must supply one; it never inherits the source tenant's row, because
   * that row holds the source tenant's key and billing.
   *
   * ## It always lands NOT-default
   *
   * Promotion is a "here is a configuration you may use" act, not "switch your
   * traffic to this now". Landing it elected would silently unseat whatever the
   * target tenant had chosen, on an operation they did not perform. The operator
   * elects it explicitly afterwards through {@link setDefault}.
   *
   * The actor must administer BOTH tenants; on this plane every write is
   * already super-admin-gated, which satisfies that by construction.
   */
  async promote(id: string, sourceTenantId: string, targetTenantId: string): Promise<AiRoutingPolicyResponse> {
    this.assertSuperAdmin('promote a routing configuration to another tenant');
    if (sourceTenantId === targetTenantId) {
      throw new ArgumentInvalidException('Source and target tenant must differ — a configuration cannot be promoted onto itself.');
    }
    const source = await this.loadOwnedRow(id, sourceTenantId);

    const existing = await this.readPolicies([targetTenantId], { tenantId: targetTenantId, taskKey: source.taskKey });
    const nextVersion = existing.reduce((max, row) => Math.max(max, row.policyVersion), 0) + 1;

    // Re-point the connection at the TARGET tenant's own row for the same
    // (service, provider). `resolveConnection` runs the tenant → SYSTEM cascade,
    // so a target with no opinion legitimately inherits the SYSTEM platform
    // connection — which is the platform default working as designed, not a
    // cross-tenant leak.
    const refs = await this.resolveRefs(source);
    let providerConnectionId: string | null = null;
    if (refs.connectionProvider && refs.connectionService) {
      const targetRow = await this.providerConnectionService
        .findRow(refs.connectionService as ProviderService, refs.connectionProvider, targetTenantId)
        .catch(() => null);
      providerConnectionId = targetRow?.id ?? null;
    }

    const entity = AiRoutingPolicyFactory.CreateAiRoutingPolicy({
      tenantId: targetTenantId,
      taskKey: source.taskKey,
      taskKind: source.taskKind ?? AI_TASK_KIND_BY_TASK_KEY[source.taskKey as keyof typeof AI_TASK_KIND_BY_TASK_KEY] ?? null,
      displayName: source.displayName,
      providerConnectionId,
      // The catalogue is shared through the same two-tier cascade, so a SYSTEM
      // model id is meaningful to every tenant and carries across unchanged.
      modelId: source.modelId,
      modelRef: source.modelRef,
      // NEVER elected on arrival — see the method comment.
      isDefault: false,
      enabled: source.enabled,
      residency: source.residency,
      baaCovered: source.baaCovered,
      configJson: source.configJson,
      priority: source.priority,
      policyVersion: nextVersion,
      status: AiRoutingPolicyStatus.DRAFT,
      strategy: source.strategy,
      explicitProviderMode: source.explicitProviderMode,
      matchJson: source.matchJson,
      fallbackJson: source.fallbackJson,
      healthJson: source.healthJson,
      affinityJson: source.affinityJson,
      maxConcurrentStreams: source.maxConcurrentStreams,
      requestsPerMinute: source.requestsPerMinute,
      tokensPerMinute: source.tokensPerMinute,
      createdBy: this.requestUserId ?? undefined,
    });

    const saved = await this.aiRoutingPolicyRepository.create(entity, this.crossTenantLane(targetTenantId));
    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: {
        taskKey: saved.taskKey,
        policyTenantId: saved.tenantId,
        reason: 'promoted',
        promotedFrom: { tenantId: sourceTenantId, id: source.id },
        // Stated in the audit record so the absence is a documented fact rather
        // than something a reader has to infer from a missing field.
        credentialCopied: false,
        before: null,
        after: AiRoutingPolicyDtoMapper.toResponse(saved),
      },
    });
    return AiRoutingPolicyDtoMapper.toResponse(saved);
  }

  /**
   * EXPORT selected configurations as a portable, secret-free JSON
   * artifact.
   *
   * The artifact is built by `toExportedConfiguration` and then re-checked by
   * `assertNoSecretMaterial`, which walks the FINISHED structure for anything
   * resembling credential material. That belt-and-braces is deliberate: the
   * builder is the part most likely to gain a field in a hurry, and a structural
   * assertion catches that where a review of the builder would not.
   *
   * See `provider-configuration.ts` for why the artifact carries a
   * `credentialRef` LOCATOR and no characters of any key — including why it does
   * not emit a "last 4".
   */
  async exportConfigurations(tenantId: string, taskKeys?: string[]): Promise<ProviderConfigurationExport> {
    this.assertSuperAdmin('export routing configurations');
    (taskKeys ?? []).forEach((key) => this.assertKnownTaskKey(key));

    const filters: Record<string, unknown> = { tenantId };
    if (taskKeys && taskKeys.length > 0) filters.taskKey = { in: taskKeys };
    const rows = await this.readPolicies([tenantId], filters);

    const configurations: ExportedProviderConfiguration[] = [];
    for (const row of rows) {
      const refs = await this.resolveRefs(row);
      let hasKey = false;
      let keyVersion: number | null = null;
      if (row.providerConnectionId) {
        const connection = await this.aiProviderConnectionRepository.findById(row.providerConnectionId).catch(() => null);
        // `encryptedApiKey` is READ here only to answer "is there one", and its
        // value never leaves this expression.
        hasKey = Boolean(connection?.encryptedApiKey);
        keyVersion = connection?.keyVersion ?? null;
      }
      configurations.push(toExportedConfiguration(row as unknown as ProviderConfigurationRow, refs, { hasKey, keyVersion }));
    }

    const artifact: ProviderConfigurationExport = {
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      sourceTenantId: tenantId,
      secretsIncluded: false,
      notice: EXPORT_NOTICE,
      configurations,
    };
    assertNoSecretMaterial(artifact);
    return artifact;
  }

  /**
   * IMPORT configurations from an artifact produced by
   * {@link exportConfigurations}.
   *
   * ## An import can never restore a credential
   *
   * The artifact carries none, so every imported configuration binds to the
   * TARGET tenant's own connection for the named `(service, provider)`, resolved
   * through the standard cascade. Where the source had a credential and the
   * target has no connection at all, the row still lands — with a NULL
   * connection and its `credentialRef` reported back in `requiresCredential`, so
   * the operator is told exactly which secrets to supply rather than discovering
   * it as a 503 later.
   *
   * ## Imported rows land as DRAFT and NOT default
   *
   * Same reasoning as promotion: an import describes configurations, it does not
   * authorise a traffic switch. Nothing an import does can unseat a default the
   * target tenant already elected.
   */
  async importConfigurations(
    tenantId: string,
    artifact: ProviderConfigurationExport,
  ): Promise<{ imported: number; skipped: number; requiresCredential: string[] }> {
    this.assertSuperAdmin('import routing configurations');
    if (artifact?.formatVersion !== 1 || !Array.isArray(artifact.configurations)) {
      throw new ArgumentInvalidException('Unrecognised provider-configuration artifact: expected `formatVersion: 1` and a `configurations` array.');
    }

    let imported = 0;
    let skipped = 0;
    const requiresCredential: string[] = [];

    const existing = await this.readPolicies([tenantId], { tenantId });
    let nextVersion = existing.reduce((max, row) => Math.max(max, row.policyVersion), 0) + 1;

    for (const entry of artifact.configurations) {
      this.assertKnownTaskKey(entry.taskKey);

      // The model is named by SLUG because that is the identity that is portable
      // across tenants; the id is not. A slug that resolves to nothing in the
      // target is a skip, never a guess — selection is fail-closed, and a
      // configuration bound to the wrong model is worse than one that is absent.
      const model = entry.modelSlug ? await this.resolveModelBySlugForTenant(entry.modelSlug, tenantId) : null;
      if (!model && !entry.modelRef) {
        skipped += 1;
        continue;
      }

      let providerConnectionId: string | null = null;
      if (entry.connection) {
        const targetRow = await this.providerConnectionService
          .findRow(entry.connection.service as ProviderService, entry.connection.provider, tenantId)
          .catch(() => null);
        providerConnectionId = targetRow?.id ?? null;
      }
      if (entry.hasCredential && !providerConnectionId && entry.credentialRef) {
        requiresCredential.push(entry.credentialRef);
      }

      const created = AiRoutingPolicyFactory.CreateAiRoutingPolicy({
        tenantId,
        taskKey: entry.taskKey,
        taskKind: AI_TASK_KIND_BY_TASK_KEY[entry.taskKey as keyof typeof AI_TASK_KIND_BY_TASK_KEY] ?? null,
        displayName: entry.displayName,
        providerConnectionId,
        modelId: model?.id ?? null,
        modelRef: entry.modelRef,
        isDefault: false,
        enabled: entry.enabled,
        residency: entry.residency,
        baaCovered: entry.baaCovered,
        priority: entry.priority,
        policyVersion: nextVersion,
        status: AiRoutingPolicyStatus.DRAFT,
        createdBy: this.requestUserId ?? undefined,
      });
      nextVersion += 1;

      const saved = await this.aiRoutingPolicyRepository.create(created, this.crossTenantLane(tenantId));
      imported += 1;
      this.broadcastSysEvent(SysEventType.ResourceCreated, {
        resourceId: saved.id,
        createdAt: saved.createdAt,
        data: {
          taskKey: saved.taskKey,
          policyTenantId: saved.tenantId,
          reason: 'imported',
          credentialCopied: false,
          before: null,
          after: AiRoutingPolicyDtoMapper.toResponse(saved),
        },
      });
    }

    return { imported, skipped, requiresCredential };
  }

  async deleteById(id: string, tenantId: string): Promise<AiRoutingPolicyResponse> {
    this.assertSuperAdmin('delete a routing policy');
    const existing = await this.loadOwnedRow(id, tenantId);
    const before = AiRoutingPolicyDtoMapper.toResponse(existing);
    const deleted = await this.aiRoutingPolicyRepository.softDelete(id, this.requestUserId ?? undefined, this.crossTenantLane(tenantId));
    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: deleted.id,
      data: {
        taskKey: deleted.taskKey,
        policyTenantId: deleted.tenantId,
        policyVersion: deleted.policyVersion,
        before,
        after: AiRoutingPolicyDtoMapper.toResponse(deleted),
      },
    });
    return AiRoutingPolicyDtoMapper.toResponse(deleted);
  }

  // ───────────────────────────── resolution ──────────────────────────────

  /**
   * Read the ORDERED CANDIDATE CHAIN for one selection across an EXPLICIT set
   * of tenant ids.
   *
   * The ids are always exactly `[requestTenant, SYSTEM]` — built at the one call
   * site in `getEffective`, never assembled here — which is the first of the two
   * guarantees that the Global customer tenant `50000000-…` cannot enter the
   * cascade. The second is the tenant-scope extension on the non-lane path,
   * which pins `tenantId IN [caller, SYSTEM]` itself and throws on any other
   * pinned value.
   *
   * ACTIVE + ENABLED + `enabled = true` only: a DRAFT revision has not been
   * promoted, a soft-deleted row is gone, and a parked candidate is one an
   * administrator switched off without destroying.
   */
  private async readCandidateRows(tenantIds: string[], taskKey: string, options: { includeParked?: boolean } = {}): Promise<AiRoutingPolicyEntity[]> {
    const tx = this.crossTenantReadLane(tenantIds);
    return this.aiRoutingPolicyRepository.findCandidates(tenantIds, taskKey, tx, options);
  }

  /**
   * Derive one ROW's funding tier from the connection its FK names.
   *
   * Two lookups, on purpose. The FK gives the exact connection ROW, but funding
   * and the DISABLED veto are decided by `resolveConnection`, which is the only
   * place that implements AiProviderConnection's three states (no row = no
   * opinion so the platform default applies; enabled + keyed = the tenant wins;
   * disabled = a VETO in BOTH tiers). Deriving funding straight off
   * `connection.tenantId` would get the BYOK/CLOUD answer right and silently
   * lose the veto — so the FK is used to learn WHICH provider, and the cascade
   * is still asked WHO PAYS.
   *
   * `null` funding means no tier serves it, which the gates treat as
   * `CONNECTION_UNRESOLVED` (fail-closed).
   */
  private async fundRow(row: AiRoutingPolicyEntity, tenantId: string, rank: number): Promise<FundedCandidate> {
    const refs = await this.resolveRefs(row);
    const candidate = rowToCandidate(row as unknown as ProviderConfigurationRow, refs, rank);

    // A configuration served by no provider connection at all — an in-process
    // `apps/nlp` model, for instance — is not "unfunded", it is not vendor-paid.
    // It resolves as platform-funded so a selection that never had a connection
    // keeps working exactly as it did through `AiTaskDefault`.
    if (!row.providerConnectionId) {
      return { candidate, funding: row.tenantId === SYSTEM_TENANT_ID ? 'CLOUD' : 'BYOK' };
    }
    if (!refs.connectionProvider) {
      // The FK named a connection this caller cannot read. Never admit a hop
      // because its check was unavailable.
      return { candidate, funding: null };
    }

    try {
      const service = (refs.connectionService as ProviderService | null) ?? ROUTING_CONNECTION_SERVICE;
      const resolved = await this.providerConnectionService.resolveConnection(service, refs.connectionProvider, tenantId);
      if (!resolved) return { candidate, funding: null };
      // 'tenant' = the tenant's own BYO row paid; 'system' = the platform
      // default did. These are the wire labels for the same two facts.
      return { candidate, funding: resolved.source === 'system' ? 'CLOUD' : 'BYOK' };
    } catch {
      return { candidate, funding: null };
    }
  }

  /**
   * Turn a row's two FKs into the NAMES the rest of the plane speaks in — the
   * connection's `(service, provider)` and the model's `slug`.
   *
   * Both reads are best-effort and independently nullable. A dangling FK cannot
   * happen (`ON DELETE RESTRICT`), but a row a caller may not READ can — and the
   * honest answer there is "unresolved", which fails closed one layer up, not an
   * exception that would take down an unrelated candidate's resolution.
   */
  private async resolveRefs(row: AiRoutingPolicyEntity): Promise<ConfigurationRefs> {
    const refs: ConfigurationRefs = {};
    if (row.providerConnectionId) {
      const connection = await this.aiProviderConnectionRepository.findById(row.providerConnectionId).catch(() => null);
      refs.connectionProvider = connection?.provider ?? null;
      refs.connectionService = connection?.service ?? null;
    }
    if (row.modelId) {
      const model = await this.aiModelRepository.findById(row.modelId).catch(() => null);
      refs.modelSlug = model?.slug ?? null;
    }
    return refs;
  }

  /**
   * Resolve a catalogue slug on the TWO-TIER cascade — the tenant's own row
   * first, the SYSTEM catalogue only on absence.
   *
   * Identical shape to `AiTaskDefaultService.resolveEnabledModelBySlug`, and
   * deliberately so: an import must land on exactly the model the same slug
   * would select at runtime, or the imported configuration would resolve to
   * something the operator did not choose.
   */
  private async resolveModelBySlugForTenant(slug: string, tenantId: string): Promise<{ id: string } | null> {
    if (tenantId !== SYSTEM_TENANT_ID) {
      const own = await this.aiModelRepository.findBySlug(tenantId, slug).catch(() => null);
      if (own) return own;
    }
    return this.aiModelRepository.findBySlug(SYSTEM_TENANT_ID, slug).catch(() => null);
  }

  /** Servable = credential resolves AND the router has not ejected it. */
  private isServable(
    entry: FundedCandidate,
    unhealthy: Set<string>,
    rejected: { candidate: RoutingCandidate; reason: RoutingHopRejection }[],
  ): boolean {
    if (entry.funding === null) {
      rejected.push({ candidate: entry.candidate, reason: RoutingHopRejection.ConnectionUnresolved });
      return false;
    }
    if (unhealthy.has(entry.candidate.connectionRef)) {
      rejected.push({ candidate: entry.candidate, reason: RoutingHopRejection.ProviderUnhealthy });
      return false;
    }
    return true;
  }

  /**
   * The three hard gates, applied to every hop against the primary and
   * bounded by `fallback.maxDepth`. A refused hop is recorded with its reason
   * and the walk CONTINUES — a later candidate may still be legal — but the
   * depth cap counts only ADMITTED hops, so a chain can never exceed it.
   */
  private buildFallbackChain(
    primary: FundedCandidate,
    rest: FundedCandidate[],
    contract: RoutingFallbackContract,
    unhealthy: Set<string>,
    rejected: { candidate: RoutingCandidate; reason: RoutingHopRejection }[],
  ): FundedCandidate[] {
    const chain: FundedCandidate[] = [];
    for (const hop of rest) {
      if (chain.length >= contract.maxDepth) {
        rejected.push({ candidate: hop.candidate, reason: RoutingHopRejection.FallbackDepthExceeded });
        continue;
      }
      if (unhealthy.has(hop.candidate.connectionRef)) {
        rejected.push({ candidate: hop.candidate, reason: RoutingHopRejection.ProviderUnhealthy });
        continue;
      }
      const refusal = evaluateHop(primary, hop, contract);
      if (refusal) {
        rejected.push({ candidate: hop.candidate, reason: refusal });
        continue;
      }
      chain.push(hop);
    }
    return chain;
  }

  /**
   * an explicitly named provider.
   *
   * `STRICT` (the platform default) closes the chain outright: the named
   * provider serves or the request is refused with `provider_unavailable`.
   * `STRICT_UNLESS_OPTED_IN` opens it only on a per-request `allowFallbacks`,
   * and even then the three hard gates still bound every hop.
   * `POLICY_MAY_OVERRIDE` lets the policy chain apply as normal.
   *
   * The named provider is anchored as the PRIMARY in every mode, so a hop is
   * always measured against what the caller asked for — not against the
   * policy's own first choice.
   */
  private resolveExplicit(
    base: EffectiveRoutingPolicyResponse,
    winner: AiRoutingPolicyEntity,
    funded: FundedCandidate[],
    contract: RoutingFallbackContract,
    options: ResolveRoutingOptions,
    unhealthy: Set<string>,
  ): EffectiveRoutingPolicyResponse {
    const named = options.explicitProvider as string;
    const rejected: { candidate: RoutingCandidate; reason: RoutingHopRejection }[] = [];
    const index = funded.findIndex((entry) => entry.candidate.connectionRef === named);
    if (index < 0) {
      return {
        ...base,
        rejection: {
          code: REJECTION.providerNotInPolicy,
          message: `Provider '${named}' is not a candidate of routing policy '${winner.id}' for task '${winner.taskKey}'.`,
          retryable: false,
        },
      };
    }

    const target = funded[index];
    if (!this.isServable(target, unhealthy, rejected)) {
      return {
        ...base,
        rejectedCandidates: rejected.map((r) => AiRoutingPolicyDtoMapper.toRejectedCandidate(r.candidate, r.reason)),
        rejection: {
          code: REJECTION.providerUnavailable,
          message:
            `Provider '${named}' was named explicitly but cannot serve. ` +
            'No substitution is made: substituting a provider a caller named would move PHI to a vendor they did not choose, and there is no ' +
            'standard header to tell them (RFC 9111 obsoleted `Warning`). Retry when the provider recovers, or opt in to fallbacks explicitly.',
          // ProviderUnhealthy recovers on its own; an unresolvable connection
          // needs a configuration change before a retry can succeed.
          retryable: rejected[0]?.reason === RoutingHopRejection.ProviderUnhealthy,
        },
      };
    }

    const mode = winner.explicitProviderMode;
    const fallbacksPermitted =
      mode === AiExplicitProviderMode.POLICY_MAY_OVERRIDE ||
      (mode === AiExplicitProviderMode.STRICT_UNLESS_OPTED_IN && options.allowFallbacks === true);

    let chain: FundedCandidate[] = [];
    if (fallbacksPermitted) {
      chain = this.buildFallbackChain(target, [...funded.slice(0, index), ...funded.slice(index + 1)], contract, unhealthy, rejected);
    } else {
      for (const other of [...funded.slice(0, index), ...funded.slice(index + 1)]) {
        rejected.push({ candidate: other.candidate, reason: RoutingHopRejection.ExplicitProviderStrict });
      }
    }

    return {
      ...base,
      primary: AiRoutingPolicyDtoMapper.toResolvedCandidate(target, 0),
      fallbackChain: chain.map((entry, step) => AiRoutingPolicyDtoMapper.toResolvedCandidate(entry, step + 1)),
      rejectedCandidates: rejected.map((r) => AiRoutingPolicyDtoMapper.toRejectedCandidate(r.candidate, r.reason)),
      relaxedGates: fallbacksPermitted ? this.relaxedGates(contract) : [],
      rejection: null,
    };
  }

  /** Which of the three gates the author explicitly turned off. Empty is the default posture. */
  private relaxedGates(contract: RoutingFallbackContract): string[] {
    const relaxed: string[] = [];
    if (!contract.requireSameResidencyClass) relaxed.push('requireSameResidencyClass');
    if (!contract.requireBaaCovered) relaxed.push('requireBaaCovered');
    if (contract.crossFundingAllowed) relaxed.push('crossFundingAllowed');
    return relaxed;
  }

  private baseResolution(tenantId: string, taskKey: string, source: string | null, winner: AiRoutingPolicyEntity): EffectiveRoutingPolicyResponse {
    return {
      tenantId,
      taskKey,
      source,
      policyId: winner.id,
      policyVersion: winner.policyVersion,
      strategy: winner.strategy,
      explicitProviderMode: winner.explicitProviderMode,
      primary: null,
      fallbackChain: [],
      rejectedCandidates: [],
      rejection: null,
      relaxedGates: [],
      health: winner.healthJson ?? null,
      maxConcurrentStreams: winner.maxConcurrentStreams ?? null,
      requestsPerMinute: winner.requestsPerMinute ?? null,
      tokensPerMinute: winner.tokensPerMinute ?? null,
    };
  }

  private emptyResolution(
    tenantId: string,
    taskKey: string,
    source: string | null,
    rejection: EffectiveRoutingPolicyResponse['rejection'],
  ): EffectiveRoutingPolicyResponse {
    return {
      tenantId,
      taskKey,
      source,
      policyId: null,
      policyVersion: null,
      strategy: null,
      explicitProviderMode: null,
      primary: null,
      fallbackChain: [],
      rejectedCandidates: [],
      rejection,
      relaxedGates: [],
      health: null,
      maxConcurrentStreams: null,
      requestsPerMinute: null,
      tokensPerMinute: null,
    };
  }

  // ────────────────────────────── internals ──────────────────────────────

  /**
   * The one privilege boundary on this plane. 403, not 404: the caller is
   * addressing a resource legitimately and the rule is "you may not do this".
   * A cross-tenant ID is a different question and still answers 404
   * ({@link loadOwnedRow}).
   */
  private assertSuperAdmin(action: string): void {
    if (!isSuperAdmin(this.requestUser)) {
      throw new ForbiddenException(`Provider routing policies are managed by super administrators only; you may not ${action}.`);
    }
  }

  private assertKnownTaskKey(taskKey: string): void {
    if (!(AI_TASK_KEYS as readonly string[]).includes(taskKey)) {
      throw new ArgumentInvalidException(`Unknown AI task key '${taskKey}'. Expected one of: ${AI_TASK_KEYS.join(', ')}`);
    }
  }

  /**
   * a configuration must name something to route TO.
   *
   * `modelId` (the catalogue FK) or `modelRef` (a provider-side id for a model
   * the catalogue does not carry) satisfies it. A pre-844 body that supplies
   * only `candidates` is still accepted and validated the old way, so the
   * re-grain does not break a caller that has not migrated.
   */
  private assertBindingUsable(dto: { modelId?: string | null; modelRef?: string | null; candidates?: unknown }): void {
    if (dto.modelId || dto.modelRef) return;
    if (dto.candidates !== undefined) {
      this.assertCandidatesUsable(dto.candidates);
      return;
    }
    throw new ArgumentInvalidException(
      'A routing configuration must name a model: supply `modelId` (an AiModel in the tenant or platform catalogue) or `modelRef` ' +
        '(the provider-side model id, e.g. an Azure deployment name).',
    );
  }

  /**
   * At least one candidate must survive parsing. `parseCandidates` DROPS an
   * entry missing `residency` or `baaCovered` rather than defaulting it, so a
   * body full of malformed candidates would otherwise persist as a policy that
   * can never route — and, worse, would look authored.
   */
  private assertCandidatesUsable(raw: unknown): void {
    if (parseCandidates(raw).length === 0) {
      throw new ArgumentInvalidException(
        'At least one usable routing candidate is required. Every candidate needs a non-empty `connectionRef`, `model` and `residency`, and a boolean ' +
          '`baaCovered` — the last two are read by the §3A.4 residency and BAA gates, so they are never defaulted on your behalf.',
      );
    }
  }

  /**
   * Load a row and prove it belongs to the scoped tenant.
   *
   * A row owned by another tenant answers 404, never 403 — the 404-over-403
   * posture: a privilege message would confirm the id exists somewhere.
   */
  private async loadOwnedRow(id: string, tenantId: string): Promise<AiRoutingPolicyEntity> {
    const rows = await this.readPolicies([tenantId], { id });
    const row = rows[0];
    if (!row || row.tenantId !== tenantId) {
      throw new NotFoundException(`Routing policy '${id}' was not found.`);
    }
    return row;
  }

  /**
   * Fields an update may touch, given the revision's lifecycle state.
   *
   * ⚠ `isDefault` is deliberately ABSENT and must stay absent. Electing a
   * default is not a field edit: it has to unset the incumbent in the SAME
   * transaction or the partial unique index rejects the write, so it lives on
   * `setDefault` where that is guaranteed. Adding it here would give callers a
   * path that fails intermittently and looks like a database bug.
   */
  private buildUpdateChanges(existing: AiRoutingPolicyEntity, dto: UpdateAiRoutingPolicyRequest): Record<string, unknown> {
    const changes: Record<string, unknown> = {};
    if (dto.killSwitch !== undefined) changes.killSwitch = dto.killSwitch;

    const semanticKeys = [
      'candidates',
      // binding fields are SEMANTIC: changing which model or which
      // connection serves is precisely the kind of edit a served revision must
      // not absorb in place, because it redirects PHI to a different vendor
      // while keeping the revision id an auditor already signed off.
      'displayName',
      'providerConnectionId',
      'modelId',
      'modelRef',
      'enabled',
      'residency',
      'baaCovered',
      'configJson',
      'strategy',
      'explicitProviderMode',
      'priority',
      'match',
      'fallback',
      'health',
      'affinity',
      'maxConcurrentStreams',
      'requestsPerMinute',
      'tokensPerMinute',
    ] as const;
    const semanticEdits = semanticKeys.filter((key) => dto[key] !== undefined);

    if (semanticEdits.length > 0 && existing.status !== AiRoutingPolicyStatus.DRAFT) {
      // a served revision is a rollback target and an audit "before".
      // Rewriting it in place destroys both.
      throw new BadRequestException(
        `Routing policy '${existing.id}' is ${existing.status}; only \`killSwitch\` may change on a revision that is not a DRAFT. ` +
          `Author a new revision and activate it (rejected fields: ${semanticEdits.join(', ')}).`,
      );
    }

    if (dto.candidates !== undefined) {
      this.assertCandidatesUsable(dto.candidates);
      changes.candidatesJson = dto.candidates as JsonValue;
    }
    if (dto.displayName !== undefined) changes.displayName = dto.displayName;
    if (dto.providerConnectionId !== undefined) changes.providerConnectionId = dto.providerConnectionId;
    if (dto.modelId !== undefined) changes.modelId = dto.modelId;
    if (dto.modelRef !== undefined) changes.modelRef = dto.modelRef;
    if (dto.enabled !== undefined) changes.enabled = dto.enabled;
    if (dto.residency !== undefined) changes.residency = dto.residency;
    if (dto.baaCovered !== undefined) changes.baaCovered = dto.baaCovered;
    if (dto.configJson !== undefined) changes.configJson = dto.configJson as JsonValue;
    if (dto.strategy !== undefined) changes.strategy = dto.strategy;
    if (dto.explicitProviderMode !== undefined) changes.explicitProviderMode = dto.explicitProviderMode;
    if (dto.priority !== undefined) changes.priority = dto.priority;
    if (dto.match !== undefined) changes.matchJson = dto.match as JsonValue;
    if (dto.fallback !== undefined) changes.fallbackJson = dto.fallback as JsonValue;
    if (dto.health !== undefined) changes.healthJson = dto.health as JsonValue;
    if (dto.affinity !== undefined) changes.affinityJson = dto.affinity as JsonValue;
    if (dto.maxConcurrentStreams !== undefined) changes.maxConcurrentStreams = dto.maxConcurrentStreams;
    if (dto.requestsPerMinute !== undefined) changes.requestsPerMinute = dto.requestsPerMinute;
    if (dto.tokensPerMinute !== undefined) changes.tokensPerMinute = dto.tokensPerMinute;
    return changes;
  }

  /**
   * The cross-tenant WRITE lane.
   *
   * A super admin's working tenant W is elevated into CLS by the BFF proxy, so
   * writing ANY other tenant's row — the SYSTEM platform default very much
   * included — through the EXTENDED client makes the tenant-scope extension
   * inject W: the create throws `TenantScope: tenantId mismatch`, and the CAS
   * `updateMany` matches 0 rows, producing an eternal 412 despite a correct
   * `If-Match`. Writes are NEVER widened by the SYSTEM-shared-read rule, so
   * `target === SYSTEM` needs the lane exactly as a foreign tenant does. When
   * the target is not the CLS tenant, route through the UNSCOPED base client so
   * the query carries ONLY the explicit tenant filters this service builds.
   * Same lane as `AiTaskDefaultService` and `HarnessPolicyService`.
   *
   * Only reachable behind {@link assertSuperAdmin} — every write asserts it.
   */
  private crossTenantLane(targetTenantId: string): CoreDatabaseService['baseClient'] | undefined {
    if (targetTenantId !== this.tenantId && isSuperAdmin(this.requestUser)) {
      return this.databaseService.baseClient;
    }
    return undefined;
  }

  /**
   * The cross-tenant READ lane.
   *
   * Reads DO widen: `AiRoutingPolicy` is a SYSTEM-shared read model, so the
   * extension already resolves `tenantId IN [caller, SYSTEM]`. The lane is
   * needed only for a target outside that pair (a super admin inspecting a
   * tenant other than their working one), or when CLS carries no tenant at all.
   */
  private crossTenantReadLane(tenantIds: string[]): CoreDatabaseService['baseClient'] | undefined {
    const cls = this.tenantId;
    const outsidePair = tenantIds.some((id) => id !== cls && id !== SYSTEM_TENANT_ID);
    if ((outsidePair || !cls) && isSuperAdmin(this.requestUser)) {
      return this.databaseService.baseClient;
    }
    return undefined;
  }

  /**
   * Read policy rows for an EXPLICIT set of tenant ids.
   *
   * `tenantIds` is `[target]` for admin CRUD and exactly `[requestTenant,
   * SYSTEM]` for resolution. There is no call site that passes anything else,
   * which is the first of the two guarantees that `50000000-…` cannot enter
   * the cascade; the second is the tenant-scope extension on the non-lane path,
   * which pins `tenantId IN [caller, SYSTEM]` itself and throws on any other
   * pinned value.
   */
  private async readPolicies(tenantIds: string[], filters: Record<string, unknown>): Promise<AiRoutingPolicyEntity[]> {
    const tx = this.crossTenantReadLane(tenantIds);
    if (tx) {
      const where = { ...filters, tenantId: tenantIds.length === 1 ? tenantIds[0] : { in: tenantIds } };
      // The unscoped client returns the PRISMA-generated row type, whose enum
      // members are structurally identical to but nominally distinct from the
      // domain model's. `AiRoutingPolicyRepository`'s own tx path casts the
      // delegate for the same reason; mirroring it keeps ONE convention.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the unscoped client's delegate map is not indexable by a model name known only at runtime
      const rows = await (tx as unknown as Record<string, any>).aiRoutingPolicy.findMany({ where, orderBy: [{ policyVersion: 'desc' }] });
      const mapper = AiRoutingPolicyEntityMapper.getInstance();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows carry the Prisma-generated row type the mapper accepts structurally but not nominally
      return (rows as any[]).map((row) => mapper.toDomainEntity(row));
    }
    return this.aiRoutingPolicyRepository.findAll({ filters, sort: [{ policyVersion: 'desc' }] });
  }
}
