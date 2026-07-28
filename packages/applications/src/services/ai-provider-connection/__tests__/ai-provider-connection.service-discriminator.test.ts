/**
 * ProviderConnectionService — the UNIFIED plane's `service` discriminator
 * (TASK-569 §3.4). These lock the pieces the pre-unification suites do not:
 *
 *   - C5 governance map is exactly `{ llm, stt, tts }` with the frozen provider
 *     lists; `isCloudByoProvider` is per-service.
 *   - a tenant write is allowed only for a provider LISTED UNDER ITS SERVICE
 *     (`(stt,azure-speech)` yes, `(stt,ollama)` no, `(tts,openai)` no).
 *   - the `service` discriminator round-trips through the factory/entity/DTO.
 *   - `resolveTenantCloudOverrides(service, t)` injects only that service's
 *     listed providers — no cross-service leak; the deprecated 1-arg form
 *     assumes `service='llm'`.
 *   - the masked read DTO carries `service` and never the ciphertext.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { AiProviderConnectionFactory, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { AiProviderConnectionService } from '../ai-provider-connection.service';
import { CLOUD_BYO_PROVIDERS, isCloudByoProvider, type ProviderService } from '../constants';

const TENANT = 'tenant-abc';

function makeRow(
  service: ProviderService,
  provider: string,
  overrides: { enabled?: boolean; baseUrl?: string | null; region?: string | null; withKey?: boolean } = {},
) {
  return AiProviderConnectionFactory.CreateAiProviderConnection({
    tenantId: TENANT,
    service,
    provider,
    baseUrl: overrides.baseUrl ?? null,
    region: overrides.region ?? null,
    enabled: overrides.enabled ?? true,
    encryptedApiKey: overrides.withKey === false ? null : Buffer.from('vault:v3:cipher', 'utf8'),
    keyVersion: overrides.withKey === false ? null : 3,
  });
}

function makeService(opts: { roles?: string[]; rows?: unknown[] } = {}) {
  const repo = {
    findByTenantServiceProvider: vi.fn().mockResolvedValue(null),
    findDeletedByTenantServiceProvider: vi.fn().mockResolvedValue(null),
    findByTenantIdAndService: vi.fn().mockResolvedValue(opts.rows ?? []),
    create: vi.fn(async (e: any) => e),
    updateWithVersion: vi.fn(async (_id: string, e: any) => e),
    softDelete: vi.fn(),
  };
  const emitter = { emit: vi.fn() };
  const cls = {
    get: vi.fn((k: string) => (k === 'user' ? { id: 'u1', roles: opts.roles ?? [] } : k === 'tenantId' ? TENANT : undefined)),
  };
  const db = { baseClient: { $lane: 'unscoped-base-client' } };
  const secrets = { encrypt: vi.fn(async () => 'vault:v3:cipher'), decrypt: vi.fn(async () => Buffer.from('plaintext-key', 'utf8')) };
  const svc = new AiProviderConnectionService(repo as any, db as any, emitter as any, cls as any, secrets as any);
  vi.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
  return { svc, repo };
}

beforeEach(() => vi.clearAllMocks());

// ===========================================================================
// C5 governance map
// ===========================================================================

describe('CLOUD_BYO_PROVIDERS — the frozen C5 map', () => {
  it('is exactly the per-service map from the program contract', () => {
    expect(CLOUD_BYO_PROVIDERS).toEqual({
      llm: ['azure', 'bedrock', 'openai', 'anthropic', 'vertex'],
      stt: ['azure-speech', 'sarvam', 'openai'],
      tts: ['azure', 'sarvam'],
    });
  });

  it('isCloudByoProvider is per-service', () => {
    expect(isCloudByoProvider('llm', 'azure')).toBe(true);
    expect(isCloudByoProvider('llm', 'azure-speech')).toBe(false);
    expect(isCloudByoProvider('stt', 'azure-speech')).toBe(true);
    expect(isCloudByoProvider('stt', 'azure')).toBe(false);
    expect(isCloudByoProvider('tts', 'azure')).toBe(true);
    expect(isCloudByoProvider('tts', 'openai')).toBe(false);
    expect(isCloudByoProvider('llm', 'openai')).toBe(true);
  });

  it('the deprecated 1-arg form assumes service=llm', () => {
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    expect(isCloudByoProvider('azure')).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    expect(isCloudByoProvider('azure-speech')).toBe(false);
  });
});

// ===========================================================================
// Per-service write governance
// ===========================================================================

describe('assertWriteAllowed — per-service tenant lane', () => {
  it('allows (stt, azure-speech) and (tts, sarvam), rejects (stt, ollama) and (tts, openai)', async () => {
    const { svc, repo } = makeService();
    await expect(svc.upsertRow('stt', 'azure-speech', { enabled: true }, TENANT)).resolves.toBeDefined();
    await expect(svc.upsertRow('tts', 'sarvam', { enabled: true }, TENANT)).resolves.toBeDefined();
    expect(repo.create).toHaveBeenCalledTimes(2);

    await expect(svc.upsertRow('stt', 'ollama', { enabled: true }, TENANT)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.upsertRow('tts', 'openai', { enabled: true }, TENANT)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('still gates SYSTEM writes on global admin regardless of service', async () => {
    const { svc } = makeService({ roles: [] });
    await expect(svc.upsertRow('stt', 'azure-speech', { enabled: true }, SYSTEM_TENANT_ID)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

// ===========================================================================
// service round-trips through factory/entity/DTO
// ===========================================================================

describe('service discriminator round-trip', () => {
  it('stamps the service on the created entity and the masked response', async () => {
    const { svc, repo } = makeService();
    const res = await svc.upsertRow('stt', 'azure-speech', { enabled: true, apiKey: 'sk-x' }, TENANT);
    const created = repo.create.mock.calls[0][0];
    expect(created.service).toBe('stt');
    expect(res.service).toBe('stt');
    expect(res.provider).toBe('azure-speech');
    // masked — carries service + hasKey, never the ciphertext
    expect(res.hasKey).toBe(true);
    expect(JSON.stringify(res)).not.toContain('cipher');
    expect(Object.keys(res)).not.toContain('encryptedApiKey');
  });

  it('getRow placeholder carries the requested service', async () => {
    const { svc } = makeService();
    const res = await svc.getRow('tts', 'azure', TENANT);
    expect(res.service).toBe('tts');
    expect(res.version).toBe(0);
  });

  it('resolveConnection tags the resolved connection with its service', async () => {
    const { svc, repo } = makeService({ roles: ['GLOBAL_ADMIN'] });
    repo.findByTenantServiceProvider.mockImplementation(async (service: string, _p: string, tenantId: string) =>
      tenantId === TENANT ? makeRow(service as ProviderService, 'azure-speech', { enabled: true }) : null,
    );
    const resolved = await svc.resolveConnection('stt', 'azure-speech', TENANT);
    expect(resolved?.service).toBe('stt');
    expect(resolved?.source).toBe('tenant');
  });
});

// ===========================================================================
// resolveTenantCloudOverrides — per-service, no cross-service leak
// ===========================================================================

describe('resolveTenantCloudOverrides — service-scoped injection', () => {
  it("injects only the requested service's listed providers", async () => {
    // The stt lane returns an stt-listed provider row → injected.
    const { svc } = makeService({ rows: [makeRow('stt', 'azure-speech', { region: 'eastus' })] });
    await expect(svc.resolveTenantCloudOverrides('stt', TENANT)).resolves.toEqual({
      'azure-speech': { api_key: 'plaintext-key', region: 'eastus' },
    });
  });

  it('does NOT inject a row whose provider is not listed for the requested service', async () => {
    // An 'azure' row surfaced while resolving service='stt' is skipped (azure is
    // an llm/tts provider, not an stt provider) — no cross-service leak.
    const { svc } = makeService({ rows: [makeRow('stt', 'azure')] });
    await expect(svc.resolveTenantCloudOverrides('stt', TENANT)).resolves.toEqual({});
  });

  it('the deprecated 1-arg form resolves the llm lane', async () => {
    const { svc, repo } = makeService({ rows: [makeRow('llm', 'azure', { baseUrl: 'https://acme.openai.azure.com' })] });
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    await expect(svc.resolveTenantCloudOverrides(TENANT)).resolves.toEqual({
      azure: { api_key: 'plaintext-key', base_url: 'https://acme.openai.azure.com' },
    });
    expect(repo.findByTenantIdAndService.mock.calls[0][0]).toBe('llm');
  });
});
