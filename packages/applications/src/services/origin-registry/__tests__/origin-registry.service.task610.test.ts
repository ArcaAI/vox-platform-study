// OriginRegistryService tests (T-3).
// UPDATED — many-to-many origins ↔ tenants; resolution is
// now a UNION, `ownerOf` is REMOVED in favor of `tenantsFor`/`allows`.
//
// Written FIRST per `01-development-workflow.md` TDD gate: this file must be
// run and observed RED against the OLD single-owner implementation (which
// has no `tenantsFor`/`allows` and still exposes `ownerOf`) before
// `../origin-registry.service.ts` is rewritten to the union contract.
//
// Covers, per the W6-B brief:
//  - initial load (onModuleInit)
//  - rebuild wired to BOTH invalidation events (frozen contract)
//  - stale index preserved on a failed refresh (never emptied by an error)
//  - many-to-many union resolution — REPLACES the old T-3
//    duplicate-origin-is-an-error test; two tenants sharing one origin is now
//    normal, expected data, not a conflict to log and pick a winner for
//  - soft-deleted rows excluded from the index
//  - a malformed lookup returns an empty set / false rather than throwing
//  - the cross-tenant visibility property (the HAZARD this lane exists to prove)
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
// tests below passed against the broken code). This machinery is preserved
// UNCHANGED by the rewrite — only origin↔tenant resolution changed.

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
const TENANT_C = '30000000-0000-0000-0000-000000000003';

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
function makeRow(
  overrides: {
    id?: string;
    tenantId?: string;
    origin?: string;
    label?: string;
    resourceStatus?: ResourceStatusType;
  } = {},
): TenantAllowedOriginEntity {
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

/** Sorted array helper — set membership order is not meaningful, but a
 * stable array makes assertions readable and deterministic. */
function sorted(set: ReadonlySet<string>): string[] {
  return [...set].sort();
}

describe('OriginRegistryService', () => {
  let mockRepository: { findAll: ReturnType<typeof vi.fn> };
  let service: OriginRegistryService;

  beforeEach(() => {
    idCounter = 0;
    mockRepository = { findAll: vi.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only mock/stub shapes, not the real constructor types
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
      expect(sorted(service.tenantsFor('https://x.org'))).toEqual([SYSTEM_TENANT_ID]);
    });
  });

  describe('invalidation wiring (frozen contract)', () => {
    it('onInvalidationEvent() is wired to BOTH origin-registry.invalidate and app-settings.cache-refreshed', () => {
      // NOTE: the listener is `onInvalidationEvent()`, NOT `refresh()`.
      // `refresh()` must NOT carry `@OnEvent` directly — see the CONFIRMED
      // DEFECT this reopened lane closes: both events are emitted
      // synchronously from inside a write request, so a listener wired
      // straight to `refresh()` would run inside that request's CLS store.
      const metadata = Reflect.getMetadata('EVENT_LISTENER_METADATA', OriginRegistryService.prototype.onInvalidationEvent) as
        Array<{ event: string }> | undefined;

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
        { cronTime?: string; name?: string } | undefined;

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
      expect(sorted(service.tenantsFor('https://backstop.org'))).toEqual([TENANT_A]);
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
      expect(sorted(service.tenantsFor('https://good.org'))).toEqual([TENANT_A]);

      mockRepository.findAll.mockRejectedValueOnce(new Error('database unreachable'));

      await expect(service.refresh()).resolves.toBeUndefined();

      // Stale-but-good index preserved, not wiped.
      expect(service.size()).toBe(1);
      expect(sorted(service.tenantsFor('https://good.org'))).toEqual([TENANT_A]);
    });

    it('logs the failure rather than throwing out of refresh()', async () => {
      const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      mockRepository.findAll.mockRejectedValueOnce(new Error('boom'));

      await expect(service.refresh()).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();

      errorSpy.mockRestore();
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // Many-to-many union resolution. REPLACES the old T-3
  // "duplicate origin across tenants is an error, keep a deterministic
  // winner" test outright: under the many-to-many model two tenants sharing
  // one origin is NORMAL, EXPECTED data (the DB constraint moved from a
  // global unique on `origin` to a unique on `(origin, tenantId)`), not a
  // conflict to log at `error` and pick a winner for. There is no more
  // `logger.error` call anywhere in this file for this case — asserted
  // explicitly below.
  // ═════════════════════════════════════════════════════════════════════
  describe('many-to-many union resolution (supersedes single-owner precedence)', () => {
    it('one origin granted to TWO tenants → tenantsFor returns both; allows() is true for each; false for a third', async () => {
      mockRepository.findAll.mockResolvedValueOnce([
        makeRow({ origin: 'http://localhost:5173', tenantId: TENANT_A }),
        makeRow({ origin: 'http://localhost:5173', tenantId: TENANT_B }),
      ]);

      await service.refresh();

      expect(sorted(service.tenantsFor('http://localhost:5173'))).toEqual([TENANT_A, TENANT_B].sort());
      expect(service.allows('http://localhost:5173', TENANT_A)).toBe(true);
      expect(service.allows('http://localhost:5173', TENANT_B)).toBe(true);
      expect(service.allows('http://localhost:5173', TENANT_C)).toBe(false);
      // Two grant rows for one origin collapse to ONE distinct registered
      // origin string — size() counts origins, not grants (see IOriginRegistry doc).
      expect(service.size()).toBe(1);
    });

    it('does NOT log an error for a shared origin — this is expected data, not a conflict', async () => {
      const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      mockRepository.findAll.mockResolvedValueOnce([
        makeRow({ origin: 'https://shared.example', tenantId: TENANT_A }),
        makeRow({ origin: 'https://shared.example', tenantId: TENANT_B }),
      ]);

      await service.refresh();

      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it('a SYSTEM grant on an origin → allows() is true for ANY tenant', async () => {
      mockRepository.findAll.mockResolvedValueOnce([makeRow({ origin: 'https://platform.example', tenantId: SYSTEM_TENANT_ID })]);

      await service.refresh();

      expect(service.allows('https://platform.example', TENANT_A)).toBe(true);
      expect(service.allows('https://platform.example', TENANT_B)).toBe(true);
      expect(service.allows('https://platform.example', 'any-other-tenant-id')).toBe(true);
    });

    it(
      'a pattern granted to tenant A and an exact row for the SAME origin granted to tenant B → tenantsFor returns BOTH ' +
        '(the union rule; under the OLD single-owner precedence — "exact beats pattern" — this returned ONLY tenant B)',
      async () => {
        mockRepository.findAll.mockResolvedValueOnce([
          makeRow({ origin: 'https://arcaai-u2204.bcmch.org', tenantId: TENANT_B }),
          makeRow({ origin: 'https://*.bcmch.org:*', tenantId: TENANT_A }),
        ]);

        await service.refresh();

        expect(sorted(service.tenantsFor('https://arcaai-u2204.bcmch.org'))).toEqual([TENANT_A, TENANT_B].sort());
        expect(service.allows('https://arcaai-u2204.bcmch.org', TENANT_A)).toBe(true);
        expect(service.allows('https://arcaai-u2204.bcmch.org', TENANT_B)).toBe(true);
        expect(service.allows('https://arcaai-u2204.bcmch.org', TENANT_C)).toBe(false);
      },
    );

    it('an unregistered origin → empty set, has() false, allows() false for every tenant', async () => {
      mockRepository.findAll.mockResolvedValueOnce([makeRow({ origin: 'https://registered.example', tenantId: TENANT_A })]);
      await service.refresh();

      expect(service.tenantsFor('https://nowhere.example').size).toBe(0);
      expect(service.has('https://nowhere.example')).toBe(false);
      expect(service.allows('https://nowhere.example', TENANT_A)).toBe(false);
      expect(service.allows('https://nowhere.example', SYSTEM_TENANT_ID)).toBe(false);
    });

    it('a malformed origin → empty set, has()/allows() false, NEVER throws', async () => {
      mockRepository.findAll.mockResolvedValueOnce([makeRow({ origin: 'https://registered.example', tenantId: TENANT_A })]);
      await service.refresh();

      for (const raw of ['not a url', '', '   ', 'ftp://x.org', 'https://*', 'https://x.org/path', 'null', 'undefined']) {
        expect(() => service.tenantsFor(raw)).not.toThrow();
        expect(() => service.has(raw)).not.toThrow();
        expect(() => service.allows(raw, TENANT_A)).not.toThrow();
        expect(service.tenantsFor(raw).size).toBe(0);
        expect(service.has(raw)).toBe(false);
        expect(service.allows(raw, TENANT_A)).toBe(false);
      }
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
      expect(service.tenantsFor('https://removed.org').size).toBe(0);
      expect(service.size()).toBe(1);
    });
  });

  describe('malformed lookups never throw', () => {
    beforeEach(async () => {
      mockRepository.findAll.mockResolvedValueOnce([makeRow({ origin: 'https://good.org' })]);
      await service.refresh();
    });

    it.each([['not a url'], [''], ['   '], ['ftp://x.org'], ['https://*'], ['https://x.org/path'], ['null'], ['undefined']])(
      'has(%j) returns false, tenantsFor(%j) returns an empty set — no throw',
      (raw) => {
        expect(() => service.has(raw)).not.toThrow();
        expect(() => service.tenantsFor(raw)).not.toThrow();
        expect(service.has(raw)).toBe(false);
        expect(service.tenantsFor(raw).size).toBe(0);
      },
    );

    it('tolerates a non-string origin argument without throwing', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately hostile non-string input
      expect(() => service.has(null as any)).not.toThrow();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately hostile non-string input
      expect(() => service.tenantsFor(undefined as any)).not.toThrow();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately hostile non-string input
      expect(() => service.allows(null as any, TENANT_A)).not.toThrow();
    });
  });

  describe('cross-tenant visibility (the HAZARD this lane exists to prove)', () => {
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
      expect(sorted(service.tenantsFor('https://platform.example'))).toEqual([SYSTEM_TENANT_ID]);
      expect(sorted(service.tenantsFor('https://tenant-a.example'))).toEqual([TENANT_A]);
      expect(sorted(service.tenantsFor('https://tenant-b.example'))).toEqual([TENANT_B]);
    });
  });

  describe('tenantsFor()/has() normalize the lookup key', () => {
    it('matches case-insensitively and via the same canonical form origins are stored in', async () => {
      mockRepository.findAll.mockResolvedValueOnce([makeRow({ origin: 'https://x.org:443'.replace(':443', '') })]);
      // Stored canonical form has the default port stripped already (per
      // normalizeOrigin); a lookup that still carries the default port must
      // still resolve.
      await service.refresh();

      expect(service.has('HTTPS://X.ORG')).toBe(true);
      expect(service.has('https://x.org:443')).toBe(true);
      expect(sorted(service.tenantsFor('https://x.org:443'))).toEqual([SYSTEM_TENANT_ID]);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // Wildcard pattern UNION (not precedence).
  //
  // Under the single-owner model this precedence walk (exact beats pattern,
  // longest suffix beats a shorter one, `*` beats nothing) decided a single
  // winner. Under the many-to-many union model there is no winner to
  // decide: EVERY matching grant — exact or pattern, including a matching
  // `*` allow-all row — contributes its tenant(s) to the result. This is a
  // deliberate, owner-directed consequence: a Global `*` row now
  // means "every origin may act on Global", literally, for every origin,
  // not just ones nothing more specific matches.
  // ═════════════════════════════════════════════════════════════════════
  describe('wildcard pattern union (/ )', () => {
    const ARCAAI_TENANT_ID = '30000000-0000-0000-0000-000000000003';
    const GLOBAL_TENANT_ID = '50000000-0000-0000-0000-000000000000';

    async function seedUnionRows() {
      mockRepository.findAll.mockResolvedValueOnce([
        makeRow({ origin: 'https://arcaai-u2204.bcmch.org', tenantId: ARCAAI_TENANT_ID }),
        makeRow({ origin: 'https://*.bcmch.org:*', tenantId: ARCAAI_TENANT_ID }),
        makeRow({ origin: '*', tenantId: GLOBAL_TENANT_ID }),
      ]);
      await service.refresh();
    }

    it('an exact row + a matching pattern for the SAME tenant still resolves to just that one tenant (union, not duplication)', async () => {
      mockRepository.findAll.mockResolvedValueOnce([
        makeRow({ origin: 'https://arcaai-u2204.bcmch.org', tenantId: ARCAAI_TENANT_ID }),
        makeRow({ origin: 'https://*.bcmch.org:*', tenantId: ARCAAI_TENANT_ID }),
      ]);
      await service.refresh();

      expect(sorted(service.tenantsFor('https://arcaai-u2204.bcmch.org'))).toEqual([ARCAAI_TENANT_ID]);
      expect(service.has('https://arcaai-u2204.bcmch.org')).toBe(true);
    });

    it('with a Global `*` row also present, the exact origin resolves to BOTH the exact owner AND Global — no precedence suppresses `*`', async () => {
      await seedUnionRows();

      expect(sorted(service.tenantsFor('https://arcaai-u2204.bcmch.org'))).toEqual([ARCAAI_TENANT_ID, GLOBAL_TENANT_ID].sort());
      expect(service.allows('https://arcaai-u2204.bcmch.org', ARCAAI_TENANT_ID)).toBe(true);
      expect(service.allows('https://arcaai-u2204.bcmch.org', GLOBAL_TENANT_ID)).toBe(true);
    });

    it('an origin matching only the bcmch.org pattern and `*` resolves to both tenants', async () => {
      await seedUnionRows();

      // Not itself a registered exact row.
      expect(sorted(service.tenantsFor('https://anything.bcmch.org'))).toEqual([ARCAAI_TENANT_ID, GLOBAL_TENANT_ID].sort());
      expect(service.has('https://anything.bcmch.org')).toBe(true);
    });

    it('an origin matching only `*` resolves to the Global tenant', async () => {
      await seedUnionRows();

      expect(sorted(service.tenantsFor('https://random.example.com'))).toEqual([GLOBAL_TENANT_ID]);
      expect(service.has('https://random.example.com')).toBe(true);
    });

    it('an origin matching nothing at all (no `*` row registered) stays unregistered', async () => {
      mockRepository.findAll.mockResolvedValueOnce([
        makeRow({ origin: 'https://arcaai-u2204.bcmch.org', tenantId: ARCAAI_TENANT_ID }),
        makeRow({ origin: 'https://*.bcmch.org:*', tenantId: ARCAAI_TENANT_ID }),
      ]);
      await service.refresh();

      expect(service.tenantsFor('https://random.example.com').size).toBe(0);
      expect(service.has('https://random.example.com')).toBe(false);
    });

    it('size() counts DISTINCT pattern/exact rows, not grants', async () => {
      await seedUnionRows();

      expect(service.size()).toBe(3);
    });

    it('a subdomain-of-a-subdomain still matches (any depth, never the apex)', async () => {
      mockRepository.findAll.mockResolvedValueOnce([makeRow({ origin: 'https://*.bcmch.org:*', tenantId: ARCAAI_TENANT_ID })]);
      await service.refresh();

      expect(sorted(service.tenantsFor('https://deep.sub.bcmch.org'))).toEqual([ARCAAI_TENANT_ID]);
      // The apex itself must NOT match — that is `matchesOriginPattern`'s
      // contract, exercised here through the registry's own lookup path.
      expect(service.tenantsFor('https://bcmch.org').size).toBe(0);
    });

    it('the same pattern granted to two different tenants unions both into every matching origin', async () => {
      mockRepository.findAll.mockResolvedValueOnce([
        makeRow({ origin: 'https://*.bcmch.org:*', tenantId: TENANT_A }),
        makeRow({ origin: 'https://*.bcmch.org:*', tenantId: TENANT_B }),
      ]);
      await service.refresh();

      expect(sorted(service.tenantsFor('https://sub.bcmch.org'))).toEqual([TENANT_A, TENANT_B].sort());
      // One distinct pattern string, two grants — still one registered entry.
      expect(service.size()).toBe(1);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // Browser-extension origins in the registry. The registry needs
  // NO logic change: it inherits extension support from normalizeOrigin (exact
  // ids, via toLookupKey) and matchesOriginPattern (the `<scheme>://*` any-
  // extension pattern). These tests lock that inherited behavior end-to-end.
  // ═════════════════════════════════════════════════════════════════════
  describe('browser-extension origins', () => {
    const CHROME_ID = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    const OTHER_CHROME_ID = 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba';
    const MOZ_ORIGIN = 'moz-extension://a279f5e6-1b2c-4d3e-8f90-1234567890ab';

    it('a wildcard chrome-extension://* row admits any chrome extension id for its tenant, and only that tenant', async () => {
      mockRepository.findAll.mockResolvedValueOnce([makeRow({ origin: 'chrome-extension://*', tenantId: TENANT_A })]);
      await service.refresh();

      expect(service.allows(CHROME_ID, TENANT_A)).toBe(true);
      expect(service.allows(OTHER_CHROME_ID, TENANT_A)).toBe(true);
      // Bound to tenant A only.
      expect(service.allows(CHROME_ID, TENANT_B)).toBe(false);
      // A different extension scheme is NOT covered by the chrome wildcard.
      expect(service.allows(MOZ_ORIGIN, TENANT_A)).toBe(false);
    });

    it('a SYSTEM-owned chrome-extension://* row admits any tenant', async () => {
      mockRepository.findAll.mockResolvedValueOnce([makeRow({ origin: 'chrome-extension://*', tenantId: SYSTEM_TENANT_ID })]);
      await service.refresh();

      expect(service.allows(CHROME_ID, TENANT_A)).toBe(true);
      expect(service.allows(CHROME_ID, TENANT_B)).toBe(true);
    });

    it('an exact pinned chrome-extension://<id> row admits exactly that id, bound to its tenant', async () => {
      mockRepository.findAll.mockResolvedValueOnce([makeRow({ origin: CHROME_ID, tenantId: TENANT_A })]);
      await service.refresh();

      expect(service.allows(CHROME_ID, TENANT_A)).toBe(true);
      // A different id is not admitted (exact match only).
      expect(service.allows(OTHER_CHROME_ID, TENANT_A)).toBe(false);
      // Bound to tenant A only.
      expect(service.allows(CHROME_ID, TENANT_B)).toBe(false);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // The allow-all (`*`) row must announce itself. An
  // operator must never have to read the database to discover the platform
  // is admitting every unmatched — now: every, full stop, under union —
  // origin for one or more tenants.
  //
  // UPDATE: since a `*` row can now be granted to MULTIPLE tenants
  // (same many-to-many model as any other origin), the warning must report
  // ALL of them, not a single `ownerTenantId`.
  // ═════════════════════════════════════════════════════════════════════
  describe('allow-all (`*`) row announces itself on every successful refresh (/ )', () => {
    const GLOBAL_TENANT_ID = '50000000-0000-0000-0000-000000000000';

    it('logs at warn with the owning tenant id when a `*` row is present', async () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      mockRepository.findAll.mockResolvedValueOnce([makeRow({ origin: '*', tenantId: GLOBAL_TENANT_ID })]);
      await service.refresh();

      expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({ ownerTenantIds: [GLOBAL_TENANT_ID] }));
      const [warnCall] = warnSpy.mock.calls;
      const logged = warnCall[0] as Record<string, unknown>;
      expect(String(logged.message)).toContain(GLOBAL_TENANT_ID);
      expect(String(logged.message)).toMatch(/allow-all/i);

      warnSpy.mockRestore();
    });

    it('reports ALL tenants holding a `*` grant, not just one, when the row is shared', async () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      mockRepository.findAll.mockResolvedValueOnce([
        makeRow({ origin: '*', tenantId: GLOBAL_TENANT_ID }),
        makeRow({ origin: '*', tenantId: TENANT_A }),
      ]);
      await service.refresh();

      expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({ ownerTenantIds: [GLOBAL_TENANT_ID, TENANT_A].sort() }));
      const [warnCall] = warnSpy.mock.calls;
      const logged = warnCall[0] as Record<string, unknown>;
      expect(String(logged.message)).toContain(GLOBAL_TENANT_ID);
      expect(String(logged.message)).toContain(TENANT_A);

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
// active. That is exactly why the tests above passed while `refresh()`
// was wired directly to `@OnEvent` and running inside the emitting
// request's CLS store. This block uses a REAL `ClsModule`, a REAL
// `EventEmitterModule`, and the REAL `OriginRegistryService` wired through
// Nest DI, so the actual dispatch path production uses is exercised. This
// machinery is UNCHANGED by the union-resolution rewrite.
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

  it("a mutation-triggered invalidation rebuilds a FULL multi-tenant index, not just the acting tenant's rows", async () => {
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
    expect(sorted(service.tenantsFor('https://platform.example'))).toEqual([SYSTEM_TENANT_ID]);
    // The defect, if present, would make ONLY TENANT_A's origin visible here
    // — asserting all three tenants' rows landed in the index is what
    // distinguishes "fixed" from "narrowed to the acting tenant".
    expect(sorted(service.tenantsFor('https://tenant-a.example'))).toEqual([TENANT_A]);
    expect(sorted(service.tenantsFor('https://tenant-b.example'))).toEqual([TENANT_B]);
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
