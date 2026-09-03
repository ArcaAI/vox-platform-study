import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { RateLimitMatchKind, RateLimitRuleEntity, RateLimitRuleFactory, RateLimitRuleRepository, ResourceType, SysEventType } from '@arcaai/domains';
import { BaseService } from '../../common/base.service';
import { IActiveUserContext } from '../../interfaces';
import { IEntitlementsService } from '../entitlements/IEntitlementsService';
import { resolvePlanRateLimit } from '../entitlements/rate-limit-plan';
import {
  CreateRateLimitRuleInput,
  IRateLimitRuleService,
  ListRateLimitRulesQuery,
  RateLimitExplainResult,
  RateLimitRuleView,
  UpdateRateLimitRuleInput,
} from './IRateLimitRuleService';
import { IRateLimitSettingsService } from './IRateLimitSettingsService';
import { RateLimitRuleCache } from './rate-limit-rule.cache';
import {
  ALL_ROUTES_PATTERN,
  MAX_PLATFORM_RULES,
  MAX_RULES_PER_TENANT,
  RATE_LIMIT_RULE_SYSTEM_TENANT_ID,
  buildRouteKey,
} from './rate-limit-rule.constants';
import { RATE_LIMIT_TIER_DEFAULTS } from './rate-limit.constants';
import { RateLimitMatchKindName, resolveRateLimit } from './rate-limit-resolver';

/** `METHOD:path` or the reserved `*`. Method may be `*`; path must be absolute. */
const ROUTE_MATCH_PATTERN = /^(\*|[A-Z]+):\/[^\s]*$/;

/**
 * Admin CRUD over rate-limit rules, plus the resolution `explain`.
 *
 * Every mutation ends by invalidating {@link RateLimitRuleCache}, so a change is
 * live on this node before the response returns and on peers within one pub/sub
 * hop — no redeploy, matching the behaviour the tier baselines already have.
 */
