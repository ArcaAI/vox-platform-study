/**
 * TASK-1050 W2e — the signal that releases a run paused at a guardrail-blocked node (README §9.8.1).
 * Route from lane W2f: `POST /api/v1/internal/workflow-runs/{runId}/guardrail-resolution`
 * `{ noticeId, resolution, by }`, with `X-Service-Token` and the MANDATORY `X-Tenant-Id`.
 */
import { describe, expect, it, vi } from 'vitest';
import { HarnessGatewayService } from '../harness-gateway.service';

function build(post = vi.fn(async () => ({ data: { signaled: true, runId: 'run 1', nodeId: 'n_note' } }))) {
  const http = { axiosRef: { post, get: vi.fn() } };
  const config = { get: vi.fn((key: string) => (key === 'HARNESS_URL' ? 'http://harness:8866' : undefined)) };
  const secrets = { getSecretOptional: vi.fn(async () => 'svc-token') };
  return { service: new HarnessGatewayService(http as never, config as never, secrets as never), post };
}

describe('HarnessGatewayService.signalGuardrailResolution', () => {
  it('POSTs the resolution to the run`s guardrail-resolution route with the service token and the tenant', async () => {
    const { service, post } = build();
    const result = await service.signalGuardrailResolution('run 1', { noticeId: 'n-1', resolution: 'item_excluded', by: 'doctor-1' }, 'tenant-1');

    expect(result).toEqual({ signaled: true, runId: 'run 1', nodeId: 'n_note' });
    const [url, body, options] = post.mock.calls[0] as unknown as [string, unknown, { headers: Record<string, string> }];
    expect(url).toBe('http://harness:8866/api/v1/internal/workflow-runs/run%201/guardrail-resolution');
    expect(body).toEqual({ noticeId: 'n-1', resolution: 'item_excluded', by: 'doctor-1' });
    expect(options.headers).toMatchObject({ 'X-Service-Token': 'svc-token', 'X-Tenant-Id': 'tenant-1' });
  });

  it('propagates a harness refusal (the run is no longer paused) so the caller can fall back', async () => {
    const { service } = build(vi.fn(async () => Promise.reject(Object.assign(new Error('409'), { response: { status: 409 } }))));
    await expect(service.signalGuardrailResolution('run-1', { noticeId: 'n-1', resolution: 'acknowledged', by: 'd' }, 't')).rejects.toThrow('409');
  });
});
