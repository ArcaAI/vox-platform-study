import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConsumption, getOpenSockets, getPlatformMetrics } from '../client';
import { platformKeys } from '../keys';

function installFetchMock(): { url: string; method: string }[] {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' });
      return Response.json({ refreshedAt: '2026-07-05T00:00:00Z' });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('platformKeys', () => {
  it('is stable and distinguishes tenant-scoped consumption', () => {
    expect(platformKeys.metrics()).toEqual(platformKeys.metrics());
    expect(platformKeys.consumption('t-1')).toEqual(platformKeys.consumption('t-1'));
    expect(platformKeys.consumption()).not.toEqual(platformKeys.consumption('t-1'));
    expect(platformKeys.metrics()[0]).toBe('platform');
    expect(platformKeys.sockets()[0]).toBe('platform');
  });
});

describe('platform client', () => {
  it('hits the three read endpoints through the proxy', async () => {
    const calls = installFetchMock();
    await getPlatformMetrics();
    await getOpenSockets();
    await getConsumption();
    await getConsumption('t-1');
    expect(calls.map((call) => call.url)).toEqual([
      '/api/hope/admin/platform/metrics',
      '/api/hope/admin/platform/sockets',
      '/api/hope/admin/platform/consumption',
      '/api/hope/admin/platform/consumption?tenantId=t-1',
    ]);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });
});
