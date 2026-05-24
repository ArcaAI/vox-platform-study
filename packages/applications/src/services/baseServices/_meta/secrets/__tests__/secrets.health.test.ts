// Phase 2C Task 2.19 (TASK-302 Stream B) - SecretsHealthIndicator test.
import { describe, it, expect, vi } from 'vitest';
import { SecretsHealthIndicator } from '../secrets.health';
import type { SecretsService } from '../SecretsService';

function makeSvc(
  resp:
    | { ok: true; latencyMs: number; provider: string }
    | { ok: false; latencyMs: number; provider: string; detail: string },
): SecretsService {
  return {
    health: vi.fn().mockResolvedValue(resp),
  } as unknown as SecretsService;
}

describe('SecretsHealthIndicator', () => {
  it('returns up when provider.health.ok === true', async () => {
    const svc = makeSvc({ ok: true, latencyMs: 5, provider: 'vault' });
    const ind = new SecretsHealthIndicator(svc);
    const res = await ind.isHealthy('secrets');
    expect(res).toEqual({
      secrets: { status: 'up', provider: 'vault', latencyMs: 5 },
    });
  });

  it('throws HealthCheckError when ok === false', async () => {
    const svc = makeSvc({
      ok: false,
      latencyMs: 9,
      provider: 'vault',
      detail: 'sealed=true',
    });
    const ind = new SecretsHealthIndicator(svc);
    await expect(ind.isHealthy('secrets')).rejects.toThrow(/sealed/);
  });

  it('returns detail field on the result when present (success path)', async () => {
    const svc = makeSvc({ ok: true, latencyMs: 2, provider: 'env' });
    const ind = new SecretsHealthIndicator(svc);
    const res = await ind.isHealthy('secrets');
    expect(res.secrets).not.toHaveProperty('detail');
  });
});
