// OriginRegistryService.
//
// REWRITTEN — many-to-many origins ↔ tenants. `ownerOf`
// (single owner) is GONE. `TenantAllowedOrigin` moved from a global unique on
// `origin` to a unique on `(origin, tenantId)` — a `(origin)` row is
// now potentially several GRANTS, one per tenant, and resolution is a UNION
// of every matching grant's tenant, with no precedence/tie-break:
//
//   tenantsFor(origin) = ⋃ { row.tenantId : row is exact-equal OR row is a
//                            pattern matching origin }
//
// Implements `IOriginRegistry`: an in-memory reverse index
// `Map<normalized origin, Set<tenantId>>` (+ a pattern tier, same shape)
// built from every `TenantAllowedOrigin` row across every tenant. This is the
// index the CORS callback (pre-auth, browser-facing/advisory) and
// `OriginTenantBindingGuard` (post-auth, the real isolation control)
// both read via `has()`/`allows()` — see the diagram in `IOriginRegistry.ts`.
//
// Heritage — wildcard host patterns. A stored row is a PATTERN iff its
// `origin` text contains `*` (`isOriginPattern`, `origin-pattern.ts` —
// frozen grammar/match rules, not re-designed here). The index still
// has two tiers, but resolution no longer walks them in "most specific
// first, return first match" order:
//
//   1. The exact `Map<origin, Set<tenantId>>` (unchanged shape, O(1) lookup
//      of the grant set for that exact origin).
//   2. A `patterns` list — EVERY entry whose pattern matches the origin
//      contributes its tenant set to the result. There is no early return.
//
// `patternSpecificity` (`origin-pattern.ts`) is NO LONGER on the
// authorization path — union has nothing to break a tie between ("the
// old precedence — exact beats pattern, longest suffix wins — disappears").
// It is kept here ONLY to give `refresh()`'s log output (and the `patterns`
// array in general) a stable, human-meaningful iteration order — most
// specific first, so an operator reading a log line sees the more
// interesting/narrow grants before the broad ones. Nothing about the
// registry's ANSWER to `tenantsFor`/`has`/`allows` depends on this order.

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ClsService } from 'nestjs-cls';
import { ResourceStatusType, TenantAllowedOriginEntity, TenantAllowedOriginRepository } from '@arcaai/domains';
import { IOriginRegistry } from './IOriginRegistry';
import { normalizeOrigin } from './origin-normalizer';
import { ALLOW_ALL_ORIGIN_PATTERN, isOriginPattern, matchesOriginPattern, patternSpecificity } from './origin-pattern';

/** Platform-wide tenant id — a grant to SYSTEM is valid for every tenant (see `allows()`). */
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/** Shared, never-mutated empty set — returned for an unregistered/malformed lookup to avoid an allocation on the hot miss path. */
const EMPTY_TENANT_SET: ReadonlySet<string> = new Set();

/** One resolved entry in the pattern tier — see `patterns` below. Grouped by pattern text: several tenants may be granted the SAME pattern. */
interface PatternIndexEntry {
  readonly pattern: string;
  readonly tenants: ReadonlySet<string>;
}

/** Rebuilt index halves handed back by `buildIndex()` — see `refresh()`. */
interface BuiltIndex {
  readonly exact: Map<string, Set<string>>;
  readonly patterns: PatternIndexEntry[];
}

@Injectable()
export class OriginRegistryService implements IOriginRegistry, OnModuleInit {
  private readonly logger = new Logger(OriginRegistryService.name);

  /**
   * `Map<normalized origin, Set<tenantId>>` — every tenant currently granted
   * this EXACT origin. Always REPLACED wholesale by a fresh map built in
   * `buildIndex()` — never mutated in place — so a refresh in progress can
   * never leave `read`ers observing a half-built index, and a failed refresh
   * can simply decline to swap it in.
   */
  private index: Map<string, Set<string>> = new Map();

