import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LmStudioEngineClient } from '../lmstudio-engine.client';

/**
 * TASK-1055 E12 / AC-6 — the LM Studio REST adapter (still behind the serving-control routes) said
 * nothing above `debug` when the engine refused or vanished. Every failure is now a `warn` with the
 * engine's code and reason, so "why did it fail" is answerable from the gateway's logs.
 */
const BASE = 'http://hope-lmstudio:1234';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('LmStudioEngineClient — failure reasons at warn (TASK-1055)', () => {
  const fetchMock = vi.fn();
  let warn: ReturnType<typeof vi.spyOn>;
  let client: LmStudioEngineClient;

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const providerConnections = { resolveConnection: vi.fn(async () => ({ baseUrl: `${BASE}/v1` })) };
    client = new LmStudioEngineClient(providerConnections as never, undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fetchMock.mockReset();
  });

  const logged = () => warn.mock.calls.map(([entry]) => entry as Record<string, unknown>);

  it('a non-200 read is logged at warn with the status and the engine`s reason', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'internal_error', message: 'daemon not ready' } }, 503));

    await expect(client.snapshot()).resolves.toEqual({ reachable: false, models: [] });

    expect(logged()).toEqual([
      expect.objectContaining({
        message: 'lmstudio.read.failed',
        url: `${BASE}/api/v1/models`,
        status: 503,
        reason: 'internal_error: daemon not ready',
      }),
    ]);
  });

  it('an unreachable engine is logged at warn with the transport error', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed: ECONNREFUSED'));

    await client.snapshot();

    expect(logged()).toEqual([
      expect.objectContaining({ message: 'lmstudio.read.failed', code: 'ENGINE_UNREACHABLE', reason: expect.stringContaining('ECONNREFUSED') }),
    ]);
  });

  it('a refused load is logged at warn with the engine`s code and message before it is thrown', async () => {
    fetchMock.mockResolvedValueOnce(json({ models: [{ key: 'gemma-4-e4b-it-qat@q4_0', type: 'llm', loaded_instances: [] }] }));
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'model_load_failed', message: 'CUDA out of memory' } }, 500));

    await expect(client.load('gemma-4-e4b-it-qat@q4_0')).rejects.toMatchObject({ code: 'LOAD_FAILED' });

    expect(logged()).toEqual([
      expect.objectContaining({
        message: 'lmstudio.load.failed',
        modelKey: 'gemma-4-e4b-it-qat@q4_0',
        code: 'LOAD_FAILED',
        reason: expect.stringContaining('CUDA out of memory'),
      }),
    ]);
  });

  it('a refused unload is logged at warn too', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'internal_error', message: 'busy' } }, 500));

    await expect(client.unload('gemma-4-e2b-it-qat')).rejects.toMatchObject({ code: 'UNLOAD_FAILED' });

    expect(logged()).toEqual([
      expect.objectContaining({ message: 'lmstudio.unload.failed', instanceId: 'gemma-4-e2b-it-qat', code: 'UNLOAD_FAILED' }),
    ]);
  });
});
