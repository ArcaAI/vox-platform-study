/**
 * TASK-1047 L9 / OD-3 / FC-4 — a raw caller `system_prompt` on `POST text-generations/generate`
 * is deprecated (headers + counter, still forwarded), and a caller can never claim governance:
 * any `system_governance` variant is stripped before the body reaches TEXT.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import 'reflect-metadata';
import { register } from 'prom-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TextProxyController } from '../text-proxy.controller';

const SELECTED = { provider: 'vllm', model: 'medgemma-27b' };

function build() {
  const http = { axiosRef: { post: vi.fn().mockResolvedValue({ data: { content: 'ok' } }), get: vi.fn() } };
  const cls = {
    get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-abc' : key === 'user' ? { id: 'user-1', roles: [] } : undefined)),
    getId: vi.fn(() => 'req-1'),
  };
  const proxy = new TextProxyController(
    http as any,
    { fetchByCodeName: vi.fn() } as any,
    cls as any,
    { findById: vi.fn() } as any,
    { findById: vi.fn() } as any,
    { findById: vi.fn() } as any,
    { findById: vi.fn() } as any,
    { findById: vi.fn() } as any,
    { getObject: vi.fn() } as any,
    { getConfigValue: vi.fn(() => 'http://localhost:8862') } as any,
    undefined,
    { resolveTextSelection: vi.fn().mockResolvedValue(SELECTED) } as any,
  );
  const res = { setHeader: vi.fn() };
  return { proxy, http, res };
}

const forwarded = (http: ReturnType<typeof build>['http']) => http.axiosRef.post.mock.calls[0][1];

async function counterValue(): Promise<number> {
  const metrics = await register.getMetricsAsJSON();
  const m = metrics.find((x) => x.name.endsWith('deprecated_requests_total')) as any;
  const v = m?.values?.find((s: any) => String(s.labels.route).includes('text-generations/generate#system_prompt'));
  return v?.value ?? 0;
}

beforeEach(() => vi.clearAllMocks());

describe('system_prompt deprecation on text-generations/generate', () => {
  it('sets Deprecation + Sunset headers, counts the request, and still forwards the prompt', async () => {
    const { proxy, http, res } = build();
    const before = await counterValue();

    await proxy.generate({ prompt: 'p', system_prompt: 'be terse', stream: false } as any, res as any);

    expect(res.setHeader).toHaveBeenCalledWith('Deprecation', 'true');
    expect(res.setHeader).toHaveBeenCalledWith('Sunset', 'Sun, 31 Jan 2027 00:00:00 GMT');
    expect(await counterValue()).toBe(before + 1);
    expect(forwarded(http).system_prompt).toBe('be terse');
  });

  it('emits no deprecation headers and no count when system_prompt is absent', async () => {
    const { proxy, res } = build();
    const before = await counterValue();

    await proxy.generate({ prompt: 'p', stream: false } as any, res as any);

    expect(res.setHeader).not.toHaveBeenCalledWith('Deprecation', expect.anything());
    expect(await counterValue()).toBe(before);
  });
});

describe('caller-supplied governance is stripped before forwarding', () => {
  it.each(['system_governance', 'systemGovernance', 'SystemGovernance', 'SYSTEM_GOVERNANCE'])('%s', async (key) => {
    const { proxy, http, res } = build();

    await proxy.generate({ prompt: 'p', system_prompt: 's', stream: false, [key]: { composed_digest: 'x' } } as any, res as any);

    const sent = forwarded(http);
    expect(Object.keys(sent).filter((k) => k.toLowerCase().replace(/_/g, '') === 'systemgovernance')).toEqual([]);
    expect(sent.system_prompt).toBe('s');
  });
});