  /**
   * Pattern rows, one entry per DISTINCT pattern text — several
   * tenants granted the same pattern collapse into that entry's `tenants`
   * set (grouped in `buildIndex()`, mirroring how the exact map groups
   * grants of the same origin). Sorted most-specific-first
   * (`patternSpecificity` descending) for deterministic LOG ordering only
   * (union resolution has no precedence left to preserve; see the
   * file header). `tenantsFor()` walks every entry unconditionally — it does
   * NOT stop at the first match. Always REPLACED wholesale alongside
   * `index` — see the comment on that field above, which applies here
   * identically.
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
   * Union resolution: the union of the exact-map entry's tenants (if
   * any) and EVERY pattern entry whose pattern matches this origin — no
   * early return, no precedence. A matching `*` allow-all row therefore
   * always contributes its tenant(s), even when a more specific pattern or
   * an exact row also matched; see the file header for why that is the
   * deliberate, owner-directed behavior ('s note on the Global `*`
   * row).
   */
  tenantsFor(origin: string): ReadonlySet<string> {
    const key = this.toLookupKey(origin);
    if (key === null) {
      return EMPTY_TENANT_SET;
    }

    const exactTenants = this.index.get(key);
    const matchingPatterns = this.patterns.filter((entry) => matchesOriginPattern(entry.pattern, key));

    if (exactTenants === undefined && matchingPatterns.length === 0) {
      return EMPTY_TENANT_SET;
    }
    if (matchingPatterns.length === 0) {
      // No union needed — return the exact set directly rather than a copy.
      // Callers only ever read this (the interface returns `ReadonlySet`).
      return exactTenants as ReadonlySet<string>;
    }

    const union = new Set<string>(exactTenants ?? []);
    for (const entry of matchingPatterns) {
      for (const tenantId of entry.tenants) {
        union.add(tenantId);
      }
    }
    return union;
  }

  has(origin: string): boolean {
    return this.tenantsFor(origin).size > 0;
  }

  /**
   * The ONE place the SYSTEM rule lives (frozen contract) — the guard
   * and the WS handshake must call this rather than re-deriving it.
   */
  allows(origin: string, tenantId: string): boolean {
    const tenants = this.tenantsFor(origin);
    return tenants.has(tenantId) || tenants.has(SYSTEM_TENANT_ID);
  }

