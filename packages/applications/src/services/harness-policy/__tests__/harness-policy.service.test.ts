/**
 * HarnessPolicyService unit tests (TASK-330 Phase 6).
 *
 * Verifies the three behaviours the admin console + worker depend on:
 *  1. getEffectivePolicy resolves tenant row → system default → code default
 *     ("tenant OVERRIDES global"), tagging the `source`.
 *  2. updatePolicy applies a sparse patch under OCC CAS and appends a WORM
 *     `HarnessPolicyChange` before/after row in the SAME transaction (and the
 *     create path, on first edit, inherits the system default + records
 *     beforeJson=null).
 *  3. OCC drift (repository throws) aborts the transaction so NO change row is
 *     written.
 *
 * Repositories + the transactional db service are mocked; the REAL domain
 * factory/entity run so change-tracking + validation are exercised.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { HarnessPolicyFactory, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { HarnessPolicyService } from '../harness-policy.service';

const TENANT = 'tenant-1';
const USER = 'user-1';

const policyRepository = {
  findForExactTenant: vi.fn(),
  findSystemDefault: vi.fn(),
  create: vi.fn(async (entity: unknown) => entity),
  updateWithVersion: vi.fn(async (_id: string, entity: unknown) => entity),
};

const policyChangeRepository = {
  create: vi.fn(async (entity: unknown) => entity),
};

// $transaction simply runs the callback with a throwaway tx client; the repos
// are mocked, so the tx arg is irrelevant to them.
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

function makeService(): HarnessPolicyService {
  return new HarnessPolicyService(
    policyRepository as never,
    policyChangeRepository as never,
    databaseService as never,
    cls as never,
  );
}

/** A SYSTEM global-default entity (the inherited platform default). */
function systemDefaultEntity() {
  return HarnessPolicyFactory.CreateHarnessPolicy({
    tenantId: SYSTEM_TENANT_ID,
    // A non-default safetyModel proves the create path inherits the system row.
    safetyModel: 'system-default-guardian',
  });
}

