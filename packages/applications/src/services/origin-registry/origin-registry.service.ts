// TASK-610 §3.3 / §4.1 — OriginRegistryService (lane W2-A).
//
// Implements `IOriginRegistry`: an in-memory reverse index
// `Map<normalized origin, ownerTenantId>` built from every
// `TenantAllowedOrigin` row across every tenant. This is the index the CORS
// callback (pre-auth, browser-facing/advisory) and `OriginTenantBindingGuard`
// (post-auth, the real isolation control, FR-4) both read — see the diagram
// in `IOriginRegistry.ts`.
//
// §4A.2 EXTENSION (lane W5-B) — wildcard host patterns. A stored row is a
// PATTERN iff its `origin` text contains `*` (`isOriginPattern`,
// `origin-pattern.ts`, lane W5-A — frozen grammar/match rules, not
// re-designed here). The index therefore has two tiers, consulted in order:
//
//   1. The exact `Map<origin, ownerTenantId>` (unchanged, O(1)).
//   2. A `patterns` list, sorted MOST-specific first (`patternSpecificity`),
//      walked linearly on an exact miss and returning the FIRST match.
//
// This ordering IS the precedence contract (§4A.2): exact beats every
// pattern (tier 1 wins outright); among patterns, the longest/most-specific
// suffix wins because it sorts first; the `*` allow-all token carries the
// lowest possible specificity, so it is only ever reached once nothing more
// specific matched. Getting this backwards — `*` outranking
// `https://*.bcmch.org:*` — would resolve a tenant-owned origin to the
// Global tenant and make `OriginTenantBindingGuard` 404 legitimate traffic.

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ClsService } from 'nestjs-cls';
import { ResourceStatusType, TenantAllowedOriginEntity, TenantAllowedOriginRepository } from '@arcaai/domains';
import { IOriginRegistry } from './IOriginRegistry';
import { normalizeOrigin } from './origin-normalizer';
import { ALLOW_ALL_ORIGIN_PATTERN, isOriginPattern, matchesOriginPattern, patternSpecificity } from './origin-pattern';

/** One resolved entry in the sorted pattern tier — see `patterns` below. */
interface PatternIndexEntry {
  readonly pattern: string;
  readonly tenantId: string;
}

/** Rebuilt index halves handed back by `buildIndex()` — see `refresh()`. */
interface BuiltIndex {
  readonly exact: Map<string, string>;
  readonly patterns: PatternIndexEntry[];
}

@Injectable()
export class OriginRegistryService implements IOriginRegistry, OnModuleInit {
  private readonly logger = new Logger(OriginRegistryService.name);

  /**
   * `Map<normalized origin, ownerTenantId>`. Always REPLACED wholesale by a
   * fresh map built in `buildIndex()` — never mutated in place — so a
   * refresh in progress can never leave `read`ers observing a half-built
   * index, and a failed refresh can simply decline to swap it in.
   */
  private index: Map<string, string> = new Map();

  /**
   * Pattern rows (§4A.2), sorted MOST-specific first by `patternSpecificity`
   * descending, ties broken by earliest-created `id` (UUIDv7) ascending —
   * the same tie-break `buildIndex()` already uses for a duplicate exact
   * origin. Walked linearly, in order, on an exact-map miss; the first
   * match wins. Always REPLACED wholesale alongside `index` — see the
   * comment on that field above, which applies here identically.
   */
  private patterns: PatternIndexEntry[] = [];

  /**
   * Timestamp of the last SUCCESSFUL `refresh()` (set at the end of the
   * index-build try-block below), or `null` if none has ever succeeded.
   * `null` is a real, distinct state — "the index has been live since
   * boot with zero successful loads" is worse than "went stale N ms ago"
   * and must not be conflated with a fresh `Date`. Exposed via
   * `getLastSuccessfulRefreshAt()` and used to compute staleness on every
   * failure log — see the `@Cron` backstop below for why this exists.
   */
  private lastSuccessfulRefreshAt: Date | null = null;

