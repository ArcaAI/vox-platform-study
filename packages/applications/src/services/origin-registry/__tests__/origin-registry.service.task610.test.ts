// TASK-610 lane W2-A — OriginRegistryService tests (T-3).
//
// Written FIRST per `01-development-workflow.md` TDD gate: this file must be
// run and observed RED (the implementation module does not exist yet) before
// `../origin-registry.service.ts` is written.
//
// Covers, per the W2-A brief:
//  - initial load (onModuleInit)
//  - rebuild wired to BOTH invalidation events (§4.1 frozen contract)
//  - stale index preserved on a failed refresh (never emptied by an error)
//  - duplicate-origin-across-tenants determinism (T-3)
//  - soft-deleted rows excluded from the index
//  - a malformed lookup returns null/false rather than throwing
//  - the cross-tenant visibility property (the §3.3 HAZARD this lane exists to prove)
//
// REOPENED — adversarial review (W4-R) confirmed a HIGH defect: `refresh()`
// was wired DIRECTLY to `@OnEvent`, but both invalidation events are emitted
// SYNCHRONOUSLY from inside a write request (`TenantAllowedOriginService`,
// `AppSettingsService.handleGlobalSettingUpdated`). `@nestjs/event-emitter`
// dispatches listeners on the same call stack as `.emit()`, so `refresh()`
// ran inside the writing request's CLS store — the exact thing its own
// HAZARD comment says must never happen. The fix moves the two `@OnEvent`
// decorators onto a new `onInvalidationEvent()` wrapper that calls
// `ClsService#exit()` before invoking `refresh()`. The
// "invalidation event handler runs outside the request CLS scope" describe
// block below is the regression test for this — it uses a REAL `ClsModule`
// + REAL `EventEmitterModule` + the REAL service, because a mocked
// repository cannot observe CLS narrowing (that is exactly why the original
// 19 tests below passed against the broken code).

import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { CronExpression } from '@nestjs/schedule';
import { ClsModule, ClsService } from 'nestjs-cls';
import { ResourceStatusType, TenantAllowedOriginEntity, TenantAllowedOriginRepository } from '@arcaai/domains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OriginRegistryService } from '../origin-registry.service';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const TENANT_A = '10000000-0000-0000-0000-000000000001';
const TENANT_B = '20000000-0000-0000-0000-000000000002';

/** A minimal `ClsService` stand-in for the unit tests below that construct
 * `OriginRegistryService` directly with a mocked repository. None of those
 * tests call `onInvalidationEvent()` (they call `refresh()` directly, which
 * never touches `cls`), so `isActive()`/`exit()` are never actually invoked
 * there — this stub only exists to satisfy the constructor signature. The
 * REAL CLS behavior is exercised separately, against a REAL `ClsService`, in
 * the "invalidation event handler runs outside the request CLS scope"
 * block below. */
function makeClsStub() {
  return {
    isActive: vi.fn().mockReturnValue(false),
    exit: vi.fn((callback: () => unknown) => callback()),
  };
}

let idCounter = 0;

/** Builds a real `TenantAllowedOriginEntity` — no `@arcaai/domains` mocking needed, this is a plain aggregate. */
function makeRow(overrides: {
  id?: string;
  tenantId?: string;
  origin?: string;
  label?: string;
  resourceStatus?: ResourceStatusType;
} = {}): TenantAllowedOriginEntity {
  idCounter += 1;
  // Zero-padded so default ids sort exactly in call order — lets tests that
  // don't care about ordering still get deterministic behavior for free.
  const defaultId = `00000000-0000-7000-8000-${String(idCounter).padStart(12, '0')}`;
  const now = new Date();

  return new TenantAllowedOriginEntity({
    id: overrides.id ?? defaultId,
    tenantId: overrides.tenantId ?? SYSTEM_TENANT_ID,
    origin: overrides.origin ?? 'https://example.org',
    label: overrides.label ?? 'Example',
    description: null,
    resourceStatus: overrides.resourceStatus ?? ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    createdBy: null,
    updatedBy: null,
    createdAt: now,
    updatedAt: now,
    version: 1,
  });
}