describe('HarnessPolicyService', () => {
  let service: HarnessPolicyService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = makeService();
  });

  describe('getEffectivePolicy', () => {
    it('returns the tenant own row (source=tenant) when present', async () => {
      // SMR fields non-null so the TASK-356 D-7 (B1) field-level fallthrough is
      // a no-op here: this case asserts the SYSTEM default is NOT consulted when
      // the own row is fully populated.
      const own = HarnessPolicyFactory.CreateHarnessPolicy({
        tenantId: TENANT,
        coverageThreshold: 0.55,
        smrProvider: 'tenant-prov',
        smrModel: 'tenant-model',
      });
      policyRepository.findForExactTenant.mockResolvedValue(own);

      const result = await service.getEffectivePolicy();

      expect(result.source).toBe('tenant');
      expect(result.tenantId).toBe(TENANT);
      expect(result.coverageThreshold).toBe(0.55);
      expect(result.version).toBe(1);
      expect(policyRepository.findSystemDefault).not.toHaveBeenCalled();
    });

    it('falls back to the system default (source=system-default) when no tenant row', async () => {
      policyRepository.findForExactTenant.mockResolvedValue(null);
      policyRepository.findSystemDefault.mockResolvedValue(systemDefaultEntity());

      const result = await service.getEffectivePolicy();

      expect(result.source).toBe('system-default');
      expect(result.safetyModel).toBe('system-default-guardian');
      expect(result.version).toBe(1);
    });

    it('falls back to the harness code defaults (source=code-default, version 0) when neither exists', async () => {
      policyRepository.findForExactTenant.mockResolvedValue(null);
      policyRepository.findSystemDefault.mockResolvedValue(null);

      const result = await service.getEffectivePolicy();

      expect(result.source).toBe('code-default');
      expect(result.version).toBe(0);
      expect(result.coverageThreshold).toBe(0.8);
      expect(result.entityFaithfulnessThreshold).toBe(1.0);
      expect(result.maxRegen).toBe(2);
      expect(result.id).toBeNull();
    });

    // ── TASK-356 D-7 (T-B1): field-level fallthrough for the two SMR fields ──
    it('fills null SMR fields on the tenant own row from the SYSTEM default (field-level fallthrough)', async () => {
      const own = HarnessPolicyFactory.CreateHarnessPolicy({
        tenantId: TENANT,
        coverageThreshold: 0.55,
        // Pre-Phase-2 tenant row: SMR selection was never set.
        smrProvider: null,
        smrModel: null,
      });
      const sys = HarnessPolicyFactory.CreateHarnessPolicy({
        tenantId: SYSTEM_TENANT_ID,
        smrProvider: 'lm-studio',
        smrModel: 'mlx-community/medgemma-1.5-4b-it',
      });
      policyRepository.findForExactTenant.mockResolvedValue(own);
      policyRepository.findSystemDefault.mockResolvedValue(sys);

      const result = await service.getEffectivePolicy();

      // Still the tenant's own row (source unchanged) but SMR fields inherited.
      expect(result.source).toBe('tenant');
      expect(result.coverageThreshold).toBe(0.55);
      expect(result.smrProvider).toBe('lm-studio');
      expect(result.smrModel).toBe('mlx-community/medgemma-1.5-4b-it');
    });

    it('does NOT override a non-null SMR field on the tenant own row', async () => {
      const own = HarnessPolicyFactory.CreateHarnessPolicy({
        tenantId: TENANT,
        smrProvider: 'ollama',
        smrModel: 'tenant-pinned-model',
      });
      const sys = HarnessPolicyFactory.CreateHarnessPolicy({
        tenantId: SYSTEM_TENANT_ID,
        smrProvider: 'lm-studio',
        smrModel: 'mlx-community/medgemma-1.5-4b-it',
      });
      policyRepository.findForExactTenant.mockResolvedValue(own);
      policyRepository.findSystemDefault.mockResolvedValue(sys);

      const result = await service.getEffectivePolicy();

      expect(result.smrProvider).toBe('ollama');
      expect(result.smrModel).toBe('tenant-pinned-model');
    });
  });

  // ── TASK-356 D-7 (T-B2): the fail-closed SMR selection seam ──
  describe('resolveSmrSelection', () => {
    it('returns {provider, model} resolved from the SYSTEM-default cascade', async () => {
      const sys = HarnessPolicyFactory.CreateHarnessPolicy({
        tenantId: SYSTEM_TENANT_ID,
        smrProvider: 'lm-studio',
        smrModel: 'mlx-community/medgemma-1.5-4b-it',
      });
      policyRepository.findForExactTenant.mockResolvedValue(null);
      policyRepository.findSystemDefault.mockResolvedValue(sys);

      const result = await service.resolveSmrSelection();

      expect(result).toEqual({ provider: 'lm-studio', model: 'mlx-community/medgemma-1.5-4b-it' });
    });

    it('resolves a null-SMR tenant row to the SYSTEM default (field-level fallthrough)', async () => {
      const own = HarnessPolicyFactory.CreateHarnessPolicy({ tenantId: TENANT, smrProvider: null, smrModel: null });
      const sys = HarnessPolicyFactory.CreateHarnessPolicy({
        tenantId: SYSTEM_TENANT_ID,
        smrProvider: 'lm-studio',
        smrModel: 'mlx-community/medgemma-1.5-4b-it',
      });
      policyRepository.findForExactTenant.mockResolvedValue(own);
      policyRepository.findSystemDefault.mockResolvedValue(sys);

      const result = await service.resolveSmrSelection();

      expect(result).toEqual({ provider: 'lm-studio', model: 'mlx-community/medgemma-1.5-4b-it' });
    });

    it('throws (fail-closed) when the cascade yields no model (no tenant row, no SYSTEM default)', async () => {
      policyRepository.findForExactTenant.mockResolvedValue(null);
      policyRepository.findSystemDefault.mockResolvedValue(null);

      await expect(service.resolveSmrSelection()).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws (fail-closed) when the tenant row and the SYSTEM default both leave SMR null', async () => {
      const own = HarnessPolicyFactory.CreateHarnessPolicy({ tenantId: TENANT, smrProvider: null, smrModel: null });
      policyRepository.findForExactTenant.mockResolvedValue(own);
      policyRepository.findSystemDefault.mockResolvedValue(null);

      await expect(service.resolveSmrSelection()).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('updatePolicy', () => {
    it('CAS-updates the existing tenant row and appends a before/after WORM change', async () => {
      const own = HarnessPolicyFactory.CreateHarnessPolicy({ tenantId: TENANT, coverageThreshold: 0.8 });
      policyRepository.findForExactTenant.mockResolvedValue(own);
      policyRepository.updateWithVersion.mockImplementation(async (_id, entity) => entity);

      const result = await service.updatePolicy({ coverageThreshold: 0.5, reason: 'tighten coverage' }, 1);

      // CAS used the provided If-Match version.
      expect(policyRepository.updateWithVersion).toHaveBeenCalledWith(own.id, own, 1, expect.anything());
      // The patch was applied.
      expect(result.coverageThreshold).toBe(0.5);
      expect(result.source).toBe('tenant');
      // A change row was appended with the before/after snapshot.
      expect(policyChangeRepository.create).toHaveBeenCalledTimes(1);
      const change = policyChangeRepository.create.mock.calls[0][0] as {
        beforeJson: { coverageThreshold: number };
        afterJson: { coverageThreshold: number };
        reason: string | null;
        tenantId: string;
      };
      expect(change.tenantId).toBe(TENANT);
      expect(change.beforeJson.coverageThreshold).toBe(0.8);
      expect(change.afterJson.coverageThreshold).toBe(0.5);
      expect(change.reason).toBe('tighten coverage');
    });

    it('is an idempotent no-op when the patch changes nothing (no change row)', async () => {
      const own = HarnessPolicyFactory.CreateHarnessPolicy({ tenantId: TENANT, coverageThreshold: 0.8 });
      policyRepository.findForExactTenant.mockResolvedValue(own);

      const result = await service.updatePolicy({ coverageThreshold: 0.8 }, 1);

      expect(result.coverageThreshold).toBe(0.8);
      expect(policyRepository.updateWithVersion).not.toHaveBeenCalled();
      expect(policyChangeRepository.create).not.toHaveBeenCalled();
    });

    it('creates the tenant row on first edit, inheriting the system default, with beforeJson=null', async () => {
      policyRepository.findForExactTenant.mockResolvedValue(null);
      policyRepository.findSystemDefault.mockResolvedValue(systemDefaultEntity());
      policyRepository.create.mockImplementation(async (entity) => entity);

      const result = await service.updatePolicy({ coverageThreshold: 0.5 }, 1);

      expect(policyRepository.create).toHaveBeenCalledTimes(1);
      const created = policyRepository.create.mock.calls[0][0] as {
        tenantId: string;
        coverageThreshold: number;
        safetyModel: string;
      };
      expect(created.tenantId).toBe(TENANT);
      expect(created.coverageThreshold).toBe(0.5);
      // Unpatched field inherited from the SYSTEM default (not the code default).
      expect(created.safetyModel).toBe('system-default-guardian');

      const change = policyChangeRepository.create.mock.calls[0][0] as { beforeJson: unknown; afterJson: { coverageThreshold: number } };
      expect(change.beforeJson).toBeNull();
      expect(change.afterJson.coverageThreshold).toBe(0.5);
      expect(result.source).toBe('tenant');
    });

    it('propagates OptimisticConcurrencyException and writes NO change row on version drift', async () => {
      const own = HarnessPolicyFactory.CreateHarnessPolicy({ tenantId: TENANT, coverageThreshold: 0.8 });
      policyRepository.findForExactTenant.mockResolvedValue(own);
      policyRepository.updateWithVersion.mockRejectedValue(new OptimisticConcurrencyException('HarnessPolicy', own.id, { expectedVersion: 1, currentVersion: 2 }));

      await expect(service.updatePolicy({ coverageThreshold: 0.5 }, 1)).rejects.toBeInstanceOf(OptimisticConcurrencyException);
      expect(policyChangeRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('updateGlobalDefault', () => {
    it('targets the SYSTEM tenant row and records the change under the SYSTEM tenant', async () => {
      const sys = systemDefaultEntity();
      policyRepository.findForExactTenant.mockResolvedValue(sys);
      policyRepository.updateWithVersion.mockImplementation(async (_id, entity) => entity);

      const result = await service.updateGlobalDefault({ groundednessThreshold: 0.9 }, 1);

      expect(policyRepository.findForExactTenant).toHaveBeenCalledWith(SYSTEM_TENANT_ID);
      expect(result.source).toBe('system-default');
      expect(result.groundednessThreshold).toBe(0.9);
      const change = policyChangeRepository.create.mock.calls[0][0] as { tenantId: string };
      expect(change.tenantId).toBe(SYSTEM_TENANT_ID);
    });
  });
});
