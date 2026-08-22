import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { randomUUID } from 'crypto';
import { ClsService } from 'nestjs-cls';
import { RateLimitRuleEntity, RateLimitRuleRepository } from '@arcaai/domains';
import { IActiveUserContext } from '../../interfaces';
import { IRedisCacheService } from '../baseServices/redis';
import { RedisSubscriberService } from '../stt/realtime/redisSubscriber.service';
import { RateLimitRuleSnapshot } from './rate-limit-resolver';
import {
  RATE_LIMIT_RULES_INVALIDATION_CHANNEL,
  RATE_LIMIT_RULE_CACHE_REFRESH_CRON,
  RATE_LIMIT_RULE_CACHE_REFRESH_JOB,
  RATE_LIMIT_RULE_SYSTEM_TENANT_ID,
} from './rate-limit-rule.constants';

/**
 * In-memory rate-limit rule cache (TASK-785).
 *
 * `TieredThrottlerGuard` runs FIRST in the guard chain, on every request, before
 * auth — so it can afford exactly one thing on the hot path: a `Map` lookup.
 * This service owns that map.
 *
 * Two properties are load-bearing:
 *
 * 1. **The load runs OUTSIDE tenant CLS.** `RateLimitRule` is tenant-scoped, so
 *    a `findAll` executed under a request's CLS would be filtered to that
 *    tenant and the rebuilt cache would hold one customer's view of the whole
 *    platform. An admin write triggers a refresh IN-REQUEST, so this is not
 *    hypothetical — it is precisely the cache-poisoning bug TASK-771 fixed for
 *    `AppSettingsService`. `clsService.exit(...)` is the fix, and
 *    `rate-limit-rule.cache.test.ts` pins it.
 *
 * 2. **Fail-open.** A load failure keeps the PREVIOUS snapshot and logs; it
 *    never throws into the guard and never empties the map. A config-store
 *    outage must not decide whether traffic flows (AC-11).
 */
@Injectable()
export class RateLimitRuleCache {
  private readonly logger = new Logger(RateLimitRuleCache.name);

  /** tenantId → that scope's live rules. Rebuilt wholesale; never mutated in place. */
  private rulesByTenant: ReadonlyMap<string, readonly RateLimitRuleSnapshot[]> = new Map();

  private loaded = false;

  /** Skips a self-published invalidation message on receipt. */
  private readonly instanceId = randomUUID();

  constructor(
    private readonly ruleRepository: RateLimitRuleRepository,
    private readonly clsService: ClsService<IActiveUserContext>,
    private readonly schedulerRegistry: SchedulerRegistry,
    @Optional() @Inject(IRedisCacheService) private readonly redisCacheService?: IRedisCacheService,
    @Optional() private readonly redisSubscriberService?: RedisSubscriberService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
    this.startRefreshCron();
    await this.subscribeToCrossInstanceInvalidation();
  }

  onModuleDestroy(): void {
    try {
      this.schedulerRegistry.deleteCronJob(RATE_LIMIT_RULE_CACHE_REFRESH_JOB);
    } catch {
      // Never registered (or already torn down) — nothing to stop.
    }
  }

  /** The live rules for one scope. Returns `[]` for a scope with no rules. */
  getRulesFor(tenantId: string | null): readonly RateLimitRuleSnapshot[] {
    if (!tenantId) return [];
    return this.rulesByTenant.get(tenantId) ?? [];
  }

  /** The SYSTEM-owned rules — rank 4. */
  getPlatformRules(): readonly RateLimitRuleSnapshot[] {
    return this.rulesByTenant.get(RATE_LIMIT_RULE_SYSTEM_TENANT_ID) ?? [];
  }

