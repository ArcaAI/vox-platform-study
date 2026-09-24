import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResidencyAgentClient, ResidencyAgentError } from '../residency-agent.client';

/**
 * TASK-1005 — the gateway half of the Python residency agents' wire
 * (`tests/contracts/model-residency-agent.fixture.json` → `python`).
 */
const FIXTURE = JSON.parse(readFileSync(resolve(__dirname, '../../../../../../tests/contracts/model-residency-agent.fixture.json'), 'utf8'));

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

describe('ResidencyAgentClient (TASK-1005)', () => {
  const fetchMock = vi.fn();
  let client: ResidencyAgentClient;

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    const config = { getConfigValue: vi.fn((key: string) => (key === 'STT_URL' ? 'http://hope-stt:8861' : 'http://hope-nlp:8864')) };
    const secrets = { getSecretOptional: vi.fn(async (key: string) => (key === 'INTERNAL_ACCESS_TOKEN' ? 'svc-token' : undefined)) };
    client = new ResidencyAgentClient(config as never, secrets as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('reads GET /internal/residency with the service token and the DECLARED tenant-less marker, and camelCases the report', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, FIXTURE.python.report));

    const report = await client.report('stt');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://hope-stt:8861/internal/residency');
    expect(init.headers).toMatchObject({ 'X-Service-Token': 'svc-token', 'X-Tenant-Id': 'tenantless:control-plane' });
    expect(report).toEqual({
      service: 'stt',
      instance: 'hope-stt-5d9f7c8b6-abcde',
      reportedAt: '2026-09-24T13:00:00Z',
      devices: [
        { id: 'cuda:0', kind: 'gpu', totalBytes: 17175674880, freeBytes: 12817793024 },
        { id: 'cpu', kind: 'cpu', totalBytes: 67430170624, freeBytes: 30064771072 },
      ],
      models: [
        {
          modelRef: 'arcaai-whisper-ml-en-ggml',
          aiModelId: '0199a1b2-0000-7000-8000-000000000001',
          cache: 'asr',
          state: 'loaded',
          device: 'cuda:0',
          bytes: 1623195648,
          bytesSource: 'measured',
          inFlight: 1,
          pinned: true,
          adminPinned: false,
          ttlSeconds: 900,
          loadedAt: '2026-09-24T12:40:00Z',
          lastUsedAt: '2026-09-24T12:59:58Z',
          loadSeconds: 6.8,
        },
      ],
    });
  });

  it('sends the pinned load body in snake_case', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { outcome: 'loaded', model: FIXTURE.python.report.models[0] }));

    const result = await client.load('nlp', {
      modelRef: 'blaze999/Medical-NER',
      loadSpec: { cache: 'nlp_token_classifier', model_path: null },
      pin: false,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://hope-nlp:8864/internal/residency/load');
    expect(JSON.parse(init.body)).toEqual({
      model_ref: 'blaze999/Medical-NER',
      load_spec: { cache: 'nlp_token_classifier', model_path: null },
      pin: false,
      ttl_seconds: null,
    });
    expect(result.outcome).toBe('loaded');
    expect(result.model.modelRef).toBe('arcaai-whisper-ml-en-ggml');
  });

  it('percent-encodes a hub id (it contains `/`) in the policy path and sends only the given fields', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { model: FIXTURE.python.report.models[0] }));
    await client.setPolicy('nlp', 'blaze999/Medical-NER', { adminPinned: true });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://hope-nlp:8864/internal/residency/models/blaze999%2FMedical-NER/policy');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ admin_pinned: true });
  });

  it("maps the agent's `{error:{code,message,in_flight}}` to a typed error carrying the status and in-flight count", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(409, FIXTURE.python.error));

    const error = await client.unload('stt', { modelRef: 'arcaai-whisper-ml-en-ggml', force: false, reason: 'admin' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ResidencyAgentError);
    expect(error).toMatchObject({ code: 'IN_FLIGHT', status: 409, inFlight: 1 });
  });

  it('carries Retry-After on INSUFFICIENT_MEMORY', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { error: { code: 'INSUFFICIENT_MEMORY', message: 'no room' } }, { 'Retry-After': '7' }));
    const error = await client.load('stt', { modelRef: 'x', loadSpec: {}, pin: false }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'INSUFFICIENT_MEMORY', status: 503, retryAfterSeconds: 7 });
  });

  it('an unreachable agent is SERVICE_UNREACHABLE, never a silent empty report', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(client.report('nlp')).rejects.toMatchObject({ code: 'SERVICE_UNREACHABLE' });
  });
});
