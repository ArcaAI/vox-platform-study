/**
 * TASK-615 WS-H — TTS character-allowance PRE-FLIGHT on the batch/streaming
 * REST synthesize path.
 *
 * Unlike the WS-duplex gateway (no fixed upfront text — see
 * `tts-ws.gateway.quota.task615.test.ts`), this endpoint receives the WHOLE
 * `input` string in the request body, so the exact character count this
 * request would add is knowable BEFORE synthesis starts. The check therefore
 * passes that count as the `increment` to `assertMeterQuota` — "would THIS
 * request's characters push the tenant over its monthly allowance" — and
 * must run before the upstream TTS call, not after.
 */
import { EventEmitter } from 'node:events';
import { QuotaExceededException } from '@arcaai/exceptions';
import { describe, expect, it, vi } from 'vitest';

import { SpeechProxyController } from '../speech-proxy.controller';

const createMockHttpService = () => ({ axiosRef: { post: vi.fn(), get: vi.fn() } });
const createMockConfigService = () => ({
  getConfigValue: vi.fn((key: string) => (key === 'TTS_URL' ? 'http://localhost:8865' : undefined)),
});
const createMockSecrets = (token?: string) => ({ getSecretSync: vi.fn(() => token) });
const createMockCls = (tenantId: string | undefined = 't1') => ({
  get: vi.fn((key: string) => (key === 'tenantId' ? tenantId : undefined)),
});

function makeStream() {
  const stream = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  stream.destroy = vi.fn();
  return stream;
}

function makeRes() {
  const emitter = new EventEmitter();
  const res: any = {
    headersSent: false,
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => emitter.on(event, cb)),
    emit: (event: string, ...args: unknown[]) => emitter.emit(event, ...args),
    status: vi.fn(() => res),
    json: vi.fn(),
  };
  return res;
}

function buildController(opts: { entitlements?: unknown; cls?: unknown } = {}) {
  const http = createMockHttpService();
  const config = createMockConfigService();
  const cls = opts.cls ?? createMockCls('t1');
  const entitlements = opts.entitlements ?? { assertMeterQuota: vi.fn().mockResolvedValue(undefined) };
  const controller = new SpeechProxyController(
    http as any,
    config as any,
    createMockSecrets('svc-token') as any,
    undefined, // tenantTtsConfig
    undefined, // providerConnectionService
    cls as any,
    undefined, // usageLedger
    entitlements as any,
  );
  return { controller, http, entitlements: entitlements as { assertMeterQuota: ReturnType<typeof vi.fn> } };
}

describe('SpeechProxyController — TASK-615 WS-H TTS character quota pre-flight', () => {
  it('checks monthlyTtsCharacters with the EXACT input code-point count, before calling upstream TTS', async () => {
    const { controller, http, entitlements } = buildController();
    http.axiosRef.post.mockResolvedValue({ headers: {}, data: makeStream() });
    const res = makeRes();

    await controller.synthesize({ input: 'Hello world', voice: 'en-female-1' } as any, res);

    expect(entitlements.assertMeterQuota).toHaveBeenCalledWith('t1', 'monthlyTtsCharacters', 'Hello world'.length);
    expect(http.axiosRef.post).toHaveBeenCalled();
  });

  it("counts Unicode CODE POINTS, not UTF-16 code units (matches the CHARACTER unit's counting rule)", async () => {
    const { controller, http, entitlements } = buildController();
    http.axiosRef.post.mockResolvedValue({ headers: {}, data: makeStream() });
    const res = makeRes();
    // A surrogate-pair emoji is 1 code point but 2 UTF-16 code units, so
    // `.length` (5) would be WRONG here — the correct count is 4.
    const input = 'hi \u{1F600}';
    expect(input.length).toBe(5);
    expect([...input].length).toBe(4);

    await controller.synthesize({ input, voice: 'en-female-1' } as any, res);

    expect(entitlements.assertMeterQuota).toHaveBeenCalledWith('t1', 'monthlyTtsCharacters', 4);
  });

  it('BLOCKS before calling upstream TTS when the allowance is exceeded', async () => {
    const entitlements = {
      assertMeterQuota: vi
        .fn()
        .mockRejectedValue(new QuotaExceededException('over allowance', { capability: 'monthlyTtsCharacters', limit: 10, used: 10, requested: 5, tenantId: 't1' })),
    };
    const { controller, http } = buildController({ entitlements });
    const res = makeRes();

    await expect(controller.synthesize({ input: 'Hello', voice: 'en-female-1' } as any, res)).rejects.toBeInstanceOf(QuotaExceededException);
    expect(http.axiosRef.post).not.toHaveBeenCalled();
  });

  it('is a no-op (still synthesizes) when entitlements is not wired (legacy positional fixtures)', async () => {
    const { controller, http } = buildController({ entitlements: undefined });
    http.axiosRef.post.mockResolvedValue({ headers: {}, data: makeStream() });
    const res = makeRes();

    await expect(controller.synthesize({ input: 'Hi.', voice: 'en-female-1' } as any, res)).resolves.toBeUndefined();
    expect(http.axiosRef.post).toHaveBeenCalled();
  });

  it('is a no-op when there is no tenant context (no CLS tenantId)', async () => {
    const noTenantCls = { get: vi.fn(() => undefined) };
    const { controller, http, entitlements } = buildController({ cls: noTenantCls });
    http.axiosRef.post.mockResolvedValue({ headers: {}, data: makeStream() });
    const res = makeRes();

    await controller.synthesize({ input: 'Hi.', voice: 'en-female-1' } as any, res);

    expect(entitlements.assertMeterQuota).not.toHaveBeenCalled();
    expect(http.axiosRef.post).toHaveBeenCalled();
  });
});