  /** Whether a snapshot has ever loaded — the guard treats "not yet" as "no rules". */
  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Rebuild the snapshot from the database.
   *
   * MUST stay wrapped in `clsService.exit(...)` — see the class doc. `exit`
   * runs the callback with NO active CLS store, so the tenant-scope Prisma
   * extension passes through and the read sees every tenant's rules.
   */
  async refresh(): Promise<void> {
    try {
      const rules = await this.clsService.exit(() => this.ruleRepository.findAllForCache());
      this.rulesByTenant = groupByTenant(rules);
      this.loaded = true;
    } catch (error) {
      // Fail-open: keep serving the previous snapshot rather than emptying the
      // map, which would silently drop every tenant override at once.
      this.logger.error(
        JSON.stringify({
          message: 'Failed to refresh the rate-limit rule cache — keeping the previous snapshot (fail-open)',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  /**
   * Refresh THIS instance immediately, then tell the others. Called by
   * `RateLimitRuleService` after every mutation, so an admin's change is live
   * on the writing node before the response returns and on peers within one
   * pub/sub hop.
   */
  async invalidate(): Promise<void> {
    await this.refresh();
    await this.publishCrossInstanceInvalidation();
  }

  private startRefreshCron(): void {
    try {
      const job = new CronJob(RATE_LIMIT_RULE_CACHE_REFRESH_CRON, () => {
        void this.refresh();
      });
      this.schedulerRegistry.addCronJob(RATE_LIMIT_RULE_CACHE_REFRESH_JOB, job as never);
      job.start();
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          message: 'Could not register the rule-cache refresh cron — convergence falls back to invalidation messages only',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  private async publishCrossInstanceInvalidation(): Promise<void> {
    if (!this.redisCacheService) return;
    try {
      await this.redisCacheService.publish(RATE_LIMIT_RULES_INVALIDATION_CHANNEL, JSON.stringify({ instanceId: this.instanceId }));
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          message: 'Failed to publish rule-cache invalidation (fail-open — the cron still converges peers)',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  private async subscribeToCrossInstanceInvalidation(): Promise<void> {
    if (!this.redisSubscriberService) {
      this.logger.warn(
        JSON.stringify({
          message: 'Redis subscriber not available — rule-cache convergence stays cron-bound',
          channel: RATE_LIMIT_RULES_INVALIDATION_CHANNEL,
        }),
      );
      return;
    }

    try {
      const messages$ = await this.redisSubscriberService.subscribeToChannel(RATE_LIMIT_RULES_INVALIDATION_CHANNEL);
      messages$.subscribe({
        next: (raw: string) => {
          void this.handleInvalidationMessage(raw);
        },
      });
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          message: 'Failed to subscribe to the rule-cache invalidation channel — falling back to cron-only convergence',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  private async handleInvalidationMessage(raw: string): Promise<void> {
    try {
      const parsed = JSON.parse(raw) as { instanceId?: string };
      // This instance already refreshed synchronously inside `invalidate()`.
      if (parsed.instanceId === this.instanceId) return;
    } catch {
      // Unparseable payload — refresh anyway. A spurious refresh is cheap; a
      // skipped one serves stale limits.
    }
    await this.refresh();
  }
}

/** Snapshot + group. Entities are converted once, at load, never per request. */
function groupByTenant(rules: readonly RateLimitRuleEntity[]): ReadonlyMap<string, readonly RateLimitRuleSnapshot[]> {
  const grouped = new Map<string, RateLimitRuleSnapshot[]>();

  for (const rule of rules) {
    const snapshot: RateLimitRuleSnapshot = {
      id: rule.id,
      tenantId: rule.tenantId,
      routeMatch: rule.routeMatch,
      matchKind: rule.matchKind as RateLimitRuleSnapshot['matchKind'],
      limitValue: rule.limitValue,
      windowMs: rule.windowMs,
      active: rule.active,
    };
    const bucket = grouped.get(rule.tenantId);
    if (bucket) bucket.push(snapshot);
    else grouped.set(rule.tenantId, [snapshot]);
  }

  return grouped;
}
