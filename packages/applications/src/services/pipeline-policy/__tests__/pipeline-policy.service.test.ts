/**
 * PipelinePolicyService unit tests (TASK-356 Phase 5, Pillar B).
 *
 * Mirrors HarnessPolicyService's gold-standard OCC + WORM behaviour, adapted for
 * the polymorphic (scope/scopeId) realtime-pipeline policy table:
 *  1. getEffective delegates the cascade to ConfigResolver and shapes the trace.
 *  2. getRow returns the raw row (+version+source) or a code-default (version 0).
 *  3. upsertRow CAS-updates under OCC and appends a before/after WORM
 *     `PipelinePolicyChange` in the SAME transaction; first edit creates the row
 *     (beforeJson=null) pinning only the supplied toggles; an idempotent patch is
 *     a no-op; OCC drift propagates and writes NO change row.
 *  4. The per-setting MAX SCOPE is enforced on writes: `harnessEnabled` cannot be
 *     pinned at DOCTOR scope (rejected before any DB write).
 *
 * Repositories + the transactional db service + ConfigResolver are mocked; the
 * REAL domain factory/entity run so change-tracking + validation are exercised.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PipelinePolicyFactory, PipelinePolicyScope, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { HOPE_SETTINGS_REGISTRY } from '../../settings-registry';
import { PipelinePolicyService } from '../pipeline-policy.service';

const TENANT = 'tenant-1';
const DEPT = 'dept-1';
const DOCTOR = 'doctor-1';
const USER = 'user-1';

const policyRepository = {
  findForScope: vi.fn(),
  create: vi.fn(async (entity: unknown) => entity),
  updateWithVersion: vi.fn(async (_id: string, entity: unknown) => entity),
};

const policyChangeRepository = {
  create: vi.fn(async (entity: unknown) => entity),
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
  // TASK-356 Phase 6 (S3) — effective DNA decision (tenant AND doctor).
  resolveEffectiveDnaStyleEnabled: vi.fn(),
};

function makeService(): PipelinePolicyService {
  return new PipelinePolicyService(
    policyRepository as never,
    policyChangeRepository as never,
    databaseService as never,
    cls as never,
    configResolver as never,
  );
}

/**
 * TASK-532 A-2 — a GLOBAL_ADMIN caller. The two locked toggles
 * (`harnessEnabled`, `autoNerEnabled`) are writable only by this caller shape;
 * the default `cls` above is a plain tenant admin (no roles).
 */
const elevatedCls = {
  get: vi.fn((key: string) => {
    if (key === 'tenantId') return TENANT;
    if (key === 'user') return { id: USER, roles: ['GLOBAL_ADMIN'] };
    return undefined;
  }),
};

function makeElevatedService(): PipelinePolicyService {
  return new PipelinePolicyService(
    policyRepository as never,
    policyChangeRepository as never,
    databaseService as never,
    elevatedCls as never,
    configResolver as never,
  );
}

