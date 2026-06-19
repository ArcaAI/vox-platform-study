/**
 * PipelinePolicyService — WORM change-row encryption wiring (TASK-369 Phase 3D).
 *
 * Every write path (admin `upsertRow` create/update and the doctor self-service
 * `setDnaStyleForDoctor` create/update) encrypts the before/after toggle
 * snapshots via the repo's `encryptPayloads` before building the immutable
 * `PipelinePolicyChange`, persisting ciphertext + a redaction sentinel. The
 * write degrades to plaintext when Vault is unavailable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PipelinePolicyFactory, PipelinePolicyScope } from '@arcaai/domains';
import { PipelinePolicyService } from '../pipeline-policy.service';

const TENANT = 'tenant-1';
const DEPT = 'dept-1';
const DOCTOR = 'doctor-1';
const USER = 'user-1';
const VAULT_PREFIX = 'vault:v1:';

const encJson = (value: unknown): Buffer | null =>
  value === null || value === undefined ? null : Buffer.from(VAULT_PREFIX + Buffer.from(JSON.stringify(value), 'utf8').toString('base64'), 'utf8');

const policyRepository = {
  findForScope: vi.fn(),
  create: vi.fn(async (entity: unknown) => entity),
  updateWithVersion: vi.fn(async (_id: string, entity: unknown) => entity),
};

const policyChangeRepository = {
  create: vi.fn(async (entity: unknown) => entity),
  encryptPayloads: vi.fn(async (_secrets: unknown, before: unknown, after: unknown) => ({
    encryptedBeforeJson: encJson(before),
    encryptedAfterJson: encJson(after),
    keyVersion: 1,
  })),
};

const databaseService = {
  baseClient: { $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb({})) },
};

const cls = {
  get: vi.fn((key: string) => {
    if (key === 'tenantId') return TENANT;
    if (key === 'user') return { id: USER };
    return undefined;
  }),
};

const configResolver = {
  resolvePipelineToggles: vi.fn(),
  resolveEffectiveDnaStyleEnabled: vi.fn(),
};

const secretsService = { encrypt: vi.fn(), decrypt: vi.fn() } as any;

function makeService(withSecrets = true): PipelinePolicyService {
  return new PipelinePolicyService(
    policyRepository as never,
    policyChangeRepository as never,
    databaseService as never,
    cls as never,
    configResolver as never,
    withSecrets ? secretsService : undefined,
  );
}

describe('PipelinePolicyService — change-row encryption', () => {
  beforeEach(() => vi.clearAllMocks());

  it('encrypts before/after on the upsertRow UPDATE path (sentinel in plaintext)', async () => {
    const row = PipelinePolicyFactory.CreatePipelinePolicy({ tenantId: TENANT, scope: PipelinePolicyScope.TENANT, harnessEnabled: false });
    policyRepository.findForScope.mockResolvedValue(row);
    policyRepository.updateWithVersion.mockImplementation(async (_id, entity) => entity);

    await makeService().upsertRow({ tenantId: TENANT, scope: PipelinePolicyScope.TENANT, dto: { harnessEnabled: true }, expectedVersion: 1 });

    expect(policyChangeRepository.encryptPayloads).toHaveBeenCalledTimes(1);
    const [secretsArg, beforeArg, afterArg] = policyChangeRepository.encryptPayloads.mock.calls[0] as any[];
    expect(secretsArg).toBe(secretsService);
    expect(beforeArg.harnessEnabled).toBe(false);
    expect(afterArg.harnessEnabled).toBe(true);

    const change = policyChangeRepository.create.mock.calls[0][0] as any;
    expect(Buffer.isBuffer(change.encryptedBeforeJson)).toBe(true);
    expect(Buffer.isBuffer(change.encryptedAfterJson)).toBe(true);
    expect(change.keyVersion).toBe(1);
    expect(change.beforeJson).toEqual({ _encrypted: true });
    expect(change.afterJson).toEqual({ _encrypted: true });
  });

  it('encrypts only afterJson on the upsertRow CREATE path (beforeJson null stays null)', async () => {
    policyRepository.findForScope.mockResolvedValue(null);
    policyRepository.create.mockImplementation(async (entity) => entity);

    await makeService().upsertRow({ tenantId: TENANT, scope: PipelinePolicyScope.DEPARTMENT, scopeId: DEPT, dto: { autoSummaryEnabled: false } });

    const [, beforeArg] = policyChangeRepository.encryptPayloads.mock.calls[0] as any[];
    expect(beforeArg).toBeNull();

    const change = policyChangeRepository.create.mock.calls[0][0] as any;
    expect(change.beforeJson).toBeNull();
    expect(change.encryptedBeforeJson).toBeNull();
    expect(Buffer.isBuffer(change.encryptedAfterJson)).toBe(true);
    expect(change.afterJson).toEqual({ _encrypted: true });
  });

  it('encrypts the change row on the doctor setDnaStyleForDoctor UPDATE path', async () => {
    const row = PipelinePolicyFactory.CreatePipelinePolicy({ tenantId: TENANT, scope: PipelinePolicyScope.DOCTOR, scopeId: DOCTOR, dnaStyleEnabled: true });
    policyRepository.findForScope.mockResolvedValue(row);
    policyRepository.updateWithVersion.mockImplementation(async (_id, entity) => entity);
    configResolver.resolveEffectiveDnaStyleEnabled.mockResolvedValue({ effective: false, tenantEnabled: true, doctorToggle: false });

    await makeService().setDnaStyleForDoctor({ tenantId: TENANT, doctorId: DOCTOR, enabled: false, expectedVersion: 1 });

    expect(policyChangeRepository.encryptPayloads).toHaveBeenCalledTimes(1);
    const change = policyChangeRepository.create.mock.calls[0][0] as any;
    expect(Buffer.isBuffer(change.encryptedAfterJson)).toBe(true);
    expect(change.afterJson).toEqual({ _encrypted: true });
  });

  it('falls back to a plaintext change row when encryption throws', async () => {
    const row = PipelinePolicyFactory.CreatePipelinePolicy({ tenantId: TENANT, scope: PipelinePolicyScope.TENANT, harnessEnabled: false });
    policyRepository.findForScope.mockResolvedValue(row);
    policyRepository.updateWithVersion.mockImplementation(async (_id, entity) => entity);
    policyChangeRepository.encryptPayloads.mockRejectedValueOnce(new Error('vault down'));

    await makeService().upsertRow({ tenantId: TENANT, scope: PipelinePolicyScope.TENANT, dto: { harnessEnabled: true }, expectedVersion: 1 });

    const change = policyChangeRepository.create.mock.calls[0][0] as any;
    expect(change.encryptedBeforeJson ?? null).toBeNull();
    expect(change.encryptedAfterJson ?? null).toBeNull();
    expect(change.beforeJson.harnessEnabled).toBe(false);
    expect(change.afterJson.harnessEnabled).toBe(true);
  });

  it('writes plaintext when no SecretsService is injected', async () => {
    const row = PipelinePolicyFactory.CreatePipelinePolicy({ tenantId: TENANT, scope: PipelinePolicyScope.TENANT, harnessEnabled: false });
    policyRepository.findForScope.mockResolvedValue(row);
    policyRepository.updateWithVersion.mockImplementation(async (_id, entity) => entity);

    await makeService(false).upsertRow({ tenantId: TENANT, scope: PipelinePolicyScope.TENANT, dto: { harnessEnabled: true }, expectedVersion: 1 });

    expect(policyChangeRepository.encryptPayloads).not.toHaveBeenCalled();
    const change = policyChangeRepository.create.mock.calls[0][0] as any;
    expect(change.beforeJson.harnessEnabled).toBe(false);
    expect(change.afterJson.harnessEnabled).toBe(true);
  });
});