  constructor(
    private readonly repository: TenantAllowedOriginRepository,
    private readonly cls: ClsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  /**
   * Exact map first (O(1)); on a miss, walk `patterns` in its pre-sorted
   * (most-specific-first) order and return the first match. This ordering
   * IS the §4A.2 precedence contract — see the file-header comment.
   */
  ownerOf(origin: string): string | null {
    const key = this.toLookupKey(origin);
    if (key === null) {
      return null;
    }

    const exactOwner = this.index.get(key);
    if (exactOwner !== undefined) {
      return exactOwner;
    }

    for (const entry of this.patterns) {
      if (matchesOriginPattern(entry.pattern, key)) {
        return entry.tenantId;
      }
    }

    return null;
  }

  has(origin: string): boolean {
    return this.ownerOf(origin) !== null;
  }

  /** Exact rows plus pattern rows — the total count of registered origins. */
  size(): number {
    return this.index.size + this.patterns.length;
  }

  /**
   * Timestamp of the last successful `refresh()`, or `null` if the index has
   * never successfully loaded (e.g. every attempt since boot has failed).
   * Exists so a persistently stale index — the actual risk a revoked origin
   * poses, not the absence of a timer per se — is OBSERVABLE from outside
   * this class rather than only inferrable from log-scraping.
   */
  getLastSuccessfulRefreshAt(): Date | null {
    return this.lastSuccessfulRefreshAt;
  }

  /**
   * Independent backstop refresh (plan §4.1 follow-up — adversarial review,
   * MEDIUM finding). Propagation is normally event-driven
   * (`onInvalidationEvent()` below, fired on a mutation or on
   * `AppSettingsService`'s own cache refresh) — this timer does NOT replace
   * that path; it bounds how long a REVOKED origin can stay live if
   * propagation silently stops.
   *
   * Why a separate timer is necessary: `AppSettingsService` emits
   * `app-settings.cache-refreshed` only on its SUCCESS path — a failed
   * refresh emits `app-settings.cache-error` and rethrows instead (see
   * `cacheAppSettings()`). If AppSettings caching fails persistently (a mode
   * its own comments describe as possible), this registry would never hear
   * `app-settings.cache-refreshed` again on ANY node, and — absent this
   * timer — a revoked origin would stay in the index indefinitely, with
   * nothing surfacing that fact (`Origin registry refreshed` is a `log`
   * line, not a metric or an alarm).
   *
   * Interval: `EVERY_30_SECONDS`. Chosen, not defaulted:
   *   - It is a documented, honestly-statable bound: a revoked origin is
   *     refused within ~30s even if EVERY other propagation path (the
   *     `origin-registry.invalidate` emit, AND the `app-settings.cache-refreshed`
   *     relay) is broken — tighter than, and independent of, the
   *     ~60s-worst-case `AppSettingsService` cron this used to transitively
   *     depend on (its own `DEFAULT_CACHE_REFRESH_INTERVAL = '45 * * * * *'`
   *     comment claims "every 45 seconds"; it actually fires once per
   *     minute at :45, i.e. up to ~60s worst case — the adversarial review
   *     caught that this ticket's own §4.1 table inherited that same wrong
   *     "≤45s" claim).
   *   - It matches this package's existing precedent for a FIXED
   *     (non-settings-configurable) backstop:
   *     `ServiceHealthMonitoringService.performHealthChecks()`
   *     (`baseServices/serviceHealth/serviceHealthMonitoring.service.ts`)
   *     uses the same `@Cron(CronExpression.EVERY_30_SECONDS)` shape rather
   *     than a `SchedulerRegistry`-managed dynamic job — that machinery
   *     (see `AppSettingsService`/`AgentTemplateResyncCronService`) exists
   *     for schedules an admin can reconfigure at runtime, which this
   *     backstop deliberately is NOT: it is a fixed security bound, not a
   *     tunable.
   *   - A `findAll({})` against a platform allow-list table (four rows
   *     day-1) is cheap enough to run unconditionally every 30s on every
   *     node without a settings gate or kill-switch.
   *
   * Routed through `onInvalidationEvent()` — the SAME `cls.exit()`-guarded
   * entry point the event listeners use — rather than calling `refresh()`
   * directly, so there remains exactly ONE path into `refresh()` from
   * outside `onModuleInit()`, and no second place the CONFIRMED DEFECT above
   * could be reintroduced. In practice a scheduled callback has no CLS store
   * to begin with, so this normally just takes `onInvalidationEvent()`'s
   * `!cls.isActive()` fast path — but going through the guard costs nothing
   * and removes the need to reason about it separately.
   */
  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'origin-registry-backstop-refresh' })
  scheduledRefresh(): Promise<void> {
    return this.onInvalidationEvent();
  }

  /**
   * Event-listener entry point for the two invalidation signals (plan §4.1
   * frozen contract). Its ONLY job is guaranteeing `refresh()` (below) never
   * executes while a REQUEST's CLS store is attached. `refresh()` itself
   * stays a pure, directly-callable operation — `onModuleInit()` still calls
   * it directly, which is safe because Nest bootstrap has no CLS store at
   * all.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * CONFIRMED DEFECT this wrapper exists to close (found by the TASK-610
   * adversarial review, W4-R):
   *
   * `TenantAllowedOriginService` emits `origin-registry.invalidate`
   * SYNCHRONOUSLY at the end of create/update/delete — i.e. from INSIDE the
   * writing request. `AppSettingsService.handleGlobalSettingUpdated` emits
   * `app-settings.cache-refreshed` the same way, also from inside a request.
   * `@nestjs/event-emitter` dispatches `@OnEvent` listeners synchronously on
   * the SAME call stack as `.emit()` — so a listener wired directly to
   * `refresh()` would begin executing INSIDE the emitting request's
   * AsyncLocalStorage (CLS) store, which is exactly the HAZARD documented on
   * `refresh()` below. Concretely: `TenantAllowedOrigin` is listed in
   * `TENANT_SCOPED_MODELS` and is NOT in `SYSTEM_SHARED_READ_MODELS`
   * (`packages/database/src/extensions/tenant-scope.ts`), so
   * `repository.findAll({})` called from inside that store gets the CALLING
   * tenant's id silently merged into its `where` clause — the index rebuilds
   * with only that one tenant's rows. Every other tenant's (and every
   * SYSTEM) origin then vanishes from CORS until the next unrelated
   * cron-driven settings refresh, `size() > 0` stays true throughout so the
   * bootstrap fallback never kicks in, and NOTHING goes red — production
   * CORS simply starts refusing the admin console and the seeded platform
   * origins.
   *
   * Deferring the call (`setImmediate` / `process.nextTick` / `setTimeout` /
   * a bare un-awaited promise) does NOT fix this — verified directly: Node's
   * AsyncLocalStorage store propagates through async continuations no matter
   * how they are scheduled. The only confirmed escape hatch is
   * `ClsService#exit()` (`nestjs-cls` 6.2.1, wraps the native
   * `AsyncLocalStorage#exit()`): it runs its callback — and everything that
   * callback goes on to schedule asynchronously — with the store detached.
   * ═══════════════════════════════════════════════════════════════════════
   */
  @OnEvent('origin-registry.invalidate')
  @OnEvent('app-settings.cache-refreshed')
  onInvalidationEvent(): Promise<void> {
    const run = (): Promise<void> =>
      this.refresh().catch((error) => {
        // `refresh()` already handles its own expected failure modes (a
        // failed DB read, a failed index build) internally and logs them —
        // this only catches a genuinely unexpected throw escaping it, so the
        // promise returned by `cls.exit()` (or returned directly below) can
        // never become an unhandled rejection, regardless of whether the
        // event emitter or a direct caller awaits it.
        this.logger.error({
          message: 'Unexpected error escaped refresh() from the invalidation event handler',
          error: error instanceof Error ? error.message : String(error),
        });
      });

    if (!this.cls.isActive()) {
      // No CLS store in flight (Nest bootstrap, a future non-request
      // emitter, or a direct call outside `cls.run()`) — `refresh()` is
      // already safe to call as-is; entering/exiting a store that doesn't
      // exist would be a no-op anyway, but this keeps the common case
      // (module init) obviously simple.
      return run();
    }

    // THE FIX: detach the request's CLS store for the duration of `run()`
    // (and everything it schedules asynchronously) before `refresh()` ever
    // calls `repository.findAll({})`. See the CONFIRMED DEFECT block above.
    return this.cls.exit(run);
  }

  /**
   * Rebuild the in-memory index from the database.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * HAZARD (plan §3.3, §4.1 — read this before changing a single line here):
   *
   * This method MUST NOT be called from inside a request CLS scope.
   * `TenantAllowedOrigin` is listed in `TENANT_SCOPED_MODELS`
   * (`packages/database/src/extensions/tenant-scope.ts`), so the tenant-scope
   * Prisma extension injects the CALLING tenant's `tenantId` into every read
   * against it WHENEVER a CLS tenant context exists. Call `refresh()` from a
   * request handler (a controller, a service method invoked mid-request, OR
   * — as TASK-610's adversarial review confirmed — an `@OnEvent` listener
   * invoked synchronously from inside a write request) and
   * `repository.findAll({})` silently stops meaning "every tenant's rows" —
   * it becomes "this one caller's rows". The index would then rebuild with
   * only that tenant's (and no SYSTEM) origins, and CORS would start
   * refusing every other tenant's browser origin. NOTHING throws when this
   * happens; it is a silent scope narrowing, not an error.
   *
   * `refresh()` is safe exactly because it only ever runs:
   *   - from `onModuleInit()` (Nest bootstrap, no request in flight), and
   *   - from `onInvalidationEvent()`'s `cls.exit()` callback above, which
   *     EXPLICITLY detaches any request CLS store before calling this.
   * Outside a request (or CLS-detached), the tenant-scope extension passes
   * the read straight through, which is exactly the cross-tenant visibility
   * this reverse index needs. This is the SAME mechanism
   * `AppSettingsService.cacheAppSettings()` relies on for its own
   * `findAll({})` read — see
   * `packages/applications/src/services/baseServices/_meta/appSettings/appSettings.service.ts:314`
   * and its neighboring comment.
   *
   * Do NOT call `refresh()` directly from a controller action, an RPC
   * handler, or any other request-scoped code path — and do not wire a new
   * `@OnEvent` directly to `refresh()`; route it through a
   * `cls.exit()`-wrapped listener the way `onInvalidationEvent()` does.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Robustness: on a failed DB read, or on any unexpected error while
   * building the replacement index, this method logs and returns WITHOUT
   * touching `this.index`. A stale-but-good index is always preferable to an
   * empty one — an empty index would deny every browser origin
   * platform-wide, which is strictly worse than serving a slightly stale
   * (but correct) one. Both failure branches also log how long the index
   * has now been stale (`staleForMs`, or `neverSucceeded: true` if no
   * refresh has EVER succeeded) — a persistent failure must be greppable
   * and alertable, not just silently "the old data is still there". This is
   * what makes the `@Cron` backstop above meaningful: the timer alone only
   * narrows the window a stale index could go undetected in, it does not
   * detect staleness by itself.
   */
  async refresh(): Promise<void> {
    let rows: TenantAllowedOriginEntity[];
    try {
      // MUST be `{}` — no tenant filter. See the HAZARD block above.
      rows = await this.repository.findAll({});
    } catch (error) {
      this.logger.error({
        message: 'Failed to load allowed origins from the database — keeping the previous origin registry index',
        previousSize: this.index.size,
        error: error instanceof Error ? error.message : String(error),
        ...this.stalenessLogFields(),
      });
      return;
    }

    try {
      const newIndex = this.buildIndex(rows);
      this.index = newIndex.exact;
      this.patterns = newIndex.patterns;
      this.lastSuccessfulRefreshAt = new Date();
      this.logger.log({
        message: 'Origin registry refreshed',
        size: newIndex.exact.size + newIndex.patterns.length,
        exactCount: newIndex.exact.size,
        patternCount: newIndex.patterns.length,
      });
      this.warnIfAllowAllPresent(newIndex.patterns);
    } catch (error) {
      this.logger.error({
        message: 'Failed to build the origin registry index from loaded rows — keeping the previous index',
        previousSize: this.index.size,
        error: error instanceof Error ? error.message : String(error),
        ...this.stalenessLogFields(),
      });
    }
  }

  /** `{ staleForMs }` since the last successful refresh, or `{ neverSucceeded: true }` if none has ever succeeded. */
  private stalenessLogFields(): { staleForMs: number } | { neverSucceeded: true } {
    if (this.lastSuccessfulRefreshAt === null) {
      return { neverSucceeded: true };
    }
    return { staleForMs: Date.now() - this.lastSuccessfulRefreshAt.getTime() };
  }

  /**
   * Build a fresh reverse index from raw repository rows.
   *
   * - Skips soft-deleted rows. `findAll` through the extended client already
   *   filters `resourceStatus: { not: DELETED }` (`getExtendedPrismaClient`),
   *   but that is ASSERTED here rather than assumed: a transaction-client
   *   read that bypasses the soft-delete extension, or a row touched by
   *   direct SQL, must not resurrect a removed origin into the live index.
   * - Deterministic on a duplicate origin across tenants (plan §3.6 T-3).
   *   The DB's global unique index on `origin`
   *   (`TenantAllowedOrigin_origin_unique`) makes two ENABLED rows for the
   *   same origin unreachable through normal writes, but a bad backfill or
   *   direct SQL could still produce one — Map insertion order (effectively
   *   whatever order the DB happened to return rows in) must not be allowed
   *   to silently decide the winner. Rows are sorted by `id` (UUIDv7 —
   *   time-ordered) ascending first, so the EARLIEST-CREATED row always wins
   *   regardless of query/array order, and every conflict is logged loudly
   *   with both tenant ids so it surfaces as an operational alert, not a
   *   silent access decision.
   * - §4A.2: a row whose `origin` text contains `*` (`isOriginPattern`) is
   *   split into the `patterns` tier instead of the exact `Map`, then
   *   sorted MOST-specific first (`patternSpecificity` descending), ties
   *   broken by the SAME earliest-id-wins rule as the exact map above. That
   *   sort order is the precedence contract `ownerOf()` relies on — see the
   *   file-header comment.
   */
  private buildIndex(rows: readonly TenantAllowedOriginEntity[]): BuiltIndex {
    const live = rows.filter((row) => row.resourceStatus !== ResourceStatusType.DELETED);
    const sorted = [...live].sort((a, b) => a.id.localeCompare(b.id));

    const exact = new Map<string, string>();
    const patternRows: Array<PatternIndexEntry & { id: string }> = [];

    for (const row of sorted) {
      const key = row.origin.toLowerCase();

      if (isOriginPattern(key)) {
        patternRows.push({ id: row.id, pattern: key, tenantId: row.tenantId });
        continue;
      }

      const existingOwner = exact.get(key);
      if (existingOwner !== undefined) {
        if (existingOwner !== row.tenantId) {
          this.logger.error({
            message:
              'Duplicate TenantAllowedOrigin rows found for one origin across two different tenants — keeping the earliest-created row. ' +
              'The DB unique index on `origin` should make this unreachable through normal writes; investigate for a bad backfill or direct SQL write.',
            origin: key,
            keptOwnerTenantId: existingOwner,
            discardedOwnerTenantId: row.tenantId,
          });
        }
        continue;
      }

      exact.set(key, row.tenantId);
    }

    // Explicit two-key sort rather than leaning on `sorted`'s pre-existing
    // id-ascending order + Array#sort stability: correct either way today,
    // but this keeps the tie-break correct even if the loop above is ever
    // reordered to build `patternRows` out of id order.
    const patterns = patternRows
      .sort((a, b) => patternSpecificity(b.pattern) - patternSpecificity(a.pattern) || a.id.localeCompare(b.id))
      .map(({ pattern, tenantId }) => ({ pattern, tenantId }));

    return { exact, patterns };
  }

  /**
   * §4A.3 — an allow-all (`*`) row means every unmatched origin is admitted
   * for its owning tenant. That is a legitimate, deliberate owner decision
   * (frozen for the Global tenant), but an operator must never have to read
   * the database to discover the platform is in that state — so this logs
   * at `warn` on EVERY successful refresh, not just the first time the row
   * appears, for exactly the same reason `refresh()`'s own success log runs
   * unconditionally on every call rather than only on a change.
   */
  private warnIfAllowAllPresent(patterns: readonly PatternIndexEntry[]): void {
    const allowAllEntry = patterns.find((entry) => entry.pattern === ALLOW_ALL_ORIGIN_PATTERN);
    if (allowAllEntry === undefined) {
      return;
    }

    this.logger.warn({
      message: `Origin registry contains an allow-all ('*') row owned by tenant ${allowAllEntry.tenantId}; every unmatched origin is admitted for that tenant.`,
      ownerTenantId: allowAllEntry.tenantId,
    });
  }

  /**
   * Normalize a raw browser `Origin` header value into the same canonical
   * form origins are stored in (`normalizeOrigin` — `origin-normalizer.ts`
   * is the single source of truth for origin syntax). Lowercased on top of
   * whatever `normalizeOrigin` returns — origins should already be
   * lowercase on write, but this avoids a case-sensitivity trap if a row
   * was ever inserted outside the normal write path (direct SQL, backfill).
   *
   * NEVER throws. `normalizeOrigin` throws `ArgumentInvalidException` on any
   * malformed/wildcard/disallowed-scheme input, and callers of `has()` /
   * `ownerOf()` (the CORS callback, the WS handshake, the tenant-binding
   * guard) feed this a raw, attacker-controlled `Origin` header. An
   * unparseable origin is simply "not registered" — returning `null`/`false`
   * — never a thrown exception that could turn a hostile or malformed header
   * into an unhandled 500.
   */
  private toLookupKey(origin: string): string | null {
    if (typeof origin !== 'string' || origin.trim().length === 0) {
      return null;
    }

    try {
      return normalizeOrigin(origin).origin.toLowerCase();
    } catch {
      return null;
    }
  }
}