describe('OriginRegistryService', () => {
  let mockRepository: { findAll: ReturnType<typeof vi.fn> };
  let service: OriginRegistryService;

  beforeEach(() => {
    idCounter = 0;
    mockRepository = { findAll: vi.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new OriginRegistryService(mockRepository as any, makeClsStub() as any);
  });

  describe('initial load', () => {
    it('starts empty and populates the index from onModuleInit', async () => {
      expect(service.size()).toBe(0);

      mockRepository.findAll.mockResolvedValue([makeRow({ origin: 'https://x.org', tenantId: SYSTEM_TENANT_ID })]);

      await service.onModuleInit();

      expect(mockRepository.findAll).toHaveBeenCalledWith({});
      expect(service.size()).toBe(1);
      expect(service.has('https://x.org')).toBe(true);
      expect(service.ownerOf('https://x.org')).toBe(SYSTEM_TENANT_ID);
    });
  });

  describe('invalidation wiring (§4.1 frozen contract)', () => {
    it('onInvalidationEvent() is wired to BOTH origin-registry.invalidate and app-settings.cache-refreshed', () => {
      // NOTE: the listener is `onInvalidationEvent()`, NOT `refresh()`.
      // `refresh()` must NOT carry `@OnEvent` directly — see the CONFIRMED
      // DEFECT this reopened lane closes: both events are emitted
      // synchronously from inside a write request, so a listener wired
      // straight to `refresh()` would run inside that request's CLS store.
      const metadata = Reflect.getMetadata(
        'EVENT_LISTENER_METADATA',
        OriginRegistryService.prototype.onInvalidationEvent,
      ) as Array<{ event: string }> | undefined;

      expect(metadata).toBeDefined();
      const events = (metadata ?? []).map((m) => m.event);
      expect(events).toContain('origin-registry.invalidate');
      expect(events).toContain('app-settings.cache-refreshed');

      // And `refresh()` itself must carry NO event metadata — it stays a
      // pure, directly-callable operation.
      const refreshMetadata = Reflect.getMetadata('EVENT_LISTENER_METADATA', OriginRegistryService.prototype.refresh);
      expect(refreshMetadata).toBeUndefined();
    });

    it('rebuilds the index every time refresh() runs — the same handler both events invoke', async () => {
      mockRepository.findAll.mockResolvedValueOnce([makeRow({ origin: 'https://one.org' })]);
      await service.refresh();
      expect(service.has('https://one.org')).toBe(true);
      expect(service.has('https://two.org')).toBe(false);

      mockRepository.findAll.mockResolvedValueOnce([makeRow({ origin: 'https://two.org' })]);
      await service.refresh();
      expect(service.has('https://two.org')).toBe(true);
      expect(service.has('https://one.org')).toBe(false);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // FOLLOW-UP — adversarial review (W4-R), MEDIUM finding: propagation is
  // entirely event-driven, and `AppSettingsService` only emits its
  // `app-settings.cache-refreshed` relay on the SUCCESS path (a failed
  // AppSettings refresh emits `app-settings.cache-error` and rethrows
  // instead). If AppSettings caching fails persistently, this registry would
  // never hear either invalidation event again on any node, and a REVOKED
  // origin would stay live indefinitely with nothing surfacing that fact.
  // Fix: an independent `@Cron` backstop + staleness tracking exposed off
  // every failure log and via `getLastSuccessfulRefreshAt()`.
  // ═════════════════════════════════════════════════════════════════════
  describe('backstop @Cron refresh (adversarial review — MEDIUM finding)', () => {
    it('scheduledRefresh() is wired via @Cron(EVERY_30_SECONDS)', () => {
      // `SCHEDULE_CRON_OPTIONS` is the metadata key `@nestjs/schedule`'s
      // `@Cron` decorator sets (`SetMetadata(SCHEDULE_CRON_OPTIONS, { ...options, cronTime })`)
      // — its presence, with our chosen interval, is genuine proof of
      // `@Cron` wiring, the same style as the `@OnEvent` metadata check
      // above.
      const cronOptions = Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', OriginRegistryService.prototype.scheduledRefresh) as
        | { cronTime?: string; name?: string }
        | undefined;

      expect(cronOptions).toBeDefined();
      expect(cronOptions?.cronTime).toBe(CronExpression.EVERY_30_SECONDS);
      expect(cronOptions?.name).toBe('origin-registry-backstop-refresh');
    });

    it('scheduledRefresh() triggers a refresh independently — no event, no emitter, involved at all', async () => {
      // This test never constructs an `EventEmitter2` or emits anything —
      // proving the scheduled path does not depend on the event bus by
      // construction, not just by assertion.
      mockRepository.findAll.mockResolvedValueOnce([makeRow({ origin: 'https://backstop.org', tenantId: TENANT_A })]);

      await service.scheduledRefresh();

      expect(mockRepository.findAll).toHaveBeenCalledWith({});
      expect(service.has('https://backstop.org')).toBe(true);
      expect(service.ownerOf('https://backstop.org')).toBe(TENANT_A);
    });

    it('scheduledRefresh() routes through onInvalidationEvent() — exactly one guarded path into refresh()', async () => {
      // Spy on the shared entry point rather than re-deriving CLS behavior:
      // proving `scheduledRefresh` delegates to it is what guarantees the
      // timer inherits the SAME `cls.exit()` guard, with no second place to
      // reintroduce the CLS defect fixed earlier in this file.
      const spy = vi.spyOn(service, 'onInvalidationEvent');
      mockRepository.findAll.mockResolvedValueOnce([]);

      await service.scheduledRefresh();

      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });
  });

  describe('staleness tracking (adversarial review — MEDIUM finding)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('getLastSuccessfulRefreshAt() is null until the first successful refresh, then a Date', async () => {
      expect(service.getLastSuccessfulRefreshAt()).toBeNull();

      mockRepository.findAll.mockResolvedValueOnce([]);
      await service.refresh();

      expect(service.getLastSuccessfulRefreshAt()).toBeInstanceOf(Date);
    });

    it('a failed refresh does NOT advance getLastSuccessfulRefreshAt()', async () => {
      mockRepository.findAll.mockResolvedValueOnce([]);
      await service.refresh();
      const firstSuccess = service.getLastSuccessfulRefreshAt();

      mockRepository.findAll.mockRejectedValueOnce(new Error('db down'));
      await service.refresh();

      expect(service.getLastSuccessfulRefreshAt()).toBe(firstSuccess);
    });

    it('reports neverSucceeded: true when the very first refresh fails', async () => {
      const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      mockRepository.findAll.mockRejectedValueOnce(new Error('db unreachable from boot'));

      await service.refresh();

      expect(errorSpy).toHaveBeenCalledWith(expect.objectContaining({ neverSucceeded: true }));
      // And staleForMs must NOT appear alongside it — there is no "since"
      // to measure from yet.
      const [call] = errorSpy.mock.calls;
      expect(call[0]).not.toHaveProperty('staleForMs');

      errorSpy.mockRestore();
    });

    it('logs staleForMs — greppable/alertable staleness — on a failure following a prior success', async () => {
      vi.useFakeTimers();
      const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      mockRepository.findAll.mockResolvedValueOnce([]);
      await service.refresh();

      vi.advanceTimersByTime(120_000); // 2 minutes of simulated staleness

      mockRepository.findAll.mockRejectedValueOnce(new Error('db unreachable again'));
      await service.refresh();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Failed to load allowed origins from the database — keeping the previous origin registry index',
          staleForMs: expect.any(Number),
        }),
      );
      const staleCall = errorSpy.mock.calls.find((call) => (call[0] as Record<string, unknown>).staleForMs !== undefined);
      expect((staleCall?.[0] as Record<string, unknown>).staleForMs).toBeGreaterThanOrEqual(120_000);

      errorSpy.mockRestore();
    });

    it('also reports staleForMs when the index-BUILD step fails (not just the DB read)', async () => {
      vi.useFakeTimers();
      const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      mockRepository.findAll.mockResolvedValueOnce([]);
      await service.refresh();

      vi.advanceTimersByTime(45_000);

      // Force the build step to throw: a row whose `.origin` getter throws
      // is the simplest way to make `buildIndex()`'s synchronous body fail
      // without touching its internals.
      const poisonedRow = makeRow({ origin: 'https://poison.org' });
      Object.defineProperty(poisonedRow, 'origin', {
        get() {
          throw new Error('poisoned row');
        },
      });
      mockRepository.findAll.mockResolvedValueOnce([poisonedRow]);

      await service.refresh();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Failed to build the origin registry index from loaded rows — keeping the previous index',
          staleForMs: expect.any(Number),
        }),
      );

      errorSpy.mockRestore();
    });
  });

  describe('robustness — a failed refresh never crashes and never empties a good index', () => {
    it('keeps the previous index when the repository read throws', async () => {
      mockRepository.findAll.mockResolvedValueOnce([makeRow({ origin: 'https://good.org', tenantId: TENANT_A })]);
      await service.refresh();
      expect(service.size()).toBe(1);
      expect(service.ownerOf('https://good.org')).toBe(TENANT_A);

      mockRepository.findAll.mockRejectedValueOnce(new Error('database unreachable'));

      await expect(service.refresh()).resolves.toBeUndefined();

      // Stale-but-good index preserved, not wiped.
      expect(service.size()).toBe(1);
      expect(service.ownerOf('https://good.org')).toBe(TENANT_A);
    });

    it('logs the failure rather than throwing out of refresh()', async () => {
      const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      mockRepository.findAll.mockRejectedValueOnce(new Error('boom'));

      await expect(service.refresh()).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();

      errorSpy.mockRestore();
    });
  });

  describe('duplicate origin across tenants (T-3)', () => {
    it('keeps a deterministic winner (earliest-created row) and logs the conflict loudly with both tenant ids', async () => {
      const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      const earlier = makeRow({ id: '00000000-0000-7000-8000-000000000001', origin: 'https://contested.org', tenantId: TENANT_A });
      const later = makeRow({ id: '00000000-0000-7000-8000-000000000002', origin: 'https://contested.org', tenantId: TENANT_B });

      // Feed them in the "wrong" order (later row first) to prove the winner
      // is decided by sorting, not by array/DB return order.
      mockRepository.findAll.mockResolvedValueOnce([later, earlier]);
      await service.refresh();

      expect(service.ownerOf('https://contested.org')).toBe(TENANT_A);
      expect(service.size()).toBe(1);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          origin: 'https://contested.org',
          keptOwnerTenantId: TENANT_A,
          discardedOwnerTenantId: TENANT_B,
        }),
      );

      errorSpy.mockRestore();
    });

    it('is deterministic regardless of which order the rows are returned in', async () => {
      const earlier = makeRow({ id: '00000000-0000-7000-8000-000000000001', origin: 'https://contested.org', tenantId: TENANT_A });
      const later = makeRow({ id: '00000000-0000-7000-8000-000000000002', origin: 'https://contested.org', tenantId: TENANT_B });

      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      mockRepository.findAll.mockResolvedValueOnce([earlier, later]);
      await service.refresh();
      const winnerOrderA = service.ownerOf('https://contested.org');

      mockRepository.findAll.mockResolvedValueOnce([later, earlier]);
      await service.refresh();
      const winnerOrderB = service.ownerOf('https://contested.org');

      expect(winnerOrderA).toBe(TENANT_A);
      expect(winnerOrderB).toBe(TENANT_A);

      vi.restoreAllMocks();
    });
  });

  describe('soft-deleted rows', () => {
    it('excludes a DELETED row from the index even if the repository returned it', async () => {
      mockRepository.findAll.mockResolvedValueOnce([
        makeRow({ origin: 'https://live.org', resourceStatus: ResourceStatusType.ENABLED }),
        makeRow({ origin: 'https://removed.org', resourceStatus: ResourceStatusType.DELETED }),
      ]);

      await service.refresh();

      expect(service.has('https://live.org')).toBe(true);
      expect(service.has('https://removed.org')).toBe(false);
      expect(service.ownerOf('https://removed.org')).toBeNull();
      expect(service.size()).toBe(1);
    });
  });

  describe('malformed lookups never throw', () => {
    beforeEach(async () => {
      mockRepository.findAll.mockResolvedValueOnce([makeRow({ origin: 'https://good.org' })]);
      await service.refresh();
    });

    it.each([['not a url'], [''], ['   '], ['ftp://x.org'], ['https://*'], ['https://x.org/path'], ['null'], ['undefined']])(
      'has(%j) returns false, ownerOf(%j) returns null — no throw',
      (raw) => {
        expect(() => service.has(raw)).not.toThrow();
        expect(() => service.ownerOf(raw)).not.toThrow();
        expect(service.has(raw)).toBe(false);
        expect(service.ownerOf(raw)).toBeNull();
      },
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately hostile non-string input
    it('tolerates a non-string origin argument without throwing', () => {
      expect(() => service.has(null as any)).not.toThrow();
      expect(() => service.ownerOf(undefined as any)).not.toThrow();
    });
  });

  describe('cross-tenant visibility (the §3.3 HAZARD this lane exists to prove)', () => {
    it('calls findAll with an EMPTY filter (no tenantId), and the resulting index holds every tenant’s origins simultaneously', async () => {
      mockRepository.findAll.mockResolvedValueOnce([
        makeRow({ origin: 'https://platform.example', tenantId: SYSTEM_TENANT_ID }),
        makeRow({ origin: 'https://tenant-a.example', tenantId: TENANT_A }),
        makeRow({ origin: 'https://tenant-b.example', tenantId: TENANT_B }),
      ]);

      await service.refresh();

      // The call itself carries no tenant filter — this is what makes the
      // read a pass-through under the tenant-scope Prisma extension when
      // (and ONLY when) there is no CLS tenant context in flight. See the
      // HAZARD comment on `refresh()` in the implementation.
      expect(mockRepository.findAll).toHaveBeenCalledWith({});

      // All three tenants' origins are visible in ONE index at once — proof
      // this is a genuine cross-tenant reverse index, not one scoped to a
      // single caller.
      expect(service.size()).toBe(3);
      expect(service.ownerOf('https://platform.example')).toBe(SYSTEM_TENANT_ID);
      expect(service.ownerOf('https://tenant-a.example')).toBe(TENANT_A);
      expect(service.ownerOf('https://tenant-b.example')).toBe(TENANT_B);
    });
  });

  describe('has()/ownerOf() normalize the lookup key', () => {
    it('matches case-insensitively and via the same canonical form origins are stored in', async () => {
      mockRepository.findAll.mockResolvedValueOnce([makeRow({ origin: 'https://x.org:443'.replace(':443', '') })]);
      // Stored canonical form has the default port stripped already (per
      // normalizeOrigin); a lookup that still carries the default port must
      // still resolve.
      await service.refresh();

      expect(service.has('HTTPS://X.ORG')).toBe(true);
      expect(service.has('https://x.org:443')).toBe(true);
      expect(service.ownerOf('https://x.org:443')).toBe(SYSTEM_TENANT_ID);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // TASK-610 §4A.2 — wildcard pattern precedence (lane W5-B).
  //
  // These are the three rows the plan (§4A.2, "Required behavior" table)
  // names explicitly. Against the CURRENT exact-only implementation, a
  // pattern row is stored as a literal Map key (e.g. the key
  // `'https://*.bcmch.org:*'` or `'*'`), so a real browser Origin like
  // `https://anything.bcmch.org` or `https://random.example.com` never
  // matches it — `ownerOf` returns `null` where these tests expect a
  // tenant id. That is the RED this file must show before the precedence
  // walk is implemented.
  // ═════════════════════════════════════════════════════════════════════
  describe('wildcard pattern precedence (§4A.2 / §4A.3)', () => {
    const ARCAAI_TENANT_ID = '30000000-0000-0000-0000-000000000003';
    const GLOBAL_TENANT_ID = '50000000-0000-0000-0000-000000000000';

    async function seedPrecedenceRows() {
      mockRepository.findAll.mockResolvedValueOnce([
        makeRow({ origin: 'https://arcaai-u2204.bcmch.org', tenantId: ARCAAI_TENANT_ID }),
        makeRow({ origin: 'https://*.bcmch.org:*', tenantId: ARCAAI_TENANT_ID }),
        makeRow({ origin: '*', tenantId: GLOBAL_TENANT_ID }),
      ]);
      await service.refresh();
    }

    it('an exact row resolves to its owner — exact beats any pattern (never even consulted)', async () => {
      await seedPrecedenceRows();

      expect(service.ownerOf('https://arcaai-u2204.bcmch.org')).toBe(ARCAAI_TENANT_ID);
      expect(service.has('https://arcaai-u2204.bcmch.org')).toBe(true);
    });

    it('a more specific pattern (`https://*.bcmch.org:*`) outranks the `*` allow-all token', async () => {
      await seedPrecedenceRows();

      // Not itself a registered exact row — must resolve via the more
      // specific bcmch.org pattern, never the lower-ranked `*` token.
      expect(service.ownerOf('https://anything.bcmch.org')).toBe(ARCAAI_TENANT_ID);
      expect(service.has('https://anything.bcmch.org')).toBe(true);
    });

    it('an origin matching only `*` resolves to the Global tenant', async () => {
      await seedPrecedenceRows();

      expect(service.ownerOf('https://random.example.com')).toBe(GLOBAL_TENANT_ID);
      expect(service.has('https://random.example.com')).toBe(true);
    });

    it('an origin matching nothing at all (no `*` row registered) stays unregistered', async () => {
      mockRepository.findAll.mockResolvedValueOnce([
        makeRow({ origin: 'https://arcaai-u2204.bcmch.org', tenantId: ARCAAI_TENANT_ID }),
        makeRow({ origin: 'https://*.bcmch.org:*', tenantId: ARCAAI_TENANT_ID }),
      ]);
      await service.refresh();

      expect(service.ownerOf('https://random.example.com')).toBeNull();
      expect(service.has('https://random.example.com')).toBe(false);
    });

    it('size() counts pattern rows alongside exact rows', async () => {
      await seedPrecedenceRows();

      expect(service.size()).toBe(3);
    });

    it('a subdomain-of-a-subdomain still matches (any depth, never the apex)', async () => {
      mockRepository.findAll.mockResolvedValueOnce([makeRow({ origin: 'https://*.bcmch.org:*', tenantId: ARCAAI_TENANT_ID })]);
      await service.refresh();

      expect(service.ownerOf('https://deep.sub.bcmch.org')).toBe(ARCAAI_TENANT_ID);
      // The apex itself must NOT match — that is `matchesOriginPattern`'s
      // contract, exercised here through the registry's own lookup path.
      expect(service.ownerOf('https://bcmch.org')).toBeNull();
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // TASK-610 §4A.3 — the allow-all (`*`) row must announce itself. An
  // operator must never have to read the database to discover the platform
  // is admitting every unmatched origin for one tenant.
  // ═════════════════════════════════════════════════════════════════════
  describe('allow-all (`*`) row announces itself on every successful refresh (§4A.3)', () => {
    const GLOBAL_TENANT_ID = '50000000-0000-0000-0000-000000000000';

    it('logs at warn with the owning tenant id when a `*` row is present', async () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      mockRepository.findAll.mockResolvedValueOnce([makeRow({ origin: '*', tenantId: GLOBAL_TENANT_ID })]);
      await service.refresh();

      expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({ ownerTenantId: GLOBAL_TENANT_ID }));
      const [warnCall] = warnSpy.mock.calls;
      const logged = warnCall[0] as Record<string, unknown>;
      expect(String(logged.message)).toContain(GLOBAL_TENANT_ID);
      expect(String(logged.message)).toMatch(/allow-all/i);

      warnSpy.mockRestore();
    });

    it('logs again on a SECOND successful refresh — not just once at startup', async () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      mockRepository.findAll.mockResolvedValue([makeRow({ origin: '*', tenantId: GLOBAL_TENANT_ID })]);
      await service.refresh();
      await service.refresh();

      expect(warnSpy).toHaveBeenCalledTimes(2);

      warnSpy.mockRestore();
    });

    it('does NOT log the allow-all warning when no `*` row is registered', async () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      mockRepository.findAll.mockResolvedValueOnce([makeRow({ origin: 'https://example.org' })]);
      await service.refresh();

      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// REOPENED — adversarial regression (confirmed defect, see file header).
//
// A mocked repository (the `describe('OriginRegistryService', ...)` block
// above) CANNOT observe CLS narrowing: `mockRepository.findAll` never looks
// at the CLS store, so it returns the same rows whether or not a store is
// active. That is exactly why the 19 tests above passed while `refresh()`
// was wired directly to `@OnEvent` and running inside the emitting
// request's CLS store. This block uses a REAL `ClsModule`, a REAL
// `EventEmitterModule`, and the REAL `OriginRegistryService` wired through
// Nest DI, so the actual dispatch path production uses is exercised.
// ═══════════════════════════════════════════════════════════════════════
describe('invalidation event handler runs outside the request CLS scope (adversarial regression)', () => {
  async function buildRealModule(repositoryStub: { findAll: ReturnType<typeof vi.fn> }) {
    const moduleRef = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot(), ClsModule.forRoot()],
      providers: [
        { provide: TenantAllowedOriginRepository, useValue: repositoryStub },
        // Explicit factory + `inject` rather than plain constructor
        // injection: Vitest's esbuild-based TS transform does not emit
        // `design:paramtypes` decorator metadata (verified directly — a
        // plain-constructor provider resolves to `undefined` here even
        // though the exact same pattern works in the real, tsc-built app,
        // which has `emitDecoratorMetadata: true` per
        // `@arcaai/config-ts/nestjs.json`). `useFactory`/`inject` sidesteps
        // reflection entirely, and works unchanged whether the constructor
        // takes one arg or two — which is also what lets this SAME setup
        // prove the regression fails against the pre-fix constructor shape.
        {
          provide: OriginRegistryService,
          useFactory: (repo: TenantAllowedOriginRepository, cls: ClsService) => new OriginRegistryService(repo, cls),
          inject: [TenantAllowedOriginRepository, ClsService],
        },
      ],
    }).compile();

    // `.init()` runs Nest lifecycle hooks: `OnModuleInit` (the service's own
    // `onModuleInit` → an initial, CLS-free `refresh()` — the known-safe
    // path) AND `OnApplicationBootstrap`, which is what `@nestjs/event-emitter`
    // uses (`EventSubscribersLoader`) to actually wire `@OnEvent`-decorated
    // methods onto the shared `EventEmitter2` instance. Skipping `.init()`
    // would leave `emitter.emit(...)` below with no listeners at all, and
    // the test would pass for the wrong reason (nothing would run).
    await moduleRef.init();

    return {
      service: moduleRef.get(OriginRegistryService),
      cls: moduleRef.get(ClsService),
      emitter: moduleRef.get(EventEmitter2),
    };
  }

  it('findAll() sees NO active CLS store when origin-registry.invalidate is emitted synchronously from inside a request-like CLS run', async () => {
    const repositoryStub = { findAll: vi.fn().mockResolvedValue([]) };
    const { cls, emitter } = await buildRealModule(repositoryStub);

    // Record what the CLS context looks like at the EXACT moment
    // `findAll()` runs (i.e. inside `refresh()`, mid-"request").
    let observedIsActive: boolean | 'not called' = 'not called';
    let observedTenantId: unknown = 'not called';
    repositoryStub.findAll.mockImplementation(async () => {
      observedIsActive = cls.isActive();
      observedTenantId = cls.get('tenantId');
      return [];
    });

    // Reproduce the production shape EXACTLY: an active CLS store carrying
    // an acting tenant (as a real request would), which SYNCHRONOUSLY emits
    // the invalidation event mid-request — precisely what
    // `TenantAllowedOriginService`/`AppSettingsService.handleGlobalSettingUpdated`
    // do (see the service's CONFIRMED DEFECT comment).
    cls.run(() => {
      cls.set('tenantId' as never, TENANT_A);
      expect(cls.isActive()).toBe(true); // sanity: the simulated "request" really is CLS-active
      emitter.emit('origin-registry.invalidate');
    });

    // The listener's synchronous prefix (through `cls.exit()` into
    // `refresh()`'s call to `repository.findAll({})`) already ran inside
    // `cls.run()` above. This just lets any remaining async continuation
    // settle before the test exits, so nothing leaks into the next test.
    await new Promise((resolve) => setImmediate(resolve));

    expect(observedIsActive).toBe(false);
    expect(observedTenantId).toBeUndefined();
  });

  it('findAll() likewise sees no active CLS store for app-settings.cache-refreshed', async () => {
    const repositoryStub = { findAll: vi.fn().mockResolvedValue([]) };
    const { cls, emitter } = await buildRealModule(repositoryStub);

    let observedIsActive: boolean | 'not called' = 'not called';
    repositoryStub.findAll.mockImplementation(async () => {
      observedIsActive = cls.isActive();
      return [];
    });

    cls.run(() => {
      cls.set('tenantId' as never, TENANT_B);
      emitter.emit('app-settings.cache-refreshed');
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(observedIsActive).toBe(false);
  });

  it('a mutation-triggered invalidation rebuilds a FULL multi-tenant index, not just the acting tenant\'s rows', async () => {
    const allRows = [
      makeRow({ origin: 'https://platform.example', tenantId: SYSTEM_TENANT_ID }),
      makeRow({ origin: 'https://tenant-a.example', tenantId: TENANT_A }),
      makeRow({ origin: 'https://tenant-b.example', tenantId: TENANT_B }),
    ];
    const repositoryStub = { findAll: vi.fn().mockResolvedValue(allRows) };
    const { service, cls, emitter } = await buildRealModule(repositoryStub);

    // Rewire the stub to the REAL tenant-scope Prisma extension's contract
    // (`packages/database/src/extensions/tenant-scope.ts`, `makeReadHandler`):
    // when a CLS tenant context is active, a read against a
    // `TENANT_SCOPED_MODEL` is narrowed to that tenant's rows; with no CLS
    // context, it passes through untouched. This is what makes the test
    // actually DISCRIMINATE the defect (rather than just exercise the happy
    // path): against the broken code (`refresh()` wired directly to
    // `@OnEvent`), the emit below fires with TENANT_A's CLS store still
    // active, so this stub would return only TENANT_A's row and the index
    // would end up with size 1 — not 3.
    repositoryStub.findAll.mockImplementation(async () => {
      if (cls.isActive()) {
        const tenantId = cls.get('tenantId');
        return allRows.filter((row) => row.tenantId === tenantId);
      }
      return allRows;
    });

    await new Promise<void>((resolve) => {
      cls.run(() => {
        cls.set('tenantId' as never, TENANT_A); // the "acting tenant" of the simulated write request
        emitter.emit('origin-registry.invalidate');
        resolve();
      });
    });

    // Let `refresh()`'s async continuation (now CLS-detached, if the fix is
    // in place) finish rebuilding the index before asserting on it.
    await new Promise((resolve) => setImmediate(resolve));

    expect(service.size()).toBe(3);
    expect(service.ownerOf('https://platform.example')).toBe(SYSTEM_TENANT_ID);
    // The defect, if present, would make ONLY TENANT_A's origin visible here
    // — asserting all three tenants' rows landed in the index is what
    // distinguishes "fixed" from "narrowed to the acting tenant".
    expect(service.ownerOf('https://tenant-a.example')).toBe(TENANT_A);
    expect(service.ownerOf('https://tenant-b.example')).toBe(TENANT_B);
  });

  // Follow-up (adversarial review, MEDIUM finding): the `@Cron` backstop
  // routes through `onInvalidationEvent()` — the same assertion style as the
  // event-emitted regression tests above, but invoking the SCHEDULED entry
  // point directly (a real cron tick has no CLS store to begin with; this
  // proves the guard holds it were ever invoked with one anyway — defense in
  // depth, not a realistic scenario).
  it('scheduledRefresh() (the @Cron backstop) also sees NO active CLS store, even if invoked while one is active', async () => {
    const repositoryStub = { findAll: vi.fn().mockResolvedValue([]) };
    const { service, cls } = await buildRealModule(repositoryStub);

    let observedIsActive: boolean | 'not called' = 'not called';
    repositoryStub.findAll.mockImplementation(async () => {
      observedIsActive = cls.isActive();
      return [];
    });

    cls.run(() => {
      cls.set('tenantId' as never, TENANT_A);
      // No `.emit(...)` anywhere in this test — the timer path does not go
      // through the event bus at all.
      void service.scheduledRefresh();
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(observedIsActive).toBe(false);
  });
});
