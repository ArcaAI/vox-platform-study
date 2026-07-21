/**
 * (#17 / decision #5) — multi-instance socket aggregation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SocketRegistryService } from '../socket-registry.service';

function makeCache() {
  return {
    get: vi.fn(),
    setex: vi.fn(async () => undefined),
    scan: vi.fn(async () => [] as string[]),
  };
}

/** Parse the JSON `{tenantId: count}` map written by publishLocalTenantCounts. */
function parseTenantMapCall(call: [string, number, string]) {
  return { key: call[0], ttl: call[1], map: JSON.parse(call[2]) as Record<string, number> };
}

describe('SocketRegistryService (#17)', () => {
  let cache: ReturnType<typeof makeCache>;
  let service: SocketRegistryService;

  beforeEach(() => {
    cache = makeCache();
    service = new SocketRegistryService(cache as any);
  });

  it('publishes this instance count under a TTL-bounded key', async () => {
    await service.publishLocalCount(4);
    expect(cache.setex).toHaveBeenCalledTimes(1);
    const [key, ttl, value] = cache.setex.mock.calls[0];
    expect(key).toContain('hope:platform:sockets:inst:');
    expect(ttl).toBeGreaterThan(15);
    expect(value).toBe('4');
  });

  it('floors negative/NaN counts to 0', async () => {
    await service.publishLocalCount(-3);
    expect(cache.setex.mock.calls[0][2]).toBe('0');
  });

  it('aggregates the live per-instance counts across instances', async () => {
    cache.scan.mockResolvedValue(['hope:platform:sockets:inst:a', 'hope:platform:sockets:inst:b']);
    cache.get.mockImplementation(async (key: string) => (key.endsWith('a') ? '3' : '5'));
    expect(await service.getAggregateCount()).toBe(8);
  });

  it('returns 0 when no instances are reporting', async () => {
    cache.scan.mockResolvedValue([]);
    expect(await service.getAggregateCount()).toBe(0);
  });

  it('ignores non-numeric per-instance values', async () => {
    cache.scan.mockResolvedValue(['hope:platform:sockets:inst:a', 'hope:platform:sockets:inst:b']);
    cache.get.mockImplementation(async (key: string) => (key.endsWith('a') ? null : 'oops'));
    expect(await service.getAggregateCount()).toBe(0);
  });

  // (concurrency) — per-tenant open-socket aggregation.
  describe('per-tenant concurrency (TASK-392)', () => {
    it('publishes THIS instance per-tenant map under a TTL-bounded key', async () => {
      await service.publishLocalTenantCounts({ 't1': 2, 't2': 3 });
      expect(cache.setex).toHaveBeenCalledTimes(1);
      const { key, ttl, map } = parseTenantMapCall(cache.setex.mock.calls[0] as [string, number, string]);
      expect(key).toContain('hope:platform:sockets:tmap:');
      expect(ttl).toBeGreaterThan(15);
      expect(map).toEqual({ t1: 2, t2: 3 });
    });

    it('omits zero/negative/NaN tenant counts from the published map', async () => {
      await service.publishLocalTenantCounts({ t1: 2, zero: 0, neg: -4, nan: Number.NaN });
      const { map } = parseTenantMapCall(cache.setex.mock.calls[0] as [string, number, string]);
      expect(map).toEqual({ t1: 2 });
    });

    it('sums one tenant across every instance map', async () => {
      cache.scan.mockResolvedValue(['hope:platform:sockets:tmap:a', 'hope:platform:sockets:tmap:b']);
      cache.get.mockImplementation(async (key: string) =>
        key.endsWith('a') ? JSON.stringify({ t1: 3, t2: 1 }) : JSON.stringify({ t1: 5 }),
      );
      expect(await service.getTenantAggregateCount('t1')).toBe(8);
      expect(await service.getTenantAggregateCount('t2')).toBe(1);
    });

    it('returns 0 for a tenant with no live sockets anywhere', async () => {
      cache.scan.mockResolvedValue(['hope:platform:sockets:tmap:a']);
      cache.get.mockResolvedValue(JSON.stringify({ other: 4 }));
      expect(await service.getTenantAggregateCount('t1')).toBe(0);
    });

    it('tolerates corrupt/absent instance maps (never throws)', async () => {
      cache.scan.mockResolvedValue(['hope:platform:sockets:tmap:a', 'hope:platform:sockets:tmap:b']);
      cache.get.mockImplementation(async (key: string) => (key.endsWith('a') ? 'not-json' : null));
      expect(await service.getTenantAggregateCount('t1')).toBe(0);
    });
  });
});
