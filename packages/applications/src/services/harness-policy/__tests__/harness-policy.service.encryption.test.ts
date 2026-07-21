/**
 * HarnessPolicyService — WORM change-row encryption wiring.
 *
 * The before/after policy snapshots on the immutable `HarnessPolicyChange` table
 * are encrypted via the repo's `encryptPayloads` BEFORE the change row is built,
 * so the factory persists ciphertext + a redaction sentinel in the plaintext
 * JSONB. Best-effort: a Vault failure (or no SecretsService) writes a plaintext
 * change row so policy edits never fail closed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HarnessPolicyFactory, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { HarnessPolicyService } from '../harness-policy.service';

const TENANT = 'tenant-1';
const USER = 'user-1';
const VAULT_PREFIX = 'vault:v1:';

const encJson = (value: unknown): Buffer | null =>
  value === null || value === undefined ? null : Buffer.from(VAULT_PREFIX + Buffer.from(JSON.stringify(value), 'utf8').toString('base64'), 'utf8');

const policyRepository = {
  findForExactTenant: vi.fn(),
  findSystemDefault: vi.fn(),
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

const secretsService = { encrypt: vi.fn(), decrypt: vi.fn() } as any;

function makeService(withSecrets = true): HarnessPolicyService {
  return new HarnessPolicyService(
    policyRepository as never,
    policyChangeRepository as never,
    databaseService as never,
    cls as never,
    withSecrets ? secretsService : undefined,
  );
}

function systemDefaultEntity() {
  return HarnessPolicyFactory.CreateHarnessPolicy({ tenantId: SYSTEM_TENANT_ID, safetyModel: 'system-default-guardian' });
}

describe('HarnessPolicyService — change-row encryption', () => {
  beforeEach(() => vi.clearAllMocks());

  it('encrypts the before/after snapshots on the UPDATE path (sentinel in plaintext)', async () => {
    const own = HarnessPolicyFactory.CreateHarnessPolicy({ tenantId: TENANT, coverageThreshold: 0.8 });
    policyRepository.findForExactTenant.mockResolvedValue(own);
    policyRepository.updateWithVersion.mockImplementation(async (_id, entity) => entity);

    await makeService().updatePolicy({ coverageThreshold: 0.5, reason: 'tighten' }, 1);

    expect(policyChangeRepository.encryptPayloads).toHaveBeenCalledTimes(1);
    const [secretsArg, beforeArg, afterArg] = policyChangeRepository.encryptPayloads.mock.calls[0] as any[];
    expect(secretsArg).toBe(secretsService);
    expect(beforeArg.coverageThreshold).toBe(0.8);
    expect(afterArg.coverageThreshold).toBe(0.5);

    const change = policyChangeRepository.create.mock.calls[0][0] as any;
    expect(Buffer.isBuffer(change.encryptedBeforeJson)).toBe(true);
    expect(Buffer.isBuffer(change.encryptedAfterJson)).toBe(true);
    expect(change.keyVersion).toBe(1);
    expect(change.beforeJson).toEqual({ _encrypted: true });
    expect(change.afterJson).toEqual({ _encrypted: true });
  });

  it('encrypts only afterJson on the CREATE path (beforeJson null stays null)', async () => {
    policyRepository.findForExactTenant.mockResolvedValue(null);
    policyRepository.findSystemDefault.mockResolvedValue(systemDefaultEntity());
    policyRepository.create.mockImplementation(async (entity) => entity);

    await makeService().updatePolicy({ coverageThreshold: 0.5 }, 1);

    const [, beforeArg] = policyChangeRepository.encryptPayloads.mock.calls[0] as any[];
    expect(beforeArg).toBeNull();

    const change = policyChangeRepository.create.mock.calls[0][0] as any;
    expect(change.beforeJson).toBeNull();
    expect(change.encryptedBeforeJson).toBeNull();
    expect(Buffer.isBuffer(change.encryptedAfterJson)).toBe(true);
    expect(change.afterJson).toEqual({ _encrypted: true });
  });

  it('falls back to a plaintext change row when encryption throws', async () => {
    const own = HarnessPolicyFactory.CreateHarnessPolicy({ tenantId: TENANT, coverageThreshold: 0.8 });
    policyRepository.findForExactTenant.mockResolvedValue(own);
    policyRepository.updateWithVersion.mockImplementation(async (_id, entity) => entity);
    policyChangeRepository.encryptPayloads.mockRejectedValueOnce(new Error('vault down'));

    await makeService().updatePolicy({ coverageThreshold: 0.5 }, 1);

    const change = policyChangeRepository.create.mock.calls[0][0] as any;
    expect(change.encryptedBeforeJson ?? null).toBeNull();
    expect(change.encryptedAfterJson ?? null).toBeNull();
    // Plaintext snapshots preserved (legacy shape).
    expect(change.beforeJson.coverageThreshold).toBe(0.8);
    expect(change.afterJson.coverageThreshold).toBe(0.5);
  });

  it('writes plaintext when no SecretsService is injected', async () => {
    const own = HarnessPolicyFactory.CreateHarnessPolicy({ tenantId: TENANT, coverageThreshold: 0.8 });
    policyRepository.findForExactTenant.mockResolvedValue(own);
    policyRepository.updateWithVersion.mockImplementation(async (_id, entity) => entity);

    await makeService(false).updatePolicy({ coverageThreshold: 0.5 }, 1);

    expect(policyChangeRepository.encryptPayloads).not.toHaveBeenCalled();
    const change = policyChangeRepository.create.mock.calls[0][0] as any;
    expect(change.beforeJson.coverageThreshold).toBe(0.8);
    expect(change.afterJson.coverageThreshold).toBe(0.5);
  });
});
