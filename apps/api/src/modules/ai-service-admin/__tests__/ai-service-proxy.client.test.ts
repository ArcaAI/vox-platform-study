/**
 * AiServiceProxyClient unit tests.
 *
 * The outbound half of the /admin/ai-services read plane: URL resolution from
 * IConfigService (code defaults when absent), the two-call guardrail config
 * merge, and the HarnessOpsClient error contract (upstream status passthrough,
 * 503 on transport failure).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { AxiosError, AxiosHeaders } from 'axios';
import { AiServiceProxyClient } from '../ai-service-proxy.client';

const axiosGet = vi.fn();
const httpService = { axiosRef: { get: axiosGet } };

const upstreamError = (status: number) => {
  const headers = new AxiosHeaders();
  const config = { headers };
  return new AxiosError(
    'upstream failed',
    'ERR_BAD_RESPONSE',
    config as never,
    {},
    {
      status,
      statusText: 'ERR',
      headers,
      config: config as never,
      data: { detail: 'boom' },
    },
  );
};

describe('AiServiceProxyClient — URL resolution', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses IConfigService GUARDRAIL_URL / NLP_URL when provided', async () => {
    const configService = {
      getConfigValue: vi.fn((key: string) =>
        key === 'GUARDRAIL_URL' ? 'http://guardrail.svc:9863' : key === 'NLP_URL' ? 'http://nlp.svc:9864' : undefined,
      ),
    };
    const client = new AiServiceProxyClient(httpService as never, configService as never);
    axiosGet.mockResolvedValue({ data: { status: 'healthy' } });

    await client.guardrailStatus();
    expect(axiosGet).toHaveBeenCalledWith('http://guardrail.svc:9863/api/health', expect.anything());

    await client.nlpStatus();
    expect(axiosGet).toHaveBeenCalledWith('http://nlp.svc:9864/api/v1/health', expect.anything());
  });

  it('falls back to the local-dev defaults without a config service', async () => {
    const client = new AiServiceProxyClient(httpService as never, undefined);
    axiosGet.mockResolvedValue({ data: { status: 'healthy' } });

    await client.guardrailStatus();
    expect(axiosGet).toHaveBeenCalledWith('http://localhost:8863/api/health', expect.anything());

    await client.nlpStatus();
    expect(axiosGet).toHaveBeenCalledWith('http://localhost:8864/api/v1/health', expect.anything());
  });
});

describe('AiServiceProxyClient — reads', () => {
  let client: AiServiceProxyClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new AiServiceProxyClient(httpService as never, undefined);
  });

  it('guardrailStatus returns the upstream health document as-is', async () => {
    const health = { status: 'degraded', service: 'guardrail', checks: { redis: { status: 'healthy' } } };
    axiosGet.mockResolvedValue({ data: health });

    await expect(client.guardrailStatus()).resolves.toEqual(health);
  });

  it('guardrailConfig merges /api/medical/config and /api/guardrail/types into one read', async () => {
    axiosGet.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/medical/config')) return { data: { provider: 'ollama', guardian_enabled: true } };
      if (url.endsWith('/api/guardrail/types')) return { data: { jailbreak: 'Detects jailbreaks' } };
      throw new Error(`unexpected url ${url}`);
    });

    await expect(client.guardrailConfig()).resolves.toEqual({
      medicalValidation: { provider: 'ollama', guardian_enabled: true },
      analysisTypes: { jailbreak: 'Detects jailbreaks' },
    });
  });

  it('nlpStatus returns the upstream health document (per-model checks) as-is', async () => {
    const health = { status: 'healthy', service: 'nlp', checks: { text_classifier: { status: 'healthy' } } };
    axiosGet.mockResolvedValue({ data: health });

    await expect(client.nlpStatus()).resolves.toEqual(health);
  });

  it('passes an upstream HTTP error through with the SAME status', async () => {
    axiosGet.mockRejectedValue(upstreamError(500));

    const failure = await client.guardrailStatus().catch((e) => e);
    expect(failure).toBeInstanceOf(HttpException);
    expect((failure as HttpException).getStatus()).toBe(500);
  });

  it('maps a transport error (no response) to 503', async () => {
    axiosGet.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(client.nlpStatus()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
