/**
 * AiInferenceClient unit tests (TASK-446). URL resolution from IConfigService
 * (code defaults when absent), the two POST inference proxies, and the error
 * contract (upstream status passthrough, 503 on transport failure).
 * TASK-460 C4-02: every PHI-bearing hop attaches a fail-closed
 * `X-Service-Token` (mirrors the harness outbound `buildHeaders` pattern).
 */
import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { AxiosError, AxiosHeaders } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiInferenceClient } from '../ai-inference.client';

const axiosPost = vi.fn();
const httpService = { axiosRef: { post: axiosPost } };

const upstreamError = (status: number) => {
  const headers = new AxiosHeaders();
  const config = { headers };
  return new AxiosError('upstream failed', 'ERR_BAD_RESPONSE', config as never, {}, {
    status,
    statusText: 'ERR',
    headers,
    config: config as never,
    data: { detail: 'unsafe input' },
  });
};

describe('AiInferenceClient — URL resolution', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses IConfigService GUARDRAIL_URL / NLP_URL when provided', async () => {
    const configService = {
      getConfigValue: vi.fn((key: string) =>
        key === 'GUARDRAIL_URL' ? 'http://guardrail.svc:9863' : key === 'NLP_URL' ? 'http://nlp.svc:9864' : undefined,
      ),
    };
    const client = new AiInferenceClient(httpService as never, configService as never);
    axiosPost.mockResolvedValue({ data: { safe: true } });

    await client.analyzeGuardrail({ text: 'hi', guardrail_type: 'comprehensive' });
    expect(axiosPost).toHaveBeenCalledWith('http://guardrail.svc:9863/api/guardrail/analyze', { text: 'hi', guardrail_type: 'comprehensive' }, expect.anything());

    await client.classifyTokens({ text: 'hi', aggregation_strategy: 'simple' });
    expect(axiosPost).toHaveBeenCalledWith('http://nlp.svc:9864/api/v1/classify/tokens', { text: 'hi', aggregation_strategy: 'simple' }, expect.anything());
  });

  it('falls back to the local-dev defaults without a config service', async () => {
    const client = new AiInferenceClient(httpService as never, undefined);
    axiosPost.mockResolvedValue({ data: {} });

    await client.analyzeGuardrail({ text: 'x' });
    expect(axiosPost).toHaveBeenCalledWith('http://localhost:8863/api/guardrail/analyze', { text: 'x' }, expect.anything());

    await client.classifyTokens({ text: 'x' });
    expect(axiosPost).toHaveBeenCalledWith('http://localhost:8864/api/v1/classify/tokens', { text: 'x' }, expect.anything());
  });

  // TASK-460 C4-02 — INVERTED from "never sends an X-Service-Token header":
  // both hops carry caller clinical text (PHI), so the outbound request must
  // authenticate fail-closed exactly like the harness/STT internal hops.
  it('always sends an X-Service-Token header, empty when unresolved (fail-closed)', async () => {
    const client = new AiInferenceClient(httpService as never, undefined, undefined);
    axiosPost.mockResolvedValue({ data: {} });

    await client.analyzeGuardrail({ text: 'x' });
    await client.classifyTokens({ text: 'x' });

    for (const call of axiosPost.mock.calls) {
      const [, , options] = call;
      // Header PRESENT even without a SecretsService: an empty token is still
      // sent so a token-requiring receiver rejects, instead of the header being
      // silently omitted (the old fail-open posture).
      expect(options?.headers?.['X-Service-Token']).toBe('');
    }
  });

  it('resolves GUARDRAIL_SERVICE_TOKEN / NLP_SERVICE_TOKEN per hop via SecretsService', async () => {
    const secretsService = {
      getSecretOptional: vi.fn(async (key: string) =>
        key === 'GUARDRAIL_SERVICE_TOKEN' ? 'guardrail-secret' : key === 'NLP_SERVICE_TOKEN' ? 'nlp-secret' : undefined,
      ),
    };
    const client = new AiInferenceClient(httpService as never, undefined, secretsService as never);
    axiosPost.mockResolvedValue({ data: {} });

    await client.analyzeGuardrail({ text: 'x' });
    const [, , guardrailOptions] = axiosPost.mock.calls[0];
    expect(guardrailOptions?.headers?.['X-Service-Token']).toBe('guardrail-secret');

    await client.classifyTokens({ text: 'x' });
    const [, , nlpOptions] = axiosPost.mock.calls[1];
    expect(nlpOptions?.headers?.['X-Service-Token']).toBe('nlp-secret');
  });
});

describe('AiInferenceClient — proxying + errors', () => {
  let client: AiInferenceClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new AiInferenceClient(httpService as never, undefined);
  });

  it('returns the upstream guardrail verdict as-is', async () => {
    const verdict = { safe: false, issues: ['pii'], confidence: 0.92, processing_time_ms: 12, request_id: 'r1', timestamp: 't' };
    axiosPost.mockResolvedValue({ data: verdict });
    await expect(client.analyzeGuardrail({ text: 'x' })).resolves.toEqual(verdict);
  });

  it('returns the upstream NER entities as-is', async () => {
    const result = { entities: [{ text: 'aspirin', entity_type: 'DRUG', confidence: 0.99 }], model_version: 'v1' };
    axiosPost.mockResolvedValue({ data: result });
    await expect(client.classifyTokens({ text: 'x' })).resolves.toEqual(result);
  });

  it('passes an upstream HTTP error through with the SAME status', async () => {
    axiosPost.mockRejectedValue(upstreamError(422));
    const failure = await client.analyzeGuardrail({ text: 'x' }).catch((e) => e);
    expect(failure).toBeInstanceOf(HttpException);
    expect((failure as HttpException).getStatus()).toBe(422);
  });

  it('maps a transport error (no response) to 503', async () => {
    axiosPost.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(client.classifyTokens({ text: 'x' })).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