describe('PipelinePolicyService', () => {
  let service: PipelinePolicyService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = makeService();
  });

  describe('getEffective', () => {
    it('delegates to the ConfigResolver and shapes the resolved cascade + trace', async () => {
      configResolver.resolvePipelineToggles.mockResolvedValue({
        autoSummaryEnabled: true,
        autoNerEnabled: false,
        harnessEnabled: true,
        dnaStyleEnabled: false,
        trace: { autoSummaryEnabled: 'tenant', autoNerEnabled: 'department', harnessEnabled: 'system-default', dnaStyleEnabled: 'code-default' },
      });

      const result = await service.getEffective({ tenantId: TENANT, departmentId: DEPT, doctorId: DOCTOR });

      expect(configResolver.resolvePipelineToggles).toHaveBeenCalledWith({ tenantId: TENANT, departmentId: DEPT, doctorId: DOCTOR });
      expect(result.tenantId).toBe(TENANT);
      expect(result.departmentId).toBe(DEPT);
      expect(result.doctorId).toBe(DOCTOR);
      expect(result.harnessEnabled).toBe(true);
      expect(result.autoNerEnabled).toBe(false);
      expect(result.trace.harnessEnabled).toBe('system-default');
    });
  });

  describe('getRow', () => {
    it('returns the tenant row (source=tenant) with its version when present', async () => {
      const row = PipelinePolicyFactory.CreatePipelinePolicy({ tenantId: TENANT, scope: PipelinePolicyScope.TENANT, harnessEnabled: true });
      policyRepository.findForScope.mockResolvedValue(row);

      const result = await service.getRow({ tenantId: TENANT, scope: PipelinePolicyScope.TENANT });

      expect(result.source).toBe('tenant');
      expect(result.harnessEnabled).toBe(true);
      expect(result.scope).toBe(PipelinePolicyScope.TENANT);
      expect(result.version).toBe(1);
    });

    it('returns a code-default (version 0, all toggles null, id null) when no row exists', async () => {
      policyRepository.findForScope.mockResolvedValue(null);

      const result = await service.getRow({ tenantId: TENANT, scope: PipelinePolicyScope.TENANT });

      expect(result.source).toBe('code-default');
      expect(result.id).toBeNull();
      expect(result.version).toBe(0);
      expect(result.autoSummaryEnabled).toBeNull();
      expect(result.harnessEnabled).toBeNull();
    });

    it('tags a SYSTEM-tenant TENANT row as source=system-default', async () => {
      const row = PipelinePolicyFactory.CreatePipelinePolicy({ tenantId: SYSTEM_TENANT_ID, scope: PipelinePolicyScope.TENANT, harnessEnabled: true });
      policyRepository.findForScope.mockResolvedValue(row);

      const result = await service.getRow({ tenantId: SYSTEM_TENANT_ID, scope: PipelinePolicyScope.TENANT });

      expect(result.source).toBe('system-default');
    });

    it('returns a department override row (source=department)', async () => {
      const row = PipelinePolicyFactory.CreatePipelinePolicy({ tenantId: TENANT, scope: PipelinePolicyScope.DEPARTMENT, scopeId: DEPT, autoNerEnabled: false });
      policyRepository.findForScope.mockResolvedValue(row);

      const result = await service.getRow({ tenantId: TENANT, scope: PipelinePolicyScope.DEPARTMENT, scopeId: DEPT });

      expect(result.source).toBe('department');
      expect(result.scopeId).toBe(DEPT);
      expect(result.autoNerEnabled).toBe(false);
    });
  });

  describe('upsertRow', () => {
    it('CAS-updates an existing row and appends a before/after WORM change', async () => {
      const row = PipelinePolicyFactory.CreatePipelinePolicy({ tenantId: TENANT, scope: PipelinePolicyScope.TENANT, harnessEnabled: false });
      policyRepository.findForScope.mockResolvedValue(row);
      policyRepository.updateWithVersion.mockImplementation(async (_id, entity) => entity);

      const result = await makeElevatedService().upsertRow({
        tenantId: TENANT,
        scope: PipelinePolicyScope.TENANT,
        dto: { harnessEnabled: true, reason: 'enable harness' },
        expectedVersion: 1,
      });

      expect(policyRepository.updateWithVersion).toHaveBeenCalledWith(row.id, row, 1, expect.anything());
      expect(result.harnessEnabled).toBe(true);
      expect(result.source).toBe('tenant');
      expect(policyChangeRepository.create).toHaveBeenCalledTimes(1);
      const change = policyChangeRepository.create.mock.calls[0][0] as {
        beforeJson: { harnessEnabled: boolean | null };
        afterJson: { harnessEnabled: boolean | null };
        reason: string | null;
        tenantId: string;
        scope: PipelinePolicyScope;
      };
      expect(change.tenantId).toBe(TENANT);
      expect(change.scope).toBe(PipelinePolicyScope.TENANT);
      expect(change.beforeJson.harnessEnabled).toBe(false);
      expect(change.afterJson.harnessEnabled).toBe(true);
      expect(change.reason).toBe('enable harness');
    });

    it('clears a pinned toggle when the patch sends null (revert to inherit)', async () => {
      const row = PipelinePolicyFactory.CreatePipelinePolicy({ tenantId: TENANT, scope: PipelinePolicyScope.TENANT, harnessEnabled: true });
      policyRepository.findForScope.mockResolvedValue(row);
      policyRepository.updateWithVersion.mockImplementation(async (_id, entity) => entity);

      const result = await makeElevatedService().upsertRow({
        tenantId: TENANT,
        scope: PipelinePolicyScope.TENANT,
        dto: { harnessEnabled: null },
        expectedVersion: 1,
      });

      expect(result.harnessEnabled).toBeNull();
      expect(policyChangeRepository.create).toHaveBeenCalledTimes(1);
    });

    it('is an idempotent no-op when the patch changes nothing (no update, no change row)', async () => {
      const row = PipelinePolicyFactory.CreatePipelinePolicy({ tenantId: TENANT, scope: PipelinePolicyScope.TENANT, harnessEnabled: true });
      policyRepository.findForScope.mockResolvedValue(row);

      const result = await makeElevatedService().upsertRow({
        tenantId: TENANT,
        scope: PipelinePolicyScope.TENANT,
        dto: { harnessEnabled: true },
        expectedVersion: 1,
      });

      expect(result.harnessEnabled).toBe(true);
      expect(policyRepository.updateWithVersion).not.toHaveBeenCalled();
      expect(policyChangeRepository.create).not.toHaveBeenCalled();
    });

    it('creates the row on first edit (beforeJson=null) pinning only the supplied toggles', async () => {
      policyRepository.findForScope.mockResolvedValue(null);
      policyRepository.create.mockImplementation(async (entity) => entity);

      const result = await service.upsertRow({
        tenantId: TENANT,
        scope: PipelinePolicyScope.DEPARTMENT,
        scopeId: DEPT,
        dto: { autoSummaryEnabled: false },
      });

      expect(policyRepository.create).toHaveBeenCalledTimes(1);
      const created = policyRepository.create.mock.calls[0][0] as {
        tenantId: string;
        scope: PipelinePolicyScope;
        scopeId: string | null;
        autoSummaryEnabled: boolean | null;
        autoNerEnabled: boolean | null;
        harnessEnabled: boolean | null;
      };
      expect(created.tenantId).toBe(TENANT);
      expect(created.scope).toBe(PipelinePolicyScope.DEPARTMENT);
      expect(created.scopeId).toBe(DEPT);
      expect(created.autoSummaryEnabled).toBe(false);
      // Unsupplied toggles stay null (inherit), NOT coerced to a default.
      expect(created.autoNerEnabled).toBeNull();
      expect(created.harnessEnabled).toBeNull();

      const change = policyChangeRepository.create.mock.calls[0][0] as { beforeJson: unknown; afterJson: { autoSummaryEnabled: boolean | null } };
      expect(change.beforeJson).toBeNull();
      expect(change.afterJson.autoSummaryEnabled).toBe(false);
      expect(result.source).toBe('department');
    });

    it('propagates OptimisticConcurrencyException and writes NO change row on version drift', async () => {
      const row = PipelinePolicyFactory.CreatePipelinePolicy({ tenantId: TENANT, scope: PipelinePolicyScope.TENANT, harnessEnabled: false });
      policyRepository.findForScope.mockResolvedValue(row);
      policyRepository.updateWithVersion.mockRejectedValue(
        new OptimisticConcurrencyException('PipelinePolicy', row.id, { expectedVersion: 1, currentVersion: 2 }),
      );

      await expect(
        makeElevatedService().upsertRow({ tenantId: TENANT, scope: PipelinePolicyScope.TENANT, dto: { harnessEnabled: true }, expectedVersion: 1 }),
      ).rejects.toBeInstanceOf(OptimisticConcurrencyException);
      expect(policyChangeRepository.create).not.toHaveBeenCalled();
    });

    it('REJECTS pinning harnessEnabled at DOCTOR scope (exceeds its max scope) before any DB write', async () => {
      // Elevated caller: isolates the SCOPE clamp (400) from the TASK-532
      // privilege lock (403) — a tenant admin would now fail on the latter first.
      await expect(
        makeElevatedService().upsertRow({
          tenantId: TENANT,
          scope: PipelinePolicyScope.DOCTOR,
          scopeId: DOCTOR,
          dto: { harnessEnabled: true },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(policyRepository.findForScope).not.toHaveBeenCalled();
      expect(policyRepository.create).not.toHaveBeenCalled();
      expect(policyRepository.updateWithVersion).not.toHaveBeenCalled();
    });

    it('allows pinning harnessEnabled at DEPARTMENT scope (within its max scope)', async () => {
      policyRepository.findForScope.mockResolvedValue(null);
      policyRepository.create.mockImplementation(async (entity) => entity);

      const result = await makeElevatedService().upsertRow({
        tenantId: TENANT,
        scope: PipelinePolicyScope.DEPARTMENT,
        scopeId: DEPT,
        dto: { harnessEnabled: true },
      });

      expect(result.harnessEnabled).toBe(true);
      expect(policyRepository.create).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * TASK-532 work-stream A-2 (E3-L2, OD-2) — guardrail's primary caller (the
   * harness) and NLP auto-extraction may no longer be switched off by a tenant
   * admin. The check is DESCRIPTOR-DRIVEN (`globalOnly` on the registry
   * descriptor), not a second hand-rolled key list in this service.
   */
  describe('upsertRow — globalOnly toggle lock', () => {
    beforeEach(() => {
      policyRepository.findForScope.mockResolvedValue(null);
      policyRepository.create.mockImplementation(async (entity) => entity);
    });

    it.each(['harnessEnabled', 'autoNerEnabled'] as const)(
      'rejects a non-elevated %s write with 403 before any DB read or write',
      async (key) => {
        await expect(
          service.upsertRow({ tenantId: TENANT, scope: PipelinePolicyScope.TENANT, dto: { [key]: false } }),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(policyRepository.findForScope).not.toHaveBeenCalled();
        expect(policyRepository.create).not.toHaveBeenCalled();
        expect(policyChangeRepository.create).not.toHaveBeenCalled();
      },
    );

    it.each(['harnessEnabled', 'autoNerEnabled'] as const)('allows an elevated %s write', async (key) => {
      const result = await makeElevatedService().upsertRow({
        tenantId: TENANT,
        scope: PipelinePolicyScope.TENANT,
        dto: { [key]: false },
      });

      expect((result as unknown as Record<string, unknown>)[key]).toBe(false);
      expect(policyRepository.create).toHaveBeenCalledTimes(1);
    });

    it('leaves the unlocked autoSummaryEnabled writable by a tenant admin', async () => {
      const result = await service.upsertRow({
        tenantId: TENANT,
        scope: PipelinePolicyScope.TENANT,
        dto: { autoSummaryEnabled: false },
      });

      expect(result.autoSummaryEnabled).toBe(false);
      expect(policyRepository.create).toHaveBeenCalledTimes(1);
    });

    it('names every offending key when a mixed patch carries both locked toggles', async () => {
      await expect(
        service.upsertRow({
          tenantId: TENANT,
          scope: PipelinePolicyScope.TENANT,
          dto: { autoSummaryEnabled: false, harnessEnabled: false, autoNerEnabled: false },
        }),
      ).rejects.toThrow(/harnessEnabled[\s\S]*autoNerEnabled|autoNerEnabled[\s\S]*harnessEnabled/);
    });

    it('reads the lock from registry descriptor metadata, not a local list', async () => {
      // Flip the descriptor: the service must follow it. This fails loudly if a
      // hand-rolled key list is reintroduced alongside the descriptor.
      const descriptor = HOPE_SETTINGS_REGISTRY.getOrThrow('pipeline.harnessEnabled');
      const spy = vi.spyOn(HOPE_SETTINGS_REGISTRY, 'getOrThrow').mockImplementation((key: string) => {
        if (key === 'pipeline.harnessEnabled') return { ...descriptor, globalOnly: false };
        return descriptor;
      });

      await expect(
        service.upsertRow({ tenantId: TENANT, scope: PipelinePolicyScope.TENANT, dto: { harnessEnabled: false } }),
      ).resolves.toBeDefined();

      expect(spy).toHaveBeenCalledWith('pipeline.harnessEnabled');
      spy.mockRestore();
    });
  });

  // ─── TASK-356 Phase 6 (S3) — per-doctor DNA toggle (DOCTOR-scope write) ────
  describe('getDnaSettings', () => {
    it('delegates to ConfigResolver.resolveEffectiveDnaStyleEnabled and returns the DOCTOR-row OCC version', async () => {
      const row = PipelinePolicyFactory.CreatePipelinePolicy({ tenantId: TENANT, scope: PipelinePolicyScope.DOCTOR, scopeId: DOCTOR, dnaStyleEnabled: false });
      policyRepository.findForScope.mockResolvedValue(row);
      configResolver.resolveEffectiveDnaStyleEnabled.mockResolvedValue({ effective: false, tenantEnabled: true, doctorToggle: false });

      const result = await service.getDnaSettings({ tenantId: TENANT, doctorId: DOCTOR });

      expect(configResolver.resolveEffectiveDnaStyleEnabled).toHaveBeenCalledWith({ tenantId: TENANT, doctorId: DOCTOR });
      expect(result.effective).toBe(false);
      expect(result.tenantEnabled).toBe(true);
      expect(result.doctorToggle).toBe(false);
      expect(result.version).toBe(1);
    });

    it('returns version 0 (no doctor row) with an unset toggle (implicit opt-in follows tenant)', async () => {
      policyRepository.findForScope.mockResolvedValue(null);
      configResolver.resolveEffectiveDnaStyleEnabled.mockResolvedValue({ effective: true, tenantEnabled: true, doctorToggle: null });

      const result = await service.getDnaSettings({ tenantId: TENANT, doctorId: DOCTOR });

      expect(result.version).toBe(0);
      expect(result.doctorToggle).toBeNull();
      expect(result.effective).toBe(true);
    });
  });

  describe('setDnaStyleForDoctor', () => {
    it('creates the DOCTOR row on first write (beforeJson=null, afterJson.dnaStyleEnabled=true) + WORM change', async () => {
      policyRepository.findForScope.mockResolvedValue(null);
      policyRepository.create.mockImplementation(async (entity) => entity);
      configResolver.resolveEffectiveDnaStyleEnabled.mockResolvedValue({ effective: true, tenantEnabled: true, doctorToggle: true });

      const result = await service.setDnaStyleForDoctor({ tenantId: TENANT, doctorId: DOCTOR, enabled: true, reason: 'doctor opt-in' });

      expect(policyRepository.create).toHaveBeenCalledTimes(1);
      const created = policyRepository.create.mock.calls[0][0] as {
        scope: PipelinePolicyScope;
        scopeId: string | null;
        dnaStyleEnabled: boolean | null;
      };
      expect(created.scope).toBe(PipelinePolicyScope.DOCTOR);
      expect(created.scopeId).toBe(DOCTOR);
      expect(created.dnaStyleEnabled).toBe(true);

      const change = policyChangeRepository.create.mock.calls[0][0] as {
        scope: PipelinePolicyScope;
        beforeJson: unknown;
        afterJson: { dnaStyleEnabled: boolean | null };
        reason: string | null;
      };
      expect(change.scope).toBe(PipelinePolicyScope.DOCTOR);
      expect(change.beforeJson).toBeNull();
      expect(change.afterJson.dnaStyleEnabled).toBe(true);
      expect(change.reason).toBe('doctor opt-in');
      expect(result.effective).toBe(true);
      expect(result.doctorToggle).toBe(true);
    });

    it('CAS-updates an existing DOCTOR row to opt-out (false) with a before/after WORM change', async () => {
      const row = PipelinePolicyFactory.CreatePipelinePolicy({ tenantId: TENANT, scope: PipelinePolicyScope.DOCTOR, scopeId: DOCTOR, dnaStyleEnabled: true });
      policyRepository.findForScope.mockResolvedValue(row);
      policyRepository.updateWithVersion.mockImplementation(async (_id, entity) => entity);
      configResolver.resolveEffectiveDnaStyleEnabled.mockResolvedValue({ effective: false, tenantEnabled: true, doctorToggle: false });

      const result = await service.setDnaStyleForDoctor({ tenantId: TENANT, doctorId: DOCTOR, enabled: false, reason: 'opt out', expectedVersion: 1 });

      expect(policyRepository.updateWithVersion).toHaveBeenCalledWith(row.id, row, 1, expect.anything());
      const change = policyChangeRepository.create.mock.calls[0][0] as {
        beforeJson: { dnaStyleEnabled: boolean | null };
        afterJson: { dnaStyleEnabled: boolean | null };
      };
      expect(change.beforeJson.dnaStyleEnabled).toBe(true);
      expect(change.afterJson.dnaStyleEnabled).toBe(false);
      // Effective honors the tenant gate (tenant on, doctor opted out ⇒ off).
      expect(result.effective).toBe(false);
      expect(result.doctorToggle).toBe(false);
    });

    it('is an idempotent no-op when the toggle is unchanged (no update, no change row)', async () => {
      const row = PipelinePolicyFactory.CreatePipelinePolicy({ tenantId: TENANT, scope: PipelinePolicyScope.DOCTOR, scopeId: DOCTOR, dnaStyleEnabled: true });
      policyRepository.findForScope.mockResolvedValue(row);
      configResolver.resolveEffectiveDnaStyleEnabled.mockResolvedValue({ effective: true, tenantEnabled: true, doctorToggle: true });

      const result = await service.setDnaStyleForDoctor({ tenantId: TENANT, doctorId: DOCTOR, enabled: true });

      expect(policyRepository.updateWithVersion).not.toHaveBeenCalled();
      expect(policyChangeRepository.create).not.toHaveBeenCalled();
      expect(result.doctorToggle).toBe(true);
    });

    it('does NOT create an empty row when clearing (enabled=null) and no row exists yet', async () => {
      policyRepository.findForScope.mockResolvedValue(null);
      configResolver.resolveEffectiveDnaStyleEnabled.mockResolvedValue({ effective: true, tenantEnabled: true, doctorToggle: null });

      const result = await service.setDnaStyleForDoctor({ tenantId: TENANT, doctorId: DOCTOR, enabled: null });

      expect(policyRepository.create).not.toHaveBeenCalled();
      expect(policyChangeRepository.create).not.toHaveBeenCalled();
      expect(result.version).toBe(0);
      expect(result.doctorToggle).toBeNull();
    });
  });
});
