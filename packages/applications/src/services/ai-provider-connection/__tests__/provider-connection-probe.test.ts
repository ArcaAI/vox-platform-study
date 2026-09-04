/**
 * TASK-862 — `ProviderConnectionProbe`, the ephemeral test-connection probe
 * behind `POST admin/providers/:service/:provider/test`.
 *
 * Never persists, never writes Vault; a real AUTH probe where the vendor has
 * an auth-only call, a REACHABILITY smoke test otherwise; SSRF-guarded on every
 * tenant-supplied URL; falls back to the STORED row (tenant → SYSTEM) for any
 * field the body omits, decrypting the stored key for the probe only.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { AiProviderConnectionFactory, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { ProviderConnectionProbe } from '../provider-connection-probe';

const TENANT = 'tenant-abc';

function connections(rows: Record<string, any> = {}) {
  return {
    assertResolvable: vi.fn(),
    findRow: vi.fn(async (_svc: string, _provider: string, tenantId: string) => rows[tenantId] ?? null),
  };
}

function storedRow(tenantId: string, over: Partial<{ baseUrl: string; region: string; withKey: boolean }> = {}) {
  return AiProviderConnectionFactory.CreateAiProviderConnection({
    tenantId,
    service: 'llm',
    provider: 'openai',
    baseUrl: over.baseUrl ?? null,
    region: over.region ?? null,
    enabled: true,
    encryptedApiKey: over.withKey === false ? null : Buffer.from('vault:v3:cipher', 'utf8'),
    keyVersion: over.withKey === false ? null : 3,
  });
}

const secrets = { decrypt: vi.fn(async () => Buffer.from('stored-key', 'utf8')), supportsTransit: vi.fn(() => true) };

describe('ProviderConnectionProbe — auth probes', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('OpenAI: GET /models with the bearer key — 200 is an auth success from the request body', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const probe = new ProviderConnectionProbe(connections() as any, secrets as any);

    const res = await probe.test('llm', 'openai', TENANT, { apiKey: 'sk-test', baseUrl: 'https://api.openai.com/v1' });

    expect(res).toEqual({ ok: true, message: 'Connected — key accepted', probe: 'auth', source: 'request' });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe('https://api.openai.com/v1/models');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
  });

  it('OpenAI: 401 is an auth rejection, never a throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401 })));
    const probe = new ProviderConnectionProbe(connections() as any, secrets as any);
    const res = await probe.test('llm', 'openai', TENANT, { apiKey: 'bad', baseUrl: 'https://api.openai.com/v1' });
    expect(res.ok).toBe(false);
    expect(res.probe).toBe('auth');
    expect(res.message).toMatch(/invalid key/);
  });

  it('classic Azure Speech: POSTs the STS issuetoken endpoint for the region with the subscription key', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const probe = new ProviderConnectionProbe(connections() as any, secrets as any);

    const res = await probe.test('stt', 'azure-speech', TENANT, { apiKey: 'az', region: 'eastus', baseUrl: '' });

    expect(res.ok).toBe(true);
    expect(res.probe).toBe('auth');
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://eastus.api.cognitive.microsoft.com/sts/v1.0/issuetoken');
  });

  it('Azure OpenAI: lists deployments with the api-key header and refuses an unlisted deploymentName', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'gpt-4o-mini' }] }) })));
    const probe = new ProviderConnectionProbe(connections() as any, secrets as any);
    const res = await probe.test('llm', 'azure', TENANT, {
      apiKey: 'k',
      baseUrl: 'https://my-res.openai.azure.com',
      apiVersion: '2024-10-21',
      deploymentName: 'does-not-exist',
    });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/not listed/);
  });

  it('reports a MISSING key rather than probing anonymously', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const probe = new ProviderConnectionProbe(connections() as any, secrets as any);
    const res = await probe.test('llm', 'openai', TENANT, { baseUrl: 'https://api.openai.com/v1' });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/No key to test/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('ProviderConnectionProbe — reachability probes', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('Sarvam: HEAD smoke test that says so — it never claims the key was verified', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })));
    const probe = new ProviderConnectionProbe(connections() as any, secrets as any);
    const res = await probe.test('stt', 'sarvam', TENANT, { apiKey: 'sv', baseUrl: 'https://api.sarvam.ai' });
    expect(res.ok).toBe(true);
    expect(res.probe).toBe('reachability');
    expect(res.message).toMatch(/verified on first request/);
  });

  it('ambient-credential providers (bedrock) have nothing to probe and say so', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const probe = new ProviderConnectionProbe(connections() as any, secrets as any);
    const res = await probe.test('llm', 'bedrock', TENANT, { region: 'us-east-1', apiKey: 'x', baseUrl: '' });
    expect(res.ok).toBe(true);
    expect(res.probe).toBe('reachability');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('ProviderConnectionProbe — SSRF guard', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects http and private/loopback targets for a tenant WITHOUT a network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const probe = new ProviderConnectionProbe(connections() as any, secrets as any);
    await expect(probe.test('llm', 'openai', TENANT, { apiKey: 'k', baseUrl: 'http://example.com' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(probe.test('llm', 'openai', TENANT, { apiKey: 'k', baseUrl: 'https://169.254.169.254/v1' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(probe.test('llm', 'openai', TENANT, { apiKey: 'k', baseUrl: 'https://localhost/v1' })).rejects.toBeInstanceOf(BadRequestException);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('relaxes to plain http for the SYSTEM tenant probing an in-cluster self-host engine', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const probe = new ProviderConnectionProbe(connections() as any, secrets as any);
    const res = await probe.test('llm', 'lm-studio', SYSTEM_TENANT_ID, { apiKey: 'placeholder', baseUrl: 'http://hope-lmstudio:1234/v1' });
    expect(res.ok).toBe(true);
    expect(res.probe).toBe('reachability');
  });
});

describe('ProviderConnectionProbe — stored-row fallback', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("decrypts the tenant's STORED key when the body omits apiKey, and reports source=tenant", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const probe = new ProviderConnectionProbe(connections({ [TENANT]: storedRow(TENANT, { baseUrl: 'https://api.openai.com/v1' }) }) as any, secrets as any);

    const res = await probe.test('llm', 'openai', TENANT, {});

    expect(res.ok).toBe(true);
    expect(res.source).toBe('tenant');
    const [, init] = fetchSpy.mock.calls[0] as unknown as [URL, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer stored-key');
    expect(secrets.decrypt).toHaveBeenCalled();
  });

  it('widens to the SYSTEM row only when the tenant has none, and reports source=platform', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })));
    const probe = new ProviderConnectionProbe(connections({ [SYSTEM_TENANT_ID]: storedRow(SYSTEM_TENANT_ID, { baseUrl: 'https://api.openai.com/v1' }) }) as any, secrets as any);
    const res = await probe.test('llm', 'openai', TENANT, {});
    expect(res.source).toBe('platform');
  });

  it('a supplied apiKey wins over the stored one and is never persisted', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const conns = connections({ [TENANT]: storedRow(TENANT, { baseUrl: 'https://api.openai.com/v1' }) });
    const probe = new ProviderConnectionProbe(conns as any, secrets as any);
    await probe.test('llm', 'openai', TENANT, { apiKey: 'fresh-key' });
    const [, init] = fetchSpy.mock.calls[0] as unknown as [URL, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fresh-key');
    expect(secrets.decrypt).not.toHaveBeenCalled();
  });
});
