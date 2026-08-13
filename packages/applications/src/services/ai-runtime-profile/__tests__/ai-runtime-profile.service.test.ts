/**
 * AiRuntimeProfileService — unit tests (tests 6–8).
 *
 * The three contracts locked here:
 *   6. The per-field cascade — a model-scoped profile (`modelSlug = <slug>`)
 *      wins over the provider-level default (`modelSlug = ''`), but ONLY for
 *      fields it actually sets. A null field means "no opinion" and must fall
 *      through to the provider default (and then to nothing = service env).
 *   7. Range clamps at the service layer, so a bad value cannot reach the DB
 *      even if the DTO layer is bypassed (service-to-service calls).
 *   8. Hyperparameters are GLOBAL-ADMIN + SYSTEM-tenant only (owner
 *      expectation E5) — a non-SYSTEM write is a privilege boundary → 403.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { AiRuntimeProfileFactory, SYSTEM_TENANT_ID, SysEventType } from '@arcaai/domains';
import { AiRuntimeProfileService } from '../ai-runtime-profile.service';

const TENANT = 'tenant-abc';

function makeProfile(
  overrides: {
    provider?: string;
    modelSlug?: string;
    temperature?: number | null;
    topP?: number | null;
    maxTokens?: number | null;
    timeoutS?: number | null;
  } = {},
) {
  return AiRuntimeProfileFactory.CreateAiRuntimeProfile({
    tenantId: SYSTEM_TENANT_ID,
    provider: overrides.provider ?? 'lm-studio',
    modelSlug: overrides.modelSlug ?? '',
    temperature: overrides.temperature ?? null,
    topP: overrides.topP ?? null,
    maxTokens: overrides.maxTokens ?? null,
    timeoutS: overrides.timeoutS ?? null,
  });
}

function makeService(opts: { roles?: string[] } = {}) {
  const repo = {
    findByTenantProviderAndModel: vi.fn().mockResolvedValue(null),
    findByTenantId: vi.fn().mockResolvedValue([]),
    create: vi.fn(async (e: any) => e),
    updateWithVersion: vi.fn(async (_id: string, e: any) => e),
    softDelete: vi.fn(),
  };
  const emitter = { emit: vi.fn() };
  const cls = {
    get: vi.fn((k: string) => (k === 'user' ? { id: 'u1', roles: opts.roles ?? ['GLOBAL_ADMIN'] } : k === 'tenantId' ? TENANT : undefined)),
  };
  const db = { baseClient: { $lane: 'unscoped-base-client' } };
  const svc = new AiRuntimeProfileService(repo as any, db as any, emitter as any, cls as any);
  return { svc, repo, emitter };
}

// ===========================================================================
// 6. The per-field cascade
// ===========================================================================

describe('AiRuntimeProfileService — resolveProfile cascade (test 6)', () => {
  it('lets a model-scoped value win over the provider default', async () => {
    const { svc, repo } = makeService();
    repo.findByTenantProviderAndModel.mockImplementation(async (_t: string, _p: string, modelSlug: string) =>
      modelSlug === 'gemma-4' ? makeProfile({ modelSlug: 'gemma-4', temperature: 0.2 }) : makeProfile({ temperature: 0.9 }),
    );

    const resolved = await svc.resolveProfile('lm-studio', 'gemma-4');
    expect(resolved.temperature).toBe(0.2);
  });

  it('falls through a NULL model-scoped field to the provider default, per field', async () => {
    const { svc, repo } = makeService();
    // Model row sets ONLY temperature; provider default sets maxTokens + timeoutS.
    repo.findByTenantProviderAndModel.mockImplementation(async (_t: string, _p: string, modelSlug: string) =>
      modelSlug === 'gemma-4'
        ? makeProfile({ modelSlug: 'gemma-4', temperature: 0.2, maxTokens: null, timeoutS: null })
        : makeProfile({ temperature: 0.9, maxTokens: 2048, timeoutS: 300 }),
    );

    const resolved = await svc.resolveProfile('lm-studio', 'gemma-4');
    expect(resolved.temperature).toBe(0.2); // model wins
    expect(resolved.maxTokens).toBe(2048); // fell through to provider default
    expect(resolved.timeoutS).toBe(300); // fell through to provider default
  });

  it('uses the provider default when no model-scoped row exists', async () => {
    const { svc, repo } = makeService();
    repo.findByTenantProviderAndModel.mockImplementation(async (_t: string, _p: string, modelSlug: string) =>
      modelSlug === '' ? makeProfile({ temperature: 0.9 }) : null,
    );

    const resolved = await svc.resolveProfile('lm-studio', 'gemma-4');
    expect(resolved.temperature).toBe(0.9);
  });

  it('resolves to an all-null profile when neither row exists (service env wins)', async () => {
    const { svc, repo } = makeService();
    repo.findByTenantProviderAndModel.mockResolvedValue(null);

    const resolved = await svc.resolveProfile('lm-studio', 'gemma-4');
    expect(resolved.temperature).toBeNull();
    expect(resolved.maxTokens).toBeNull();
    expect(resolved.isEmpty).toBe(true);
  });

  it('reads profiles from the SYSTEM tenant regardless of the caller tenant', async () => {
    const { svc, repo } = makeService();
    await svc.resolveProfile('lm-studio', 'gemma-4');
    for (const call of repo.findByTenantProviderAndModel.mock.calls) {
      expect(call[0]).toBe(SYSTEM_TENANT_ID);
    }
  });
});

// ===========================================================================
// 7. Range clamps
// ===========================================================================

describe('AiRuntimeProfileService — range validation (test 7)', () => {
  it.each([
    ['temperature', 3],
    ['temperature', -0.1],
    ['topP', 1.5],
    ['topP', -0.2],
  ])('rejects out-of-range %s = %s', async (field, value) => {
    const { svc } = makeService();
    await expect(svc.upsertProfile('lm-studio', '', { [field]: value } as any)).rejects.toBeInstanceOf(ArgumentInvalidException);
  });

  it.each(['maxTokens', 'contextLength', 'maxConcurrent', 'tpmLimit', 'rpmLimit', 'timeoutS', 'keepAliveSeconds'])(
    'rejects a negative %s',
    async (field) => {
      const { svc } = makeService();
      await expect(svc.upsertProfile('lm-studio', '', { [field]: -1 } as any)).rejects.toBeInstanceOf(ArgumentInvalidException);
    },
  );

  it.each([
    ['temperature', 0],
    ['temperature', 2],
    ['topP', 0],
    ['topP', 1],
  ])('accepts boundary value %s = %s', async (field, value) => {
    const { svc, repo } = makeService();
    await svc.upsertProfile('lm-studio', '', { [field]: value } as any);
    expect(repo.create).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 8. Global-admin + SYSTEM-only governance
// ===========================================================================

describe('AiRuntimeProfileService — governance (test 8)', () => {
  it('rejects a write from a non-global-admin with 403', async () => {
    const { svc } = makeService({ roles: [] });
    await expect(svc.upsertProfile('lm-studio', '', { temperature: 0.5 })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects an explicitly non-SYSTEM tenant target with 403', async () => {
    const { svc } = makeService({ roles: ['GLOBAL_ADMIN'] });
    await expect(svc.upsertProfile('lm-studio', '', { temperature: 0.5 }, TENANT)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('pins created rows to the SYSTEM tenant', async () => {
    const { svc, repo } = makeService({ roles: ['GLOBAL_ADMIN'] });
    await svc.upsertProfile('lm-studio', '', { temperature: 0.5 });
    expect(repo.create.mock.calls[0][0].tenantId).toBe(SYSTEM_TENANT_ID);
  });

  it('broadcasts a sys-event on every mutation path', async () => {
    const { svc, repo, emitter } = makeService({ roles: ['GLOBAL_ADMIN'] });

    await svc.upsertProfile('lm-studio', '', { temperature: 0.5 });
    expect(emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.anything());

    emitter.emit.mockClear();
    const existing = makeProfile({ temperature: 0.5 });
    repo.findByTenantProviderAndModel.mockResolvedValue(existing);
    await svc.upsertProfile('lm-studio', '', { temperature: 0.7, expectedVersion: existing.version });
    expect(emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.anything());

    emitter.emit.mockClear();
    await svc.deleteProfile('lm-studio', '');
    expect(emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceDeleted, expect.anything());
  });
});