  /** Distinct exact origins plus distinct patterns — see `IOriginRegistry.size()` doc: grants of one origin to several tenants collapse to one. */
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
   * Independent backstop refresh (follow-up — adversarial review,
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
   *     caught that the original table inherited that same wrong
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
   * Event-listener entry point for the two invalidation signals (
   * frozen contract). Its ONLY job is guaranteeing `refresh()` (below) never
   * executes while a REQUEST's CLS store is attached. `refresh()` itself
   * stays a pure, directly-callable operation — `onModuleInit()` still calls
   * it directly, which is safe because Nest bootstrap has no CLS store at
   * all.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * CONFIRMED DEFECT this wrapper exists to close (found by the 
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
   * HAZARD (read this before changing a single line here):
   *
   * This method MUST NOT be called from inside a request CLS scope.
   * `TenantAllowedOrigin` is listed in `TENANT_SCOPED_MODELS`
   * (`packages/database/src/extensions/tenant-scope.ts`), so the tenant-scope
   * Prisma extension injects the CALLING tenant's `tenantId` into every read
   * against it WHENEVER a CLS tenant context exists. Call `refresh()` from a
   * request handler (a controller, a service method invoked mid-request, OR
   * as 's adversarial review confirmed — an `@OnEvent` listener
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
        previousSize: this.size(),
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
        previousSize: this.size(),
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
   * - — GROUPS rather than picks a winner. Two (or more) rows
   *   for the same origin — now legitimately different tenants, since the
   *   DB constraint moved to `@@unique([origin, tenantId])` — collapse into
   *   ONE map entry whose value is the SET of every granted tenant. This
   *   REPLACES the old single-owner behavior, which treated a duplicate
   *   origin across two tenants as a data-integrity error to log loudly and
   *   pick a deterministic (earliest-id) winner for. That is no longer
   *   possible to construct through normal writes at all (two rows sharing
   *   BOTH `origin` and `tenantId` remain impossible via the DB constraint),
   *   and even the case this used to warn about — two DIFFERENT tenants
   *   sharing one origin — is now the intended, everyday shape of the data.
   *   There is deliberately NO `logger.error` call left anywhere in this
   *   method for that case.
   * - Rows are still sorted by `id` (UUIDv7 — time-ordered) ascending before
   *   grouping. This ordering is no longer a tie-break (a Set has no order
   *   to break a tie over) — it exists only so iteration/grouping is
   *   deterministic run-to-run regardless of what order the repository
   *   happened to return rows in, which keeps `refresh()`'s log output
   *   stable and any future debug tooling reproducible.
   * - a row whose `origin` text contains `*` (`isOriginPattern`) is
   *   split into the `patterns` tier instead of the exact `Map`, GROUPED the
   *   same way by pattern text, then sorted MOST-specific first
   *   (`patternSpecificity` descending) for LOG ordering only — see the
   *   file-header comment on why this sort no longer decides an
   *   authorization outcome.
   */
  private buildIndex(rows: readonly TenantAllowedOriginEntity[]): BuiltIndex {
    const live = rows.filter((row) => row.resourceStatus !== ResourceStatusType.DELETED);
    const sorted = [...live].sort((a, b) => a.id.localeCompare(b.id));

    const exact = new Map<string, Set<string>>();
    const patternGroups = new Map<string, Set<string>>();

    for (const row of sorted) {
      const key = row.origin.toLowerCase();
      const target = isOriginPattern(key) ? patternGroups : exact;

      const tenants = target.get(key) ?? new Set<string>();
      tenants.add(row.tenantId);
      target.set(key, tenants);
    }

    const patterns = [...patternGroups.entries()]
      .map(([pattern, tenants]) => ({ pattern, tenants }))
      .sort((a, b) => patternSpecificity(b.pattern) - patternSpecificity(a.pattern) || a.pattern.localeCompare(b.pattern));

    return { exact, patterns };
  }

  /**
   * An allow-all (`*`) row means every origin is admitted for its
   * granted tenant(s) (under union, literally every origin, not just
   * ones nothing more specific matched). That is a legitimate, deliberate
   * owner decision, but an operator must never have to read the database to
   * discover the platform is in that state — so this logs at `warn` on
   * EVERY successful refresh, not just the first time the row appears, for
   * exactly the same reason `refresh()`'s own success log runs
   * unconditionally on every call rather than only on a change.
   *
   * A `*` row can now be granted to MULTIPLE tenants (same
   * many-to-many model as any other origin) — this reports ALL of them, not
   * a single `ownerTenantId`.
   */
  private warnIfAllowAllPresent(patterns: readonly PatternIndexEntry[]): void {
    const allowAllEntry = patterns.find((entry) => entry.pattern === ALLOW_ALL_ORIGIN_PATTERN);
    if (allowAllEntry === undefined) {
      return;
    }

    const ownerTenantIds = [...allowAllEntry.tenants].sort();
    this.logger.warn({
      message: `Origin registry contains an allow-all ('*') row owned by tenant(s) ${ownerTenantIds.join(', ')}; every origin is admitted for ${ownerTenantIds.length === 1 ? 'that tenant' : 'these tenants'}.`,
      ownerTenantIds,
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
   * `tenantsFor()` / `allows()` (the CORS callback, the WS handshake, the
   * tenant-binding guard) feed this a raw, attacker-controlled `Origin`
   * header. An unparseable origin is simply "not registered" — returning
   * `null` (and therefore the empty set / `false`) — never a thrown
   * exception that could turn a hostile or malformed header into an
   * unhandled 500.
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
