import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRedisHealth, getServiceHealth, getServiceUptime, getServicesHealth, getSessions, getUptime, listHeartbeats } from '../client';
import { monitoringKeys } from '../keys';

function installFetchMock(): { url: string; method: string }[] {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' });
      return Response.json({ status: 'healthy' });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('monitoringKeys', () => {
  it('is stable and scoped per service', () => {
    expect(monitoringKeys.uptime()).toEqual(monitoringKeys.uptime());
    expect(monitoringKeys.serviceUptime('stt')).not.toEqual(monitoringKeys.serviceUptime('smr'));
    expect(monitoringKeys.heartbeats('nlp')).not.toEqual(monitoringKeys.serviceUptime('nlp'));
    for (const key of [monitoringKeys.servicesHealth(), monitoringKeys.uptime(), monitoringKeys.sessions(), monitoringKeys.redis()]) {
      expect(key[0]).toBe('monitoring');
    }
  });
});

describe('monitoring client', () => {
  it('covers health, uptime, heartbeats, sessions and redis endpoints', async () => {
    const calls = installFetchMock();
    await getServicesHealth();
    await getServiceHealth('stt');
    await getUptime();
    await getServiceUptime('smr');
    await listHeartbeats('nlp');
    await getSessions();
    await getRedisHealth();
    expect(calls.map((call) => call.url)).toEqual([
      '/api/hope/admin/health/services',
      '/api/hope/admin/health/services/stt',
      '/api/hope/admin/monitoring/uptime',
      '/api/hope/admin/monitoring/uptime/smr',
      '/api/hope/admin/monitoring/heartbeats/nlp',
      '/api/hope/admin/monitoring/sessions',
      '/api/hope/admin/queues/health/redis',
    ]);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });
});
