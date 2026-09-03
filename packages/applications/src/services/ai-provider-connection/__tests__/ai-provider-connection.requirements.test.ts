/**
 * the requirement check on the WRITE path.
 *
 * `provider-requirements.test.ts` pins the table and the predicate. This pins
 * that `upsertRow` actually consults it, on BOTH branches (create and update),
 * and — the part a pure-function test cannot reach — that it evaluates the
 * MERGED row rather than the request body. Upsert is partial: omitting `apiKey`
 * means "leave the stored key alone", so an edit that changes only a
 * deployment name on an already-keyed Azure row must be ACCEPTED, and a request
 * that supplies every other field but was never keyed must be REFUSED. A
 * DTO-level check gets both of those backwards.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { AiProviderConnectionFactory, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { AiProviderConnectionService } from '../ai-provider-connection.service';

const SUPER = { roles: ['SUPER_ADMIN'] };

function makeService(opts: { existing?: any } = {}) {
  const repo = {
    findByTenantServiceProvider: vi.fn().mockResolvedValue(opts.existing ?? null),
    findDeletedByTenantServiceProvider: vi.fn().mockResolvedValue(null),
    findByTenantIdAndService: vi.fn().mockResolvedValue([]),
    create: vi.fn(async (e: any) => e),
    updateWithVersion: vi.fn(async (_id: string, e: any) => e),
    softDelete: vi.fn(),
  };
  const emitter = { emit: vi.fn() };
  const cls = {
    get: vi.fn((k: string) => (k === 'user' ? { id: 'u1', roles: SUPER.roles } : k === 'tenantId' ? SYSTEM_TENANT_ID : undefined)),
  };
  const db = { baseClient: {} };
  const secrets = {
    encrypt: vi.fn(async () => 'vault:v3:cipher'),
    decrypt: vi.fn(async () => Buffer.from('plaintext-key', 'utf8')),
    supportsTransit: vi.fn(() => true),
  };
  const entitlements = { isFeatureEnabled: vi.fn(async () => true) };
  const svc = new AiProviderConnectionService(repo as any, db as any, emitter as any, cls as any, secrets as any, entitlements as any);
  return { svc, repo };
}

/** An already-stored, already-keyed Azure row missing only its deployment name. */
function storedAzure(overrides: Record<string, any> = {}) {
  const row = AiProviderConnectionFactory.CreateAiProviderConnection({
    tenantId: SYSTEM_TENANT_ID,
    service: 'llm',
    provider: 'azure',
    baseUrl: 'https://acme.openai.azure.com',
    apiVersion: '2024-10-21',
    deploymentName: null,
    enabled: true,
    encryptedApiKey: Buffer.from('cipher'),
    keyVersion: 3,
    ...overrides,
  });
  return row;
}

