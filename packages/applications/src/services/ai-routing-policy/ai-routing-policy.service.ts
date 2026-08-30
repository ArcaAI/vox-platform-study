import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ArgumentInvalidException, OptimisticConcurrencyException } from '@arcaai/exceptions';
import {
  AiExplicitProviderMode,
  AiRoutingPolicyEntity,
  AiRoutingPolicyEntityMapper,
  AiRoutingPolicyFactory,
  AiRoutingPolicyRepository,
  AiRoutingPolicyStatus,
  CoreDatabaseService,
  JsonValue,
  ResourceStatusType,
  ResourceType,
  SYSTEM_TENANT_ID,
  SysEventType,
} from '@arcaai/domains';
import { BaseService } from '../../common';
import { isSuperAdmin } from '../../common/tenant-guards';
import { IActiveUserContext } from '../../interfaces';
import { AI_TASK_KEYS } from '../ai-task-default/constants';
import { IProviderConnectionService, ProviderService } from '../ai-provider-connection/IProviderConnectionService';
import { IAiRoutingPolicyService, ResolveRoutingOptions } from './IAiRoutingPolicyService';
import { AiRoutingPolicyDtoMapper } from './ai-routing-policy.dto.mapper';
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

/**
 * The capability discriminator a routing candidate's `connectionRef` resolves
 * under. This plane routes LLM traffic (`taskKey` is `text.*`), and `llm` is
 * the `AiProviderConnection.service` value for that capability — a DOMAIN fact
 * fixed by the connection model's own key, not a tunable. The provider name,
 * endpoint, region, model and credential all still come from configuration.
 */
const ROUTING_CONNECTION_SERVICE: ProviderService = 'llm';

/** Machine-readable refusals a caller can branch on (§3A.4). */
const REJECTION = {
  providerUnavailable: 'provider_unavailable',
  providerNotInPolicy: 'provider_not_in_policy',
  noPolicy: 'no_policy',
  killSwitchEngaged: 'kill_switch_engaged',
  noEligibleCandidate: 'no_eligible_candidate',
} as const;

/**
 * Provider ROUTING POLICY service — TASK-818 §3A.
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
 * This service maps its `'tenant' | 'system'` source onto the §3A.4 wire
 * labels and does not re-derive it.
 */
