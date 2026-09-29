/**
 * A tenant's "Test connection" may fall back to the PLATFORM row's stored key
 * (the tenant has no row of its own). That key must only ever be presented to
 * the endpoint the platform admin stored — never to a host the tenant names in
 * the request body — and a platform-only service is invisible to a tenant here
 * exactly as it is on the read route (404).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AiProviderConnectionFactory, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { ProviderConnectionProbe } from '../provider-connection-probe';
import { CONNECTION_ERROR_CODES } from '../constants';

const TENANT = 'tenant-abc';

function connections(rows: Record<string, any> = {}) {
  return {
    assertResolvable: vi.fn(),
    findRow: vi.fn(async (_svc: string, _slug: string, tenantId: string) => rows[tenantId] ?? null),
    findDefaultRow: vi.fn(async (_svc: string, _provider: string, tenantId: string) => rows[tenantId] ?? null),
  };
}

function platformRow(service: string, provider: string, baseUrl: string | null, region: string | null = null) {
  return AiProviderConnectionFactory.CreateAiProviderConnection({
    tenantId: SYSTEM_TENANT_ID,
    service,
    provider,
    baseUrl,
    region,
    enabled: true,
    encryptedApiKey: Buffer.from('vault:v1:cipher', 'utf8'),
    keyVersion: 1,
  } as any);
}

const secrets = { decrypt: vi.fn(async () => Buffer.from('platform-secret', 'utf8')), supportsTransit: vi.fn(() => true) };

describe('ProviderConnectionProbe — the platform key never leaves for a tenant-chosen host', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('S1: tenant, no own row, body baseUrl → 400 and neither decrypt nor fetch happens', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const probe = new ProviderConnectionProbe(
      connections({ [SYSTEM_TENANT_ID]: platformRow('llm', 'openai', 'https://api.openai.com/v1') }) as any,
      secrets as any,
    );

    const call = probe.test('llm', 'openai', TENANT, { baseUrl: 'https://attacker.example' });

    await expect(call).rejects.toBeInstanceOf(BadRequestException);
    await expect(call).rejects.toMatchObject({ response: { code: CONNECTION_ERROR_CODES.PLATFORM_KEY_ENDPOINT_LOCKED } });
    expect(secrets.decrypt).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('S1b: a body region cannot redirect the platform key either (region is interpolated into the host)', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const row = platformRow('stt', 'azure-speech', null, 'eastus');
    const probe = new ProviderConnectionProbe(connections({ [SYSTEM_TENANT_ID]: row }) as any, secrets as any);

    await expect(probe.test('stt', 'azure-speech', TENANT, { region: 'attacker.example#' })).rejects.toBeInstanceOf(BadRequestException);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('S2: tenant, no own row, no endpoint in the body → probes the STORED platform endpoint', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const probe = new ProviderConnectionProbe(
      connections({ [SYSTEM_TENANT_ID]: platformRow('llm', 'openai', 'https://api.openai.com/v1') }) as any,
      secrets as any,
    );

    const res = await probe.test('llm', 'openai', TENANT, {});

    expect(res.source).toBe('platform');
    expect(String((fetchSpy.mock.calls[0] as any)[0])).toBe('https://api.openai.com/v1/models');
  });

  it('S3: a platform-only service is 404 for a tenant — before any row is read', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const conns = connections({ [SYSTEM_TENANT_ID]: platformRow('model-registry', 'huggingface', null) });
    const probe = new ProviderConnectionProbe(conns as any, secrets as any);

    await expect(probe.test('model-registry', 'huggingface', TENANT, {})).rejects.toBeInstanceOf(NotFoundException);
    expect(conns.findDefaultRow).not.toHaveBeenCalled();
    expect(secrets.decrypt).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('S4: the platform admin (SYSTEM scope) may still probe its own row at any endpoint', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const probe = new ProviderConnectionProbe(
      connections({ [SYSTEM_TENANT_ID]: platformRow('model-registry', 'huggingface', null) }) as any,
      secrets as any,
    );

    const res = await probe.test('model-registry', 'huggingface', SYSTEM_TENANT_ID, { baseUrl: 'http://hf-mirror.internal' });

    expect(res.ok).toBe(true);
    expect(String((fetchSpy.mock.calls[0] as any)[0])).toBe('http://hf-mirror.internal/api/whoami-v2');
  });

  it('a tenant testing a key it supplies itself may still name its own https endpoint', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const probe = new ProviderConnectionProbe(
      connections({ [SYSTEM_TENANT_ID]: platformRow('llm', 'openai', 'https://api.openai.com/v1') }) as any,
      secrets as any,
    );

    const res = await probe.test('llm', 'openai', TENANT, { apiKey: 'sk-own', baseUrl: 'https://proxy.example/v1' });

    expect(res.ok).toBe(true);
    expect(secrets.decrypt).not.toHaveBeenCalled();
  });
});
