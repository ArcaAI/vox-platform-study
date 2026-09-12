/**
 * TASK-932 — the PLATFORM half of the provider plane.
 *
 * Three owner rules land here, and each one is a decision the previous shape got
 * wrong rather than merely missed:
 *
 *  R-12 — SCOPE IS THE WORKING TENANT. A customer tenant may see only the cloud
 *         providers it can bring an account for. The built-in engines and the
 *         whole `model-registry` plane are platform infrastructure, so a tenant
 *         read of one is a **404** (existence, the house posture) even though a
 *         tenant WRITE of one has always been a 403 (privilege on its own
 *         tenant). The two are deliberately different answers to different
 *         questions.
 *
 *  R-3  — RESET. `DELETE` is not "back to the default": `apps/text` resolves a
 *         self-hosted engine's base URL only from the injected override fold, so
 *         a deleted SYSTEM row is a 503 on every generation. Reset REWRITES from
 *         `BUILT_IN_CONNECTION_DEFAULTS`, super-admin only, SYSTEM tier only.
 *
 *  R-11/D-7 — THE WEIGHT STORE IS A DEFAULT, NOT AN ABSENCE. An enabled,
 *         keyless `model-registry:s3` row resolves to the platform's OWN object
 *         storage. Reached only AFTER the veto and the entitlement gate, so a
 *         tenant that vetoed the plane still gets `denied` — never a silently
 *         substituted platform credential.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AiProviderConnectionFactory, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { AiProviderConnectionService } from '../ai-provider-connection.service';
import { BUILT_IN_CONNECTION_DEFAULTS } from '../built-in-defaults';
import { withTask958Lookups } from './task958-repo-lookups';

const TENANT = 'tenant-abc';

function row(overrides: Partial<Parameters<typeof AiProviderConnectionFactory.CreateAiProviderConnection>[0]> = {}) {
  return AiProviderConnectionFactory.CreateAiProviderConnection({
    tenantId: SYSTEM_TENANT_ID,
    service: 'llm',
    provider: 'lm-studio',
    baseUrl: null,
    enabled: true,
    ...overrides,
  } as never);
}

interface Opts {
  roles?: string[];
  clsTenantId?: string | null;
  rows?: Record<string, ReturnType<typeof row>>;
  deletedRows?: Record<string, ReturnType<typeof row>>;
  storageRows?: unknown[];
  secretsByKey?: Record<string, string>;
  withStorage?: boolean;
}

function makeService(opts: Opts = {}) {
  const stored = opts.rows ?? {};
  const deleted = opts.deletedRows ?? {};
  const repo = withTask958Lookups({
    findByTenantServiceProvider: vi.fn(
      async (service: string, provider: string, tenantId: string) => stored[`${tenantId}:${service}:${provider}`] ?? null,
    ),
    findDeletedByTenantServiceProvider: vi.fn(
      async (service: string, provider: string, tenantId: string) => deleted[`${tenantId}:${service}:${provider}`] ?? null,
    ),
    findByTenantIdAndService: vi.fn(async (service: string, tenantId: string) =>
      Object.entries(stored)
        .filter(([key]) => key.startsWith(`${tenantId}:${service}:`))
        .map(([, value]) => value),
    ),
    create: vi.fn(async (e: any) => e),
    updateWithVersion: vi.fn(async (_id: string, e: any) => e),
    softDelete: vi.fn(),
  });
  const emitter = { emit: vi.fn() };
  const clsTenantId = opts.clsTenantId === undefined ? TENANT : opts.clsTenantId;
  const cls = { get: vi.fn((k: string) => (k === 'user' ? { id: 'u1', roles: opts.roles ?? [] } : k === 'tenantId' ? clsTenantId : undefined)) };
  const db = { baseClient: { $lane: 'unscoped-base-client' } };
  const secretsByKey = opts.secretsByKey ?? {};
  const secrets = {
    encrypt: vi.fn(async () => 'vault:v3:cipher'),
    decrypt: vi.fn(async () => Buffer.from('plaintext-key', 'utf8')),
    supportsTransit: vi.fn(() => true),
    getSecretOptional: vi.fn(async (key: string) => secretsByKey[key]),
  };
  const entitlements = { isFeatureEnabled: vi.fn(async () => true), assertQuantityQuota: vi.fn() };
  const storageRepo = opts.withStorage === false ? undefined : { findAllTenantDefaults: vi.fn(async () => opts.storageRows ?? []) };
  const appSettings = { getValueWithDefault: vi.fn((_key: string, fallback: unknown) => fallback) };

  const svc = new AiProviderConnectionService(
    repo as any,
    db as any,
    emitter as any,
    cls as any,
    secrets as any,
    entitlements as any,
    undefined,
    storageRepo as any,
    appSettings as any,
  );
  return { svc, repo, emitter, storageRepo, secrets };
}

// ===========================================================================
// R-12 — what a TIER may see
// ===========================================================================

describe('read scope follows the tier (R-12)', () => {
  it('hides a built-in engine from a customer tenant with 404, not 403', async () => {
    const { svc } = makeService();
    await expect(svc.getRow('llm', 'lm-studio', TENANT)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('hides the whole model-registry plane from a customer tenant', async () => {
    const { svc } = makeService();
    await expect(svc.getRow('model-registry', 's3', TENANT)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.getRow('model-registry', 'huggingface', TENANT)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('still serves a cloud BYO provider to a customer tenant — that is the whole tenant surface', async () => {
    const { svc } = makeService();
    const res = await svc.getRow('llm', 'azure', TENANT);
    expect(res.provider).toBe('azure');
    expect(res.version).toBe(0);
  });

  it('leaves the SYSTEM tier complete — the platform sees what it owns', async () => {
    const { svc } = makeService({ roles: ['SUPER_ADMIN'] });
    const res = await svc.getRow('llm', 'lm-studio', SYSTEM_TENANT_ID);
    expect(res.provider).toBe('lm-studio');
  });

  it('filters a tenant LIST down to the BYO providers only', async () => {
    const { svc } = makeService({
      rows: {
        [`${TENANT}:llm:azure`]: row({ tenantId: TENANT, provider: 'azure' }),
        [`${TENANT}:llm:lm-studio`]: row({ tenantId: TENANT, provider: 'lm-studio' }),
      },
    });
    const res = await svc.list('llm', TENANT);
    expect(res.map((r) => r.provider)).toEqual(['azure']);
  });

  it('does not filter the SYSTEM list', async () => {
    const { svc } = makeService({
      roles: ['SUPER_ADMIN'],
      rows: {
        [`${SYSTEM_TENANT_ID}:llm:azure`]: row({ provider: 'azure' }),
        [`${SYSTEM_TENANT_ID}:llm:lm-studio`]: row({ provider: 'lm-studio' }),
      },
    });
    const res = await svc.list('llm', SYSTEM_TENANT_ID);
    expect(res.map((r) => r.provider).sort()).toEqual(['azure', 'lm-studio']);
  });
});

// ===========================================================================
// R-3 — reset to the built-in default
// ===========================================================================

describe('resetRow (R-3)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses a caller who is not a platform super admin — 403, for every provider alike', async () => {
    const { svc } = makeService();
    await expect(svc.resetRow('llm', 'lm-studio', SYSTEM_TENANT_ID)).rejects.toBeInstanceOf(ForbiddenException);
    // Row-INDEPENDENT: the same answer for a provider that ships no default, so
    // the privilege check leaks no existence oracle over the provider id space.
    await expect(svc.resetRow('llm', 'azure', SYSTEM_TENANT_ID)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('404s a provider that ships no built-in default', async () => {
    const { svc } = makeService({ roles: ['SUPER_ADMIN'] });
    await expect(svc.resetRow('llm', 'azure', SYSTEM_TENANT_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses the tenant tier — built-in defaults live on the platform tier only', async () => {
    const { svc } = makeService({ roles: ['SUPER_ADMIN'] });
    await expect(svc.resetRow('llm', 'lm-studio', TENANT)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('restores the endpoint, the enabled state and the self-host placeholder key', async () => {
    const stored = row({ baseUrl: 'http://localhost:1234/v1', enabled: false });
    const { svc, repo } = makeService({ roles: ['SUPER_ADMIN'], rows: { [`${SYSTEM_TENANT_ID}:llm:lm-studio`]: stored } });

    const res = await svc.resetRow('llm', 'lm-studio', SYSTEM_TENANT_ID);

    expect(repo.updateWithVersion).toHaveBeenCalledTimes(1);
    expect(res.baseUrl).toBe(BUILT_IN_CONNECTION_DEFAULTS['llm:lm-studio']!.baseUrl);
    expect(res.enabled).toBe(true);
    // The engine row keeps key material on purpose: the override fold DROPS a
    // keyless row, so "clearing the key" would reproduce the 503 the reset was
    // invoked to fix.
    expect(res.hasKey).toBe(true);
  });

  it('CLEARS an operator token on a model-registry row — that is what its default is', async () => {
    const stored = row({
      service: 'model-registry',
      provider: 'huggingface',
      encryptedApiKey: Buffer.from('vault:v3:cipher', 'utf8'),
      keyVersion: 3,
    });
    const { svc } = makeService({ roles: ['SUPER_ADMIN'], rows: { [`${SYSTEM_TENANT_ID}:model-registry:huggingface`]: stored } });

    const res = await svc.resetRow('model-registry', 'huggingface', SYSTEM_TENANT_ID);
    expect(res.hasKey).toBe(false);
    expect(res.enabled).toBe(true);
  });

  it('restores the platform-storage marker on the weight store', async () => {
    const stored = row({ service: 'model-registry', provider: 's3', baseUrl: 'https://elsewhere.example:9000', extraJson: { accessKeyId: 'AKIA' } });
    const { svc } = makeService({ roles: ['SUPER_ADMIN'], rows: { [`${SYSTEM_TENANT_ID}:model-registry:s3`]: stored } });

    const res = await svc.resetRow('model-registry', 's3', SYSTEM_TENANT_ID);
    expect(res.baseUrl).toBeNull();
    expect(res.extraJson).toEqual({ inheritsPlatformStorage: true });
  });

  it('writes nothing when a KEYLESS-by-default row is already at the default', async () => {
    const stored = row({
      service: 'model-registry',
      provider: 'huggingface',
      baseUrl: null,
      enabled: true,
      // Pinned to the acting user because `BaseService.updateEntity` stamps
      // `updatedBy` BEFORE applying the changes (recorded defect F-01, rule 05):
      // on a row whose editor is transitioning, a semantically empty write still
      // commits. That is not this method's behaviour to fix, and pinning the
      // field is what keeps this test about idempotence.
      updatedBy: 'u1',
    });
    const { svc, repo, emitter } = makeService({ roles: ['SUPER_ADMIN'], rows: { [`${SYSTEM_TENANT_ID}:model-registry:huggingface`]: stored } });

    await svc.resetRow('model-registry', 'huggingface', SYSTEM_TENANT_ID);
    expect(repo.updateWithVersion).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it('an ENGINE row rewrites its key every time, and lands on the same observable state', async () => {
    // Vault-Transit ciphertext is randomised and opaque: there is no way to ask
    // "does the stored ciphertext already decrypt to the placeholder?" without
    // decrypting it, so a reset that must GUARANTEE the placeholder has to write
    // it. The write is therefore not suppressed for an engine row — but the
    // RESULT is idempotent, which is the property an operator pressing the
    // button twice actually depends on.
    const fallback = BUILT_IN_CONNECTION_DEFAULTS['llm:vllm']!;
    const stored = row({
      provider: 'vllm',
      baseUrl: fallback.baseUrl,
      enabled: true,
      encryptedApiKey: Buffer.from('vault:v3:cipher', 'utf8'),
      keyVersion: 3,
      updatedBy: 'u1',
    });
    const { svc } = makeService({ roles: ['SUPER_ADMIN'], rows: { [`${SYSTEM_TENANT_ID}:llm:vllm`]: stored } });

    const first = await svc.resetRow('llm', 'vllm', SYSTEM_TENANT_ID);
    const second = await svc.resetRow('llm', 'vllm', SYSTEM_TENANT_ID);
    expect(second.baseUrl).toBe(first.baseUrl);
    expect(second.enabled).toBe(first.enabled);
    expect(second.hasKey).toBe(true);
  });

  it('REVIVES a deleted row rather than colliding with its tombstone', async () => {
    const tombstone = row({ provider: 'ollama', baseUrl: null, enabled: false });
    const { svc, repo } = makeService({ roles: ['SUPER_ADMIN'], deletedRows: { [`${SYSTEM_TENANT_ID}:llm:ollama`]: tombstone } });

    const res = await svc.resetRow('llm', 'ollama', SYSTEM_TENANT_ID);
    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.updateWithVersion).toHaveBeenCalledTimes(1);
    expect(res.baseUrl).toBe(BUILT_IN_CONNECTION_DEFAULTS['llm:ollama']!.baseUrl);
  });

  it('creates the row when neither a live nor a deleted one exists', async () => {
    const { svc, repo } = makeService({ roles: ['SUPER_ADMIN'] });
    const res = await svc.resetRow('llm', 'llama-cpp', SYSTEM_TENANT_ID);
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(res.baseUrl).toBe(BUILT_IN_CONNECTION_DEFAULTS['llm:llama-cpp']!.baseUrl);
  });
});

// ===========================================================================
// R-11 / D-7 — the weight store's built-in default
// ===========================================================================

describe('model-registry:s3 resolves to the platform storage (D-7)', () => {
  const STORAGE_SECRETS = { S3_ACCESS_KEY: 'platform-access-key', S3_SECRET_KEY: 'platform-secret-key' };
  const SYSTEM_STORAGE_ROW = { provider: 'MINIO', endpoint: 'https://minio.internal:9000', region: 'us-east-1', forcePathStyle: true };

  it('resolves an ENABLED keyless row from the platform storage configuration', async () => {
    const { svc } = makeService({
      rows: {
        [`${SYSTEM_TENANT_ID}:model-registry:s3`]: row({ service: 'model-registry', provider: 's3', extraJson: { inheritsPlatformStorage: true } }),
      },
      storageRows: [SYSTEM_STORAGE_ROW],
      secretsByKey: STORAGE_SECRETS,
    });

    const res = await svc.resolveCredential('model-registry', 's3', SYSTEM_TENANT_ID);
    expect(res.outcome).toBe('resolved');
    expect(res.baseUrl).toBe('https://minio.internal:9000');
    expect(res.apiKey).toBe('platform-secret-key');
    expect(res.extras).toMatchObject({ accessKeyId: 'platform-access-key' });
    expect(res.funding).toBe('platform');
    expect(res.source).toBe('platform-storage');
  });

  it('stays ABSENT when the SYSTEM row is DISABLED — the platform veto is not overridden by a fallback', async () => {
    const { svc } = makeService({
      rows: { [`${SYSTEM_TENANT_ID}:model-registry:s3`]: row({ service: 'model-registry', provider: 's3', enabled: false }) },
      storageRows: [SYSTEM_STORAGE_ROW],
      secretsByKey: STORAGE_SECRETS,
    });

    const res = await svc.resolveCredential('model-registry', 's3', SYSTEM_TENANT_ID);
    expect(res.outcome).toBe('absent');
  });

  it('stays ABSENT when this deployment has no platform storage at all', async () => {
    const { svc } = makeService({
      rows: { [`${SYSTEM_TENANT_ID}:model-registry:s3`]: row({ service: 'model-registry', provider: 's3' }) },
      storageRows: [],
      secretsByKey: {},
    });

    const res = await svc.resolveCredential('model-registry', 's3', SYSTEM_TENANT_ID);
    expect(res.outcome).toBe('absent');
  });

  it('never serves a CUSTOMER tenant the platform storage credential', async () => {
    // D-7 names exactly one lane: `resolveCredential('model-registry','s3', SYSTEM)`.
    // The row the fallback reads is the SYSTEM one WHOEVER asked, so with no
    // tenant condition every tenant inherits the platform's own object-storage
    // secret — a platform credential handed to a customer, and metered
    // `funding: 'platform'` while it happens.
    const { svc } = makeService({
      rows: {
        [`${SYSTEM_TENANT_ID}:model-registry:s3`]: row({ service: 'model-registry', provider: 's3', extraJson: { inheritsPlatformStorage: true } }),
      },
      storageRows: [SYSTEM_STORAGE_ROW],
      secretsByKey: STORAGE_SECRETS,
    });

    const res = await svc.resolveCredential('model-registry', 's3', TENANT);
    expect(res.outcome).toBe('absent');
    expect(res.apiKey).toBeUndefined();
    expect(res.source).toBeUndefined();
  });

  it('never applies to a different provider on the same plane', async () => {
    const { svc } = makeService({
      rows: { [`${SYSTEM_TENANT_ID}:model-registry:huggingface`]: row({ service: 'model-registry', provider: 'huggingface' }) },
      storageRows: [SYSTEM_STORAGE_ROW],
      secretsByKey: STORAGE_SECRETS,
    });

    const res = await svc.resolveCredential('model-registry', 'huggingface', SYSTEM_TENANT_ID);
    expect(res.outcome).toBe('absent');
  });

  it('an EXPLICIT key on the row wins — the built-in default is a fallback, not an override', async () => {
    const explicit = row({
      service: 'model-registry',
      provider: 's3',
      baseUrl: 'https://byo.example:9000',
      encryptedApiKey: Buffer.from('vault:v3:cipher', 'utf8'),
      keyVersion: 3,
      extraJson: { accessKeyId: 'BYO-KEY-ID' },
    });
    const { svc } = makeService({
      rows: { [`${SYSTEM_TENANT_ID}:model-registry:s3`]: explicit },
      storageRows: [SYSTEM_STORAGE_ROW],
      secretsByKey: STORAGE_SECRETS,
    });

    const res = await svc.resolveCredential('model-registry', 's3', SYSTEM_TENANT_ID);
    expect(res.outcome).toBe('resolved');
    expect(res.baseUrl).toBe('https://byo.example:9000');
    expect(res.apiKey).toBe('plaintext-key');
    expect(res.source).toBeUndefined();
  });
});