@Injectable()
export class AiRoutingPolicyService extends BaseService implements IAiRoutingPolicyService {
  constructor(
    private readonly aiRoutingPolicyRepository: AiRoutingPolicyRepository,
    @Inject(IProviderConnectionService) private readonly providerConnectionService: IProviderConnectionService,
    // The UNSCOPED base client backs the super-admin cross-tenant lane only —
    // never a tenant-facing read. Mirrors `AiTaskDefaultService`.
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
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
   * The resolution the router consumes.
   *
   * Order of operations, each step observable in the response:
   *   1. read `[tenant, SYSTEM]` ACTIVE policies for the task;
   *   2. pick the winning TIER — tenant on presence, SYSTEM only on absence;
   *   3. within that tier pick the most-specific `match`, ties by `priority`
   *      then by authored `policyVersion`;
   *   4. honour an explicitly named provider under §3A.4's STRICT ruling;
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

    // STEP 1-2 — the two-tier cascade. `readPolicies` is handed exactly two
    // ids and can never be handed a third.
    const rows = await this.readPolicies([tenantId, SYSTEM_TENANT_ID], {
      taskKey,
      status: AiRoutingPolicyStatus.ACTIVE,
      resourceStatus: ResourceStatusType.ENABLED,
    });
    const tenantRows = tenantId === SYSTEM_TENANT_ID ? [] : rows.filter((row) => row.tenantId === tenantId);
    const systemRows = rows.filter((row) => row.tenantId === SYSTEM_TENANT_ID);
    // A tenant with ANY live policy for this task has expressed an opinion, so
    // SYSTEM is not consulted — widening happens on ABSENCE, never on a miss
    // inside a tier the tenant does own.
    const tier = tenantRows.length > 0 ? tenantRows : systemRows;
    const source = tenantRows.length > 0 ? 'tenant' : systemRows.length > 0 ? 'system' : null;

    // STEP 3 — most-specific match wins.
    const winner = this.selectMostSpecific(tier, options);
    if (!winner || !source) {
      return this.emptyResolution(tenantId, taskKey, source, {
        code: REJECTION.noPolicy,
        message: `No ACTIVE routing policy matches task '${taskKey}' for this tenant or the platform default.`,
        retryable: false,
      });
    }

    const base = this.baseResolution(tenantId, taskKey, source, winner);
    if (winner.killSwitch) {
      return {
        ...base,
        rejection: {
          code: REJECTION.killSwitchEngaged,
          message: `Routing policy '${winner.id}' (revision ${winner.policyVersion}) has its kill switch engaged; it serves nothing.`,
          retryable: false,
        },
      };
    }

    const candidates = parseCandidates(winner.candidatesJson).sort((a, b) => a.rank - b.rank);
    const contract = parseFallback(winner.fallbackJson);
    const unhealthy = new Set(options.unhealthyProviders ?? []);
    const rejected: { candidate: RoutingCandidate; reason: RoutingHopRejection }[] = [];

    // STEP 5 — derive funding once per candidate, from the connection row.
    const funded = await Promise.all(candidates.map((candidate) => this.fundCandidate(candidate, tenantId)));

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
          message: `No candidate of routing policy '${winner.id}' can serve: every candidate was refused (see rejectedCandidates).`,
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

  // ─────────────────────────────── writes ────────────────────────────────

  async create(tenantId: string, dto: CreateAiRoutingPolicyRequest): Promise<AiRoutingPolicyResponse> {
    this.assertSuperAdmin('author a routing policy');
    this.assertKnownTaskKey(dto.taskKey);
    this.assertCandidatesUsable(dto.candidates);

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
      candidatesJson: dto.candidates as JsonValue,
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
    // §3A.8 — a routing-policy change can redirect PHI to a different vendor,
    // so HIPAA §164.312(b) audit controls apply. `before` is null on a create;
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
    this.assertCandidatesUsable(draft.candidatesJson);
    const before = AiRoutingPolicyDtoMapper.toResponse(draft);

    const tx = this.crossTenantLane(tenantId);
    // The revision being superseded: the newest ACTIVE one for the same
    // (tenant, taskKey). It is ARCHIVED, never deleted — §3A.8 requires the
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

  /** Most-specific `match` wins; ties by `priority`, then by authored revision. */
  private selectMostSpecific(rows: AiRoutingPolicyEntity[], options: ResolveRoutingOptions): AiRoutingPolicyEntity | null {
    const admitted = rows
      .map((row) => ({ row, match: parseMatch(row.matchJson) }))
      .filter((entry) => matchesRequest(entry.match, options))
      .map((entry) => ({ row: entry.row, specificity: matchSpecificity(entry.match) }));
    if (admitted.length === 0) return null;
    admitted.sort((a, b) => b.specificity - a.specificity || b.row.priority - a.row.priority || b.row.policyVersion - a.row.policyVersion);
    return admitted[0].row;
  }

  /**
   * Derive one candidate's funding tier from the connection row that will
   * supply its credential — the `AiProviderConnectionService.fundingOf`
   * precedent, read rather than recomputed. `null` when no tier serves it,
   * which the gates treat as `CONNECTION_UNRESOLVED` (fail-closed).
   */
  private async fundCandidate(candidate: RoutingCandidate, tenantId: string): Promise<FundedCandidate> {
    try {
      const resolved = await this.providerConnectionService.resolveConnection(ROUTING_CONNECTION_SERVICE, candidate.connectionRef, tenantId);
      if (!resolved) return { candidate, funding: null };
      // 'tenant' = the tenant's own BYO row paid; 'system' = the platform
      // default did. These are the §3A.4 wire labels for the same two facts.
      return { candidate, funding: resolved.source === 'system' ? 'CLOUD' : 'BYOK' };
    } catch {
      // A connection that cannot even be READ is not a candidate. Never admit
      // a hop because its check was unavailable.
      return { candidate, funding: null };
    }
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
   * The three §3A.4 hard gates, applied to every hop against the primary and
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
   * §3A.4 — an explicitly named provider.
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

  /** Fields an update may touch, given the revision's lifecycle state. */
  private buildUpdateChanges(existing: AiRoutingPolicyEntity, dto: UpdateAiRoutingPolicyRequest): Record<string, unknown> {
    const changes: Record<string, unknown> = {};
    if (dto.killSwitch !== undefined) changes.killSwitch = dto.killSwitch;

    const semanticKeys = [
      'candidates',
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
      // §3A.8 — a served revision is a rollback target and an audit "before".
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
