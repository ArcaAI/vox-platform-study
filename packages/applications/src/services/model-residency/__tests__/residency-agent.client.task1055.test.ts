import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResidencyAgentClient, ResidencyAgentError } from '../residency-agent.client';

/**
 * TASK-1055 — the residency agent client grows a third service, LM Studio's in-pod agent
 * (`LMSTUDIO_AGENT_URL`), and the v2 agent shapes: `device` on load/unload, every visible GPU
 * with its uuid, per-device model bytes and the LM Studio load config
 * (`tests/contracts/model-residency-task1055.fixture.json` → `python`, `lmStudioAgent`).
 */
const FIXTURE = JSON.parse(readFileSync(resolve(__dirname, '../../../../../../tests/contracts/model-residency-task1055.fixture.json'), 'utf8'));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const URLS: Record<string, string> = {
  STT_URL: 'http://hope-stt:8861',
  NLP_URL: 'http://hope-nlp:8864',
  LMSTUDIO_AGENT_URL: 'http://hope-lmstudio:8869/',
};

describe('ResidencyAgentClient (TASK-1055)', () => {
  const fetchMock = vi.fn();
  let urls: Record<string, string | undefined>;
  let client: ResidencyAgentClient;

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    urls = { ...URLS };
    const config = { getConfigValue: vi.fn((key: string) => urls[key]) };
    const secrets = {
      getSecretOptional: vi.fn(async (key: string) =>
        key === 'INTERNAL_ACCESS_TOKEN' ? 'svc-token' : key === 'NLP_SERVICE_TOKEN' ? 'nlp-token' : undefined,
      ),
    };
    client = new ResidencyAgentClient(config as never, secrets as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fetchMock.mockReset();
  });

  it('reaches the LM Studio agent at LMSTUDIO_AGENT_URL with the internal access token', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { service: 'lm-studio', instance: 'hope-lmstudio-0', reported_at: '2026-10-09T09:00:00Z', devices: [], models: [] }),
    );

    const report = await client.report('lm-studio');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://hope-lmstudio:8869/internal/residency');
    expect(init.headers).toMatchObject({ 'X-Service-Token': 'svc-token', 'X-Tenant-Id': 'tenantless:control-plane' });
    expect(report).toMatchObject({ service: 'lm-studio', instance: 'hope-lmstudio-0', models: [] });
  });

  it('with LMSTUDIO_AGENT_URL unset, LM Studio is SERVICE_UNREACHABLE and nothing is sent anywhere (no REST fallback)', async () => {
    urls.LMSTUDIO_AGENT_URL = undefined;

    const error = await client.load('lm-studio', { modelRef: 'gemma-4-e2b-it-qat', loadSpec: {}, pin: false }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ResidencyAgentError);
    expect(error).toMatchObject({ code: 'SERVICE_UNREACHABLE', status: 0 });
    expect((error as Error).message).toContain('LMSTUDIO_AGENT_URL');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps the v2 report: every GPU with index, name, uuid and process bytes', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, FIXTURE.python.report));

    const report = await client.report('nlp');

    expect(report.devices).toEqual([
      {
        id: 'cuda:0',
        kind: 'gpu',
        totalBytes: 17175674880,
        freeBytes: 5636096000,
        index: 0,
        name: 'NVIDIA RTX 2000 Ada Generation',
        uuid: 'GPU-be50f6fc-59ec-9c5b-c925-c962344c734c',
        processBytes: 1946157056,
      },
      {
        id: 'cuda:1',
        kind: 'gpu',
        totalBytes: 17175674880,
        freeBytes: 14501806080,
        index: 1,
        name: 'NVIDIA RTX 2000 Ada Generation',
        uuid: 'GPU-55c35bac-8291-a08a-2cb2-a43648336aa5',
        processBytes: 0,
      },
    ]);
    expect(report.models[0]).toMatchObject({ modelRef: 'fastino/gliguard-LLMGuardrails-300M', device: 'cuda:1', bytesSource: 'measured' });
  });

  it('maps an LM Studio instance: engine key, instance id, per-device bytes, `estimated` source and the load config', async () => {
    const estimated = { ...FIXTURE.lmStudioAgent.reportModel, bytes_source: 'estimated' };
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { service: 'lm-studio', instance: 'hope-lmstudio-0', reported_at: '2026-10-09T09:00:00Z', devices: [], models: [estimated] }),
    );

    const [model] = (await client.report('lm-studio')).models;

    expect(model).toMatchObject({
      modelRef: 'gemma-4-e2b-it-qat',
      engineKey: 'gemma-4-e2b-it-qat@q4_0',
      instanceId: 'gemma-4-e2b-it-qat',
      cache: 'llm',
      device: 'cuda:1',
      bytes: 4294967296,
      bytesSource: 'estimated',
      deviceBytes: { 'cuda:1': 4294967296 },
      loadConfig: {
        contextLength: 65536,
        parallel: 10,
        flashAttention: true,
        kvCacheQuant: { k: 'f16', v: 'f16' },
        gpuSplit: { strategy: 'priorityOrder', priority: [1], disabledGpus: [0], customRatio: [] },
      },
    });
  });

  it('sends `device` on load and unload when one is chosen, and the LM Studio load_spec verbatim', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { outcome: 'loaded', model: FIXTURE.lmStudioAgent.reportModel }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { outcome: 'unloaded', model_ref: 'gemma-4-e2b-it-qat' }));
    const { load_spec: loadSpec } = FIXTURE.lmStudioAgent.loadRequest;

    await client.load('lm-studio', { modelRef: 'gemma-4-e2b-it-qat', loadSpec, pin: false, device: 'cuda:1' });
    await client.unload('lm-studio', { modelRef: 'gemma-4-e2b-it-qat', force: false, reason: 'admin', device: 'cuda:1' });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(FIXTURE.lmStudioAgent.loadRequest);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ model_ref: 'gemma-4-e2b-it-qat', force: false, reason: 'admin', device: 'cuda:1' });
  });

  it('omits `device` when none is chosen (the TASK-1005 body is unchanged)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { outcome: 'unloaded', model_ref: 'x' }));
    await client.unload('stt', { modelRef: 'x', force: false, reason: 'admin' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ model_ref: 'x', force: false, reason: 'admin' });
  });

  it('recognises DEVICE_UNAVAILABLE and INSUFFICIENT_MEMORY with the device they name', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, FIXTURE.python.errors.DEVICE_UNAVAILABLE));
    fetchMock.mockResolvedValueOnce(jsonResponse(503, FIXTURE.python.errors.INSUFFICIENT_MEMORY));

    const unavailable = await client.load('nlp', { modelRef: 'x', loadSpec: {}, pin: false, device: 'cuda:2' }).catch((e: unknown) => e);
    const insufficient = await client.load('nlp', { modelRef: 'x', loadSpec: {}, pin: false, device: 'cuda:0' }).catch((e: unknown) => e);

    expect(unavailable).toMatchObject({ code: 'DEVICE_UNAVAILABLE', status: 400, device: 'cuda:2' });
    expect(insufficient).toMatchObject({ code: 'INSUFFICIENT_MEMORY', status: 503, device: 'cuda:0', neededBytes: 1191182336, freeBytes: 524288000 });
  });

  it('logs a refused or failed command at warn with the agent`s code and message (AC-6)', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: { code: 'LOAD_FAILED', message: 'CUDA out of memory on cuda:0' } }));
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    await client.load('stt', { modelRef: 'x', loadSpec: {}, pin: false }).catch(() => undefined);
    await client.unload('lm-studio', { modelRef: 'y', force: false, reason: 'admin' }).catch(() => undefined);

    const logged = warn.mock.calls.map(([entry]) => entry as Record<string, unknown>);
    expect(logged).toEqual([
      expect.objectContaining({
        message: 'residency.agent.call_failed',
        service: 'stt',
        code: 'LOAD_FAILED',
        reason: 'CUDA out of memory on cuda:0',
      }),
      expect.objectContaining({ message: 'residency.agent.call_failed', service: 'lm-studio', code: 'SERVICE_UNREACHABLE' }),
    ]);
  });
});