describe('upsertRow — create branch', () => {
  it('REFUSES an enabled azure connection with no deployment, naming the field', async () => {
    const { svc, repo } = makeService();
    await expect(
      svc.upsertRow(
        'llm',
        'azure',
        { baseUrl: 'https://acme.openai.azure.com', apiVersion: '2024-10-21', apiKey: 'k', enabled: true, expectedVersion: 0 } as any,
        SYSTEM_TENANT_ID,
      ),
    ).rejects.toThrow(/deploymentName/);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('refuses with ArgumentInvalidException — a 400, not a 500', async () => {
    const { svc } = makeService();
    await expect(
      svc.upsertRow('llm', 'azure', { enabled: true, expectedVersion: 0 } as any, SYSTEM_TENANT_ID),
    ).rejects.toBeInstanceOf(ArgumentInvalidException);
  });

  it('ACCEPTS a keyless lm-studio connection — a self-hosted engine has no vendor account', async () => {
    const { svc, repo } = makeService();
    await svc.upsertRow('llm', 'lm-studio', { baseUrl: 'http://localhost:1234/v1', enabled: true, expectedVersion: 0 } as any, SYSTEM_TENANT_ID);
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(repo.create.mock.calls[0][0].encryptedApiKey).toBeNull();
  });

  it('REFUSES a llama-cpp connection with no model path', async () => {
    const { svc, repo } = makeService();
    await expect(
      svc.upsertRow('llm', 'llama-cpp', { baseUrl: 'http://hope-llama-cpp:8080', enabled: true, expectedVersion: 0 } as any, SYSTEM_TENANT_ID),
    ).rejects.toThrow(/modelPath/);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('ACCEPTS a llama-cpp connection once the model path is supplied', async () => {
    const { svc, repo } = makeService();
    await svc.upsertRow(
      'llm',
      'llama-cpp',
      { baseUrl: 'http://hope-llama-cpp:8080', extraJson: { modelPath: '/models/llama-3.gguf' }, enabled: true, expectedVersion: 0 } as any,
      SYSTEM_TENANT_ID,
    );
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it('REFUSES a huggingface model-registry connection with no token', async () => {
    const { svc } = makeService();
    await expect(
      svc.upsertRow(
        'model-registry',
        'huggingface',
        { extraJson: { model: 'openai/whisper-large-v3' }, enabled: true, expectedVersion: 0 } as any,
        SYSTEM_TENANT_ID,
      ),
    ).rejects.toThrow(/apiKey/);
  });

  it('ACCEPTS a huggingface connection carrying both the model id and the token', async () => {
    const { svc, repo } = makeService();
    await svc.upsertRow(
      'model-registry',
      'huggingface',
      { apiKey: 'hf_xxx', extraJson: { model: 'openai/whisper-large-v3' }, enabled: true, expectedVersion: 0 } as any,
      SYSTEM_TENANT_ID,
    );
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it('ACCEPTS a DISABLED azure row carrying nothing — the veto must stay expressible', async () => {
    const { svc, repo } = makeService();
    await svc.upsertRow('llm', 'azure', { enabled: false, expectedVersion: 0 } as any, SYSTEM_TENANT_ID);
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it('does NOT encrypt before refusing — a bad row must not spend a Vault round trip', async () => {
    const { svc } = makeService();
    await expect(svc.upsertRow('llm', 'azure', { apiKey: 'k', enabled: true, expectedVersion: 0 } as any, SYSTEM_TENANT_ID)).rejects.toThrow();
  });
});

describe('upsertRow — update branch evaluates the MERGED row', () => {
  it('ACCEPTS an edit that supplies only the missing field, keeping the stored key', async () => {
    const existing = storedAzure();
    const { svc, repo } = makeService({ existing });
    await svc.upsertRow('llm', 'azure', { deploymentName: 'gpt-4o-mini' } as any, SYSTEM_TENANT_ID, existing.version);
    expect(repo.updateWithVersion).toHaveBeenCalledTimes(1);
  });

  it('REFUSES an edit that CLEARS a required field on an otherwise complete row', async () => {
    const existing = storedAzure({ deploymentName: 'gpt-4o-mini' });
    const { svc, repo } = makeService({ existing });
    await expect(svc.upsertRow('llm', 'azure', { deploymentName: null } as any, SYSTEM_TENANT_ID, existing.version)).rejects.toThrow(
      /deploymentName/,
    );
    expect(repo.updateWithVersion).not.toHaveBeenCalled();
  });

  it('REFUSES flipping an incomplete row to enabled — enabling is when the fields start to matter', async () => {
    const existing = storedAzure({ enabled: false, deploymentName: null });
    const { svc } = makeService({ existing });
    await expect(svc.upsertRow('llm', 'azure', { enabled: true } as any, SYSTEM_TENANT_ID, existing.version)).rejects.toThrow(/deploymentName/);
  });

  it('ACCEPTS disabling an incomplete row — a veto never needs the vendor fields', async () => {
    const existing = storedAzure({ enabled: true, deploymentName: null, baseUrl: null, apiVersion: null });
    const { svc, repo } = makeService({ existing });
    await svc.upsertRow('llm', 'azure', { enabled: false } as any, SYSTEM_TENANT_ID, existing.version);
    expect(repo.updateWithVersion).toHaveBeenCalledTimes(1);
  });

  it('counts the STORED key, not the request — a keyed row edited without apiKey stays satisfied', async () => {
    const existing = storedAzure({ deploymentName: 'gpt-4o-mini' });
    const { svc, repo } = makeService({ existing });
    await svc.upsertRow('llm', 'azure', { apiVersion: '2025-01-01' } as any, SYSTEM_TENANT_ID, existing.version);
    expect(repo.updateWithVersion).toHaveBeenCalledTimes(1);
  });
});
