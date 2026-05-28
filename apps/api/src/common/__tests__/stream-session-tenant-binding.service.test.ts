import { beforeEach, describe, expect, it, vi } from 'vitest';

import { STREAM_SESSION_TENANT_KEY_PREFIX, StreamSessionTenantBindingService } from '../stream-session-tenant-binding.service';

/**
 * TASK-310 W7.A.9 (AC-3) — StreamSessionTenantBindingService.
 *
 * Closes the carryover gap from TASK-307 W7.A.9: the `closeStreamSession`
 * endpoint takes a `sessionId` (an opaque STT-V2 streaming-session id, not
 * a Prisma row), so the existing `@TenantOwnedResource` model resolvers
 * couldn't run an ownership check. The pre-W7 enforcement was the Prisma
 * tenantScope extension on whatever downstream rows
 * `StreamingSessionService.removeSession` happened to touch — which is
 * defence-in-depth but not a route-level guard.
 *
 * This service is the missing piece: when a stream session is created, the
 * gateway writes a `<sessionId> → <tenantId>` mapping (TTL-bounded). When
 * the close endpoint is hit, the global `TenantOwnedResourceInterceptor`
 * looks up the mapping and 404s on tenant mismatch, matching the DEF-C3
 * "no existence leak" posture every other resource model uses.
 */
describe('StreamSessionTenantBindingService (TASK-310 W7.A.9 / AC-3)', () => {
  const createMockCache = () => {
    const store = new Map<string, string>();
    return {
      mock: {
        get: vi.fn(async (key: string) => store.get(key) ?? null),
        setex: vi.fn(async (key: string, _ttl: number, value: string) => {
          store.set(key, value);
        }),
        del: vi.fn(async (key: string) => {
          store.delete(key);
        }),
      },
      store,
    };
  };

  let cache: ReturnType<typeof createMockCache>;
  let service: StreamSessionTenantBindingService;

  beforeEach(() => {
    cache = createMockCache();
    service = new StreamSessionTenantBindingService(cache.mock as never);
  });

  it('bind() writes a TTL-bounded sessionId → tenantId mapping', async () => {
    await service.bind('sess-abc', 'tenant-A', 600);

    const key = `${STREAM_SESSION_TENANT_KEY_PREFIX}sess-abc`;
    expect(cache.mock.setex).toHaveBeenCalledWith(key, 600, 'tenant-A');
    expect(cache.store.get(key)).toBe('tenant-A');
  });

  it('lookup() returns the bound tenantId', async () => {
    await service.bind('sess-1', 'tenant-B', 600);

    expect(await service.lookup('sess-1')).toBe('tenant-B');
  });

  it('lookup() returns null for an unbound sessionId (no existence leak)', async () => {
    expect(await service.lookup('never-bound')).toBeNull();
  });

  it('clear() removes the binding', async () => {
    await service.bind('sess-x', 'tenant-X', 600);
    expect(await service.lookup('sess-x')).toBe('tenant-X');

    await service.clear('sess-x');

    expect(await service.lookup('sess-x')).toBeNull();
  });

  it('lookup() guards against empty / whitespace sessionIds', async () => {
    expect(await service.lookup('')).toBeNull();
    expect(await service.lookup('   ')).toBeNull();
  });
});