@Injectable()
export class RateLimitRuleService extends BaseService implements IRateLimitRuleService {
  constructor(
    private readonly ruleRepository: RateLimitRuleRepository,
    private readonly cache: RateLimitRuleCache,
    @Inject(IRateLimitSettingsService)
    private readonly settings: IRateLimitSettingsService,
    @Inject(IEntitlementsService)
    private readonly entitlements: IEntitlementsService,
    eventEmitter: EventEmitter2,
    clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.RateLimitRule);
  }

  async list(query: ListRateLimitRulesQuery = {}): Promise<RateLimitRuleView[]> {
    const all = await this.clsService.exit(() => this.ruleRepository.findAllForCache());

    return all
      .filter((rule) => {
        if (query.tenantId) return rule.tenantId === query.tenantId;
        if (query.scope === 'platform') return rule.tenantId === RATE_LIMIT_RULE_SYSTEM_TENANT_ID;
        if (query.scope === 'tenant') return rule.tenantId !== RATE_LIMIT_RULE_SYSTEM_TENANT_ID;
        return true;
      })
      .map(toView);
  }

  async getById(id: string): Promise<RateLimitRuleView> {
    return toView(await this.findOrThrow(id));
  }

  async create(input: CreateRateLimitRuleInput): Promise<RateLimitRuleView> {
    const tenantId = input.tenantId?.trim() || RATE_LIMIT_RULE_SYSTEM_TENANT_ID;
    const matchKind = (input.matchKind ?? 'EXACT') as RateLimitMatchKindName;

    this.assertRouteMatch(input.routeMatch, matchKind, tenantId);
    this.assertPositiveInt(input.limitValue, 'limitValue');
    this.assertPositiveInt(input.windowMs, 'windowMs');
    await this.assertCapacity(tenantId);
    await this.assertNoDuplicate(tenantId, input.routeMatch, matchKind);

    const entity = RateLimitRuleFactory.CreateRateLimitRule({
      tenantId,
      routeMatch: input.routeMatch,
      matchKind: matchKind as RateLimitMatchKind,
      limitValue: input.limitValue,
      windowMs: input.windowMs,
      active: input.active ?? true,
      description: input.description ?? null,
      createdBy: this.requestUserId,
    });

    // The write is pinned to the rule's OWN tenant, not the caller's working
    // tenant: a super admin creating a rule FOR tenant X must not have the
    // tenant-scope extension stamp their selected tenant onto the row. Same
    // PLATFORM-PIN mechanism as `RateLimitAdminService.writeSetting`.
    const saved = await this.runPinned(tenantId, () => this.ruleRepository.create(entity));

    await this.cache.invalidate();
    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      resourceType: ResourceType.RateLimitRule,
      data: { tenantId, routeMatch: saved.routeMatch, matchKind: saved.matchKind, limitValue: saved.limitValue, windowMs: saved.windowMs },
    });

    return toView(saved);
  }

  async update(id: string, input: UpdateRateLimitRuleInput): Promise<RateLimitRuleView> {
    const existing = await this.findOrThrow(id);

    if (input.limitValue !== undefined) this.assertPositiveInt(input.limitValue, 'limitValue');
    if (input.windowMs !== undefined) this.assertPositiveInt(input.windowMs, 'windowMs');

    const previousVersion = existing.version;
    this.updateEntity(existing, {
      limitValue: input.limitValue,
      windowMs: input.windowMs,
      active: input.active,
      description: input.description,
    });

    if (!existing.hasChanges) return toView(existing);

    const saved = await this.runPinned(existing.tenantId, () =>
      this.ruleRepository.updateWithVersion(id, existing, input.expectedVersion ?? previousVersion),
    );

    await this.cache.invalidate();
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      resourceType: ResourceType.RateLimitRule,
      data: { tenantId: existing.tenantId, routeMatch: existing.routeMatch, previousVersion, newVersion: saved.version },
    });

    return toView(saved);
  }

  async remove(id: string): Promise<void> {
    const existing = await this.findOrThrow(id);

    await this.runPinned(existing.tenantId, () => this.ruleRepository.softDelete(id));

    await this.cache.invalidate();
    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: id,
      resourceType: ResourceType.RateLimitRule,
      data: { tenantId: existing.tenantId, routeMatch: existing.routeMatch },
    });
  }

  /**
   * The full resolution trace for one `(tenant, method, path)` (AC-8).
   *
   * With five levels and two match kinds, "why is this tenant getting 429s?" is
   * otherwise unanswerable without a debugger — so this is a first-class
   * surface, not a diagnostic afterthought.
   */
  async explain(tenantId: string | null, method: string, path: string): Promise<RateLimitExplainResult> {
    const routeKey = buildRouteKey(method, path);
    const base = this.settings.getTier('default') ?? RATE_LIMIT_TIER_DEFAULTS.default;

    let plan: { limitValue: number; windowMs: number } | null = null;
    if (tenantId) {
      try {
        const policy = await this.entitlements.getTenantRateLimitPolicy(tenantId);
        if (policy) {
          const composed = resolvePlanRateLimit(policy.tier, policy.perMinute, { limit: base.limit, ttl: base.ttl }, policy.windowMs ?? null);
          plan = { limitValue: composed.limit, windowMs: composed.ttl };
        }
      } catch {
        // Explain mirrors the guard: an entitlements failure means "rank 3 has
        // no opinion", never an error page.
        plan = null;
      }
    }

    const resolution = resolveRateLimit({
      tenantId,
      routeKey,
      tenantRules: this.cache.getRulesFor(tenantId),
      platformRules: this.cache.getPlatformRules(),
      plan,
      base: { limitValue: base.limit, windowMs: base.ttl },
    });

    const tenantLevels: ReadonlySet<string> = new Set(['tenant-route', 'tenant', 'plan']);

    return {
      tenantId,
      routeKey,
      effective: resolution.effective,
      level: resolution.level,
      ruleId: resolution.ruleId,
      bucket: tenantLevels.has(resolution.level) ? 'tenant' : 'ip',
      trace: resolution.trace.map((offer) => ({ ...offer, winner: offer.level === resolution.level })),
    };
  }

  // -------------------------------------------------------------------------

  private async findOrThrow(id: string): Promise<RateLimitRuleEntity> {
    const rule = await this.clsService.exit(() => this.ruleRepository.findById(id).catch(() => null));
    if (!rule) throw new NotFoundException('Resource not found');
    return rule;
  }

  /**
   * Run a write with CLS pinned to the row's OWN tenant, so the tenant-scope
   * extension resolves the row this operation names rather than whichever
   * working tenant the super admin happens to have selected. `ifNested:
   * 'inherit'` copies the active store, so the caller's user scope survives.
   */
  private async runPinned<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    return this.clsService.run({ ifNested: 'inherit' }, async () => {
      this.clsService.set('tenantId', tenantId);
      return work();
    });
  }

  private assertRouteMatch(routeMatch: string, matchKind: RateLimitMatchKindName, tenantId: string): void {
    if (!routeMatch || routeMatch.trim().length === 0) {
      throw new BadRequestException('`routeMatch` is required.');
    }

    if (routeMatch === ALL_ROUTES_PATTERN) {
      if (matchKind !== 'PREFIX') {
        throw new BadRequestException('The `*` (all routes) pattern requires `matchKind: "PREFIX"`.');
      }
      // Rank 5 (the named tier baselines) is the ONE platform-wide knob. A
      // SYSTEM-scoped `*` rule would be a second, ambiguous way to set the same
      // thing — and it would silently outrank the tier an admin edited on the
      // tiers screen.
      if (tenantId === RATE_LIMIT_RULE_SYSTEM_TENANT_ID) {
        throw new BadRequestException(
          'A platform-scoped rule may not use the `*` (all routes) pattern — set the platform-wide limit on the base tiers instead.',
        );
      }
      return;
    }

    if (!ROUTE_MATCH_PATTERN.test(routeMatch)) {
      throw new BadRequestException('`routeMatch` must be `METHOD:/path` (METHOD may be `*`), or the reserved `*` for every route.');
    }
    if (matchKind === 'EXACT' && routeMatch.includes('*', routeMatch.indexOf(':'))) {
      throw new BadRequestException('An EXACT rule may not contain a `*` wildcard in its path — use `matchKind: "PREFIX"`.');
    }
  }

  private assertPositiveInt(value: number, field: string): void {
    if (!Number.isInteger(value) || value < 1) {
      throw new BadRequestException(`\`${field}\` must be a positive integer (received ${value}).`);
    }
  }

  /**
   * `bestMatch` linearly scans one scope per request, so the rule count is a
   * latency input. Refusing the write is deliberate: silently dropping the
   * newest rule would read as "applied" while quietly not applying.
   */
  private async assertCapacity(tenantId: string): Promise<void> {
    const existing = await this.clsService.exit(() => this.ruleRepository.findByTenant(tenantId));
    const platform = tenantId === RATE_LIMIT_RULE_SYSTEM_TENANT_ID;
    const cap = platform ? MAX_PLATFORM_RULES : MAX_RULES_PER_TENANT;

    if (existing.length >= cap) {
      throw new ConflictException(
        `This scope already holds ${existing.length} rate-limit rules (cap ${cap}). Delete or consolidate a rule before adding another.`,
      );
    }
  }

  private async assertNoDuplicate(tenantId: string, routeMatch: string, matchKind: RateLimitMatchKindName): Promise<void> {
    const existing = await this.clsService.exit(() => this.ruleRepository.findByTenant(tenantId));
    if (existing.some((rule) => rule.routeMatch === routeMatch && rule.matchKind === matchKind)) {
      throw new ConflictException(`A ${matchKind} rule for \`${routeMatch}\` already exists in this scope — update it instead.`);
    }
  }
}

function toView(entity: RateLimitRuleEntity): RateLimitRuleView {
  return {
    id: entity.id,
    tenantId: entity.tenantId,
    platform: entity.tenantId === RATE_LIMIT_RULE_SYSTEM_TENANT_ID,
    routeMatch: entity.routeMatch,
    matchKind: entity.matchKind as RateLimitMatchKindName,
    limitValue: entity.limitValue,
    windowMs: entity.windowMs,
    active: entity.active,
    description: entity.description ?? null,
    version: entity.version,
    createdAt: entity.createdAt.toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
  };
}
