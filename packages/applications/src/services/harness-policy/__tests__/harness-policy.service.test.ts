/**
 * HarnessPolicyService unit tests.
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
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { HARNESS_POLICY_DEFAULTS, HarnessPolicyFactory, SYSTEM_TENANT_ID } from '@arcaai/domains';
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
  return new HarnessPolicyService(policyRepository as never, policyChangeRepository as never, databaseService as never, cls as never);
}

// service with the AiTaskDefault-first TEXT routing wired.
const aiTaskDefaultService = {
  getEffective: vi.fn(),
  getRow: vi.fn(),
  upsertRow: vi.fn(),
};

function makeServiceWithAiTaskDefault(): HarnessPolicyService {
  return new HarnessPolicyService(
    policyRepository as never,
    policyChangeRepository as never,
    databaseService as never,
    cls as never,
    undefined, // secretsService
    aiTaskDefaultService as never,
  );
}

/** A SYSTEM global-default entity (the inherited platform default). */
function systemDefaultEntity() {
  return HarnessPolicyFactory.CreateHarnessPolicy({
    tenantId: SYSTEM_TENANT_ID,
    // A non-default gate SLA proves the create path inherits the system row.
    gateSlaSeconds: 12_345,
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
      // TEXT fields non-null so the field-level fallthrough is
      // a no-op here: this case asserts the SYSTEM default is NOT consulted when
      // the own row is fully populated.
      const own = HarnessPolicyFactory.CreateHarnessPolicy({
        tenantId: TENANT,
        coverageThreshold: 0.55,
        textProvider: 'tenant-prov',
        textModel: 'tenant-model',
      });
      policyRepository.findForExactTenant.mockResolvedValue(own);
      policyRepository.findSystemDefault.mockResolvedValue(null);

      const result = await service.getEffectivePolicy();

      expect(result.source).toBe('tenant');
      expect(result.tenantId).toBe(TENANT);
      expect(result.coverageThreshold).toBe(0.55);
      expect(result.version).toBe(1);
      // SYSTEM is always consulted to overlay selection/agentic knobs.
      expect(policyRepository.findSystemDefault).toHaveBeenCalled();
    });

    it('falls back to the system default (source=system-default) when no tenant row', async () => {
      policyRepository.findForExactTenant.mockResolvedValue(null);
      policyRepository.findSystemDefault.mockResolvedValue(systemDefaultEntity());

      const result = await service.getEffectivePolicy();

      expect(result.source).toBe('system-default');
      expect(result.gateSlaSeconds).toBe(12_345);
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

    // ── field-level fallthrough for the two TEXT fields ──
    it('fills null TEXT fields on the tenant own row from the SYSTEM default (field-level fallthrough)', async () => {
      const own = HarnessPolicyFactory.CreateHarnessPolicy({
        tenantId: TENANT,
        coverageThreshold: 0.55,
        // Pre-Phase-2 tenant row: TEXT selection was never set.
        textProvider: null,
        textModel: null,
      });
      const sys = HarnessPolicyFactory.CreateHarnessPolicy({
        tenantId: SYSTEM_TENANT_ID,
        textProvider: 'lm-studio',
        textModel: 'gemma-4-e2b-it-sft-rlvr-medical',
      });
      policyRepository.findForExactTenant.mockResolvedValue(own);
      policyRepository.findSystemDefault.mockResolvedValue(sys);

      const result = await service.getEffectivePolicy();

      // Still the tenant's own row (source unchanged) but TEXT fields inherited.
      expect(result.source).toBe('tenant');
      expect(result.coverageThreshold).toBe(0.55);
      expect(result.textProvider).toBe('lm-studio');
      expect(result.textModel).toBe('gemma-4-e2b-it-sft-rlvr-medical');
    });

    it('SYSTEM TEXT selection wins over a non-null tenant-row TEXT field', async () => {
      const own = HarnessPolicyFactory.CreateHarnessPolicy({
        tenantId: TENANT,
        textProvider: 'ollama',
        textModel: 'tenant-pinned-model',
      });
      const sys = HarnessPolicyFactory.CreateHarnessPolicy({
        tenantId: SYSTEM_TENANT_ID,
        textProvider: 'lm-studio',
        textModel: 'gemma-4-e2b-it-sft-rlvr-medical',
      });
      policyRepository.findForExactTenant.mockResolvedValue(own);
      policyRepository.findSystemDefault.mockResolvedValue(sys);

      const result = await service.getEffectivePolicy();

      expect(result.textProvider).toBe('lm-studio');
      expect(result.textModel).toBe('gemma-4-e2b-it-sft-rlvr-medical');
    });
  });

  // ── LLM-as-judge selection surfaced on the effective policy ──
  describe('getEffectivePolicy — judge selection', () => {
    it('defaults judgeProvider/judgeModel to null when the AiTaskDefault service is not wired', async () => {
      policyRepository.findForExactTenant.mockResolvedValue(null);
      policyRepository.findSystemDefault.mockResolvedValue(null);

      // `service` (4-arg) has no AiTaskDefault service injected.
      const result = await service.getEffectivePolicy();

      expect(result.judgeProvider).toBeNull();
      expect(result.judgeModel).toBeNull();
    });

    it('resolves harness.judge from the SYSTEM AiTaskDefault and maps lm-studio → openai_compat', async () => {
      const svc = makeServiceWithAiTaskDefault();
      policyRepository.findForExactTenant.mockResolvedValue(null);
      policyRepository.findSystemDefault.mockResolvedValue(null);
      aiTaskDefaultService.getEffective.mockResolvedValue({
        taskKey: 'harness.judge',
        modelSlug: 'lms-gemma-4-e4b',
        source: 'system',
        model: { provider: 'lm-studio', sourceUri: 'google/gemma-4-e4b' },
      });

      const result = await svc.getEffectivePolicy('tenant-1');

      expect(aiTaskDefaultService.getEffective).toHaveBeenCalledWith('harness.judge', 'tenant-1');
      expect(result.judgeProvider).toBe('openai_compat');
      expect(result.judgeModel).toBe('google/gemma-4-e4b');
    });

    it('passes a non-lm-studio judge provider through verbatim (e.g. bedrock)', async () => {
      const svc = makeServiceWithAiTaskDefault();
      policyRepository.findForExactTenant.mockResolvedValue(null);
      policyRepository.findSystemDefault.mockResolvedValue(null);
      aiTaskDefaultService.getEffective.mockResolvedValue({
        model: { provider: 'bedrock', sourceUri: 'anthropic.claude-3-5-haiku-20241022-v1:0' },
      });

      const result = await svc.getEffectivePolicy('tenant-1');

      expect(result.judgeProvider).toBe('bedrock');
      expect(result.judgeModel).toBe('anthropic.claude-3-5-haiku-20241022-v1:0');
    });

    it('leaves judge null (fail-safe) when the AiTaskDefault lookup throws', async () => {
      const svc = makeServiceWithAiTaskDefault();
      policyRepository.findForExactTenant.mockResolvedValue(null);
      policyRepository.findSystemDefault.mockResolvedValue(null);
      aiTaskDefaultService.getEffective.mockRejectedValue(new Error('unknown task key'));

      const result = await svc.getEffectivePolicy('tenant-1');

      expect(result.judgeProvider).toBeNull();
      expect(result.judgeModel).toBeNull();
    });
  });

  // ── the fail-closed TEXT selection seam ──
  describe('resolveTextSelection', () => {
    it('returns {provider, model} resolved from the SYSTEM-default cascade', async () => {
      const sys = HarnessPolicyFactory.CreateHarnessPolicy({
        tenantId: SYSTEM_TENANT_ID,
        textProvider: 'lm-studio',
        textModel: 'gemma-4-e2b-it-sft-rlvr-medical',
      });
      policyRepository.findForExactTenant.mockResolvedValue(null);
      policyRepository.findSystemDefault.mockResolvedValue(sys);

      const result = await service.resolveTextSelection();

      expect(result).toEqual({ provider: 'lm-studio', model: 'gemma-4-e2b-it-sft-rlvr-medical' });
    });

    it('resolves a null-TEXT tenant row to the SYSTEM default (field-level fallthrough)', async () => {
      const own = HarnessPolicyFactory.CreateHarnessPolicy({ tenantId: TENANT, textProvider: null, textModel: null });
      const sys = HarnessPolicyFactory.CreateHarnessPolicy({
        tenantId: SYSTEM_TENANT_ID,
        textProvider: 'lm-studio',
        textModel: 'gemma-4-e2b-it-sft-rlvr-medical',
      });
      policyRepository.findForExactTenant.mockResolvedValue(own);
      policyRepository.findSystemDefault.mockResolvedValue(sys);

      const result = await service.resolveTextSelection();

      expect(result).toEqual({ provider: 'lm-studio', model: 'gemma-4-e2b-it-sft-rlvr-medical' });
    });

    it('throws (fail-closed) when the cascade yields no model (no tenant row, no SYSTEM default)', async () => {
      policyRepository.findForExactTenant.mockResolvedValue(null);
      policyRepository.findSystemDefault.mockResolvedValue(null);

      await expect(service.resolveTextSelection()).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws (fail-closed) when the tenant row and the SYSTEM default both leave TEXT null', async () => {
      const own = HarnessPolicyFactory.CreateHarnessPolicy({ tenantId: TENANT, textProvider: null, textModel: null });
      policyRepository.findForExactTenant.mockResolvedValue(own);
      policyRepository.findSystemDefault.mockResolvedValue(null);

      await expect(service.resolveTextSelection()).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // AiTaskDefault-first TEXT routing.
  describe('resolveTextSelection — AiTaskDefault precedence', () => {
    it('consults the text.finalize AiTaskDefault FIRST and returns its {provider, sourceUri}', async () => {
      const svc = makeServiceWithAiTaskDefault();
      aiTaskDefaultService.getEffective.mockResolvedValue({
        taskKey: 'text.finalize',
        modelSlug: 'lms-gemma-4-e2b-it-qat',
        source: 'system',
        model: { provider: 'lm-studio', sourceUri: 'gemma-4-e2b-it-qat' },
      });

      const result = await svc.resolveTextSelection('tenant-1');

      expect(aiTaskDefaultService.getEffective).toHaveBeenCalledWith('text.finalize', 'tenant-1');
      expect(result).toEqual({ provider: 'lm-studio', model: 'gemma-4-e2b-it-qat' });
      // AiTaskDefault won — the legacy policy cascade must not be consulted.
      expect(policyRepository.findForExactTenant).not.toHaveBeenCalled();
    });

    it('maps the live task to the text.live key', async () => {
      const svc = makeServiceWithAiTaskDefault();
      aiTaskDefaultService.getEffective.mockResolvedValue({
        model: { provider: 'lm-studio', sourceUri: 'gemma-4-e2b-it-qat' },
      });

      await svc.resolveTextSelection('tenant-1', 'live');

      expect(aiTaskDefaultService.getEffective).toHaveBeenCalledWith('text.live', 'tenant-1');
    });

    it('falls back to the legacy HarnessPolicy cascade when AiTaskDefault resolves no model', async () => {
      const svc = makeServiceWithAiTaskDefault();
      aiTaskDefaultService.getEffective.mockResolvedValue({ model: null });
      const sys = HarnessPolicyFactory.CreateHarnessPolicy({
        tenantId: SYSTEM_TENANT_ID,
        textProvider: 'lm-studio',
        textModel: 'legacy-model',
      });
      policyRepository.findForExactTenant.mockResolvedValue(null);
      policyRepository.findSystemDefault.mockResolvedValue(sys);

      const result = await svc.resolveTextSelection('tenant-1');

      expect(result).toEqual({ provider: 'lm-studio', model: 'legacy-model' });
    });

    it('falls back to the legacy cascade when the AiTaskDefault lookup throws', async () => {
      const svc = makeServiceWithAiTaskDefault();
      aiTaskDefaultService.getEffective.mockRejectedValue(new Error('unknown task key'));
      const sys = HarnessPolicyFactory.CreateHarnessPolicy({
        tenantId: SYSTEM_TENANT_ID,
        textProvider: 'ollama',
        textModel: 'granite4:latest',
      });
      policyRepository.findForExactTenant.mockResolvedValue(null);
      policyRepository.findSystemDefault.mockResolvedValue(sys);

      const result = await svc.resolveTextSelection('tenant-1');

      expect(result).toEqual({ provider: 'ollama', model: 'granite4:latest' });
    });
  });

  // Tenant-configurable TEXT fallback selection (fail-OPEN).
  describe('resolveTextFallbackSelection', () => {
    it('resolves the text.finalize.fallback key to {provider, sourceUri} when a model is enabled', async () => {
      const svc = makeServiceWithAiTaskDefault();
      aiTaskDefaultService.getEffective.mockResolvedValue({
        taskKey: 'text.finalize.fallback',
        modelSlug: 'lms-gemma-4-e2b-it-qat',
        source: 'tenant',
        model: { provider: 'lm-studio', sourceUri: 'gemma-4-e2b-it-qat' },
      });

      const result = await svc.resolveTextFallbackSelection('tenant-1');

      expect(aiTaskDefaultService.getEffective).toHaveBeenCalledWith('text.finalize.fallback', 'tenant-1');
      expect(result).toEqual({ provider: 'lm-studio', model: 'gemma-4-e2b-it-qat' });
      // Fallback resolution never consults the legacy policy cascade.
      expect(policyRepository.findForExactTenant).not.toHaveBeenCalled();
    });

    it('maps the live task to the text.live.fallback key', async () => {
      const svc = makeServiceWithAiTaskDefault();
      aiTaskDefaultService.getEffective.mockResolvedValue({
        model: { provider: 'lm-studio', sourceUri: 'gemma-4-e2b-it-qat' },
      });

      await svc.resolveTextFallbackSelection('tenant-1', 'live');

      expect(aiTaskDefaultService.getEffective).toHaveBeenCalledWith('text.live.fallback', 'tenant-1');
    });

    it('normalizes an azure provider to azure-openai', async () => {
      const svc = makeServiceWithAiTaskDefault();
      aiTaskDefaultService.getEffective.mockResolvedValue({
        model: { provider: 'azure', sourceUri: 'gpt-4o-mini' },
      });

      const result = await svc.resolveTextFallbackSelection('tenant-1');

      expect(result).toEqual({ provider: 'azure-openai', model: 'gpt-4o-mini' });
    });

    it('returns null (fail-open) when the fallback key resolves to no enabled model', async () => {
      const svc = makeServiceWithAiTaskDefault();
      aiTaskDefaultService.getEffective.mockResolvedValue({ model: null });

      const result = await svc.resolveTextFallbackSelection('tenant-1');

      expect(result).toBeNull();
      // Fail-OPEN: the legacy cascade is NOT a fallback for the fallback key.
      expect(policyRepository.findForExactTenant).not.toHaveBeenCalled();
    });

    it('returns null (fail-open) when the AiTaskDefault lookup throws — never propagates', async () => {
      const svc = makeServiceWithAiTaskDefault();
      aiTaskDefaultService.getEffective.mockRejectedValue(new Error('unknown task key'));

      const result = await svc.resolveTextFallbackSelection('tenant-1');

      expect(result).toBeNull();
    });

    it('returns null when the AiTaskDefault service is not wired (fixtures)', async () => {
      const svc = makeService();

      const result = await svc.resolveTextFallbackSelection('tenant-1');

      expect(result).toBeNull();
    });
  });

  // agentic loop knob cascade (null ⇒ env default).
  describe('agentic loop knobs', () => {
    it('defaults every agentic knob to null on the code-default response', async () => {
      policyRepository.findForExactTenant.mockResolvedValue(null);
      policyRepository.findSystemDefault.mockResolvedValue(null);

      const effective = await service.getEffectivePolicy(TENANT);

      expect(effective.source).toBe('code-default');
      expect(effective.optimisticDeliveryEnabled).toBeNull();
      expect(effective.atomicFactEnabled).toBeNull();
      expect(effective.retrievalEnabled).toBeNull();
      expect(effective.warmStartEnabled).toBeNull();
      expect(effective.nerPriorsEnabled).toBeNull();
      expect(effective.maxEditReruns).toBeNull();
      expect(effective.regenFeedbackEnabled).toBeNull();
    });

    it('overlays SYSTEM agentic knobs over tenant-row values on the effective policy', async () => {
      const own = HarnessPolicyFactory.CreateHarnessPolicy({
        tenantId: TENANT,
        textProvider: 'lm-studio',
        textModel: 'm',
        optimisticDeliveryEnabled: true,
        maxEditReruns: 3,
        retrievalEnabled: false,
      });
      const sys = HarnessPolicyFactory.CreateHarnessPolicy({
        tenantId: SYSTEM_TENANT_ID,
        optimisticDeliveryEnabled: false,
        maxEditReruns: 1,
        retrievalEnabled: true,
        warmStartEnabled: null,
      });
      policyRepository.findForExactTenant.mockResolvedValue(own);
      policyRepository.findSystemDefault.mockResolvedValue(sys);

      const effective = await service.getEffectivePolicy(TENANT);

      expect(effective.source).toBe('tenant');
      expect(effective.optimisticDeliveryEnabled).toBe(false);
      expect(effective.maxEditReruns).toBe(1);
      expect(effective.retrievalEnabled).toBe(true);
      expect(effective.warmStartEnabled).toBeNull();
    });

    it('rejects a tenant updatePolicy that patches agentic/selection knobs (403)', async () => {
      const own = HarnessPolicyFactory.CreateHarnessPolicy({ tenantId: TENANT, textProvider: 'lm-studio', textModel: 'm' });
      policyRepository.findForExactTenant.mockResolvedValue(own);

      await expect(service.updatePolicy({ atomicFactEnabled: true, maxEditReruns: 5, expectedVersion: 1 } as never, 1)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(policyChangeRepository.create).not.toHaveBeenCalled();
    });

    // The guardrail/PHI ON-OFF switches
    // join the super-admin-only list. A tenant admin must not be able to
    // disable the safety gate or the PHI fail-closed posture for their tenant.
    describe.each(['safetyEnabled', 'phiEnabled', 'phiFailClosed'] as const)('E3-L1 lock — %s', (key) => {
      it('rejects a tenant updatePolicy patching it (403 naming the key)', async () => {
        const own = HarnessPolicyFactory.CreateHarnessPolicy({ tenantId: TENANT });
        policyRepository.findForExactTenant.mockResolvedValue(own);

        await expect(service.updatePolicy({ [key]: false } as never, 1)).rejects.toThrow(new RegExp(key));
        await expect(service.updatePolicy({ [key]: false } as never, 1)).rejects.toBeInstanceOf(ForbiddenException);
        expect(policyChangeRepository.create).not.toHaveBeenCalled();
      });

      it('still accepts it on updateGlobalDefault (global editor unaffected)', async () => {
        const sys = systemDefaultEntity();
        policyRepository.findForExactTenant.mockResolvedValue(null);
        policyRepository.findSystemDefault.mockResolvedValue(sys);

        await expect(service.updateGlobalDefault({ [key]: false } as never, sys.version)).resolves.toBeDefined();
      });

      it('overlays the SYSTEM value over a grandfathered tenant-row value', async () => {
        // Pre-existing tenant row set it to false; SYSTEM says true.
        const own = HarnessPolicyFactory.CreateHarnessPolicy({ tenantId: TENANT, [key]: false } as never);
        const sys = HarnessPolicyFactory.CreateHarnessPolicy({ tenantId: SYSTEM_TENANT_ID, [key]: true } as never);
        policyRepository.findForExactTenant.mockResolvedValue(own);
        policyRepository.findSystemDefault.mockResolvedValue(sys);

        const effective = await service.getEffectivePolicy(TENANT);

        expect(effective.source).toBe('tenant');
        expect((effective as unknown as Record<string, unknown>)[key]).toBe(true);
      });
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
        gateSlaSeconds: number;
      };
      expect(created.tenantId).toBe(TENANT);
      expect(created.coverageThreshold).toBe(0.5);
      // Unpatched field inherited from the SYSTEM default (not the code default).
      expect(created.gateSlaSeconds).toBe(12_345);

      const change = policyChangeRepository.create.mock.calls[0][0] as { beforeJson: unknown; afterJson: { coverageThreshold: number } };
      expect(change.beforeJson).toBeNull();
      expect(change.afterJson.coverageThreshold).toBe(0.5);
      expect(result.source).toBe('tenant');
    });

    // ── The FIRST-EDIT create path honors the precondition ──
    // Pre-fix, a stale `If-Match` on a tenant with no policy row silently
    // CREATED the row and returned 200 (observed on the fresh e2e DB); the
    // caller's validator must be compared against the inherited default's
    // version (or 0 when only code defaults exist), per RFC 7232.

    it('a stale expectedVersion on first edit → OptimisticConcurrencyException, NO row created', async () => {
      policyRepository.findForExactTenant.mockResolvedValue(null);
      policyRepository.findSystemDefault.mockResolvedValue(systemDefaultEntity()); // version 1

      await expect(service.updatePolicy({ coverageThreshold: 0.5 }, 999)).rejects.toBeInstanceOf(OptimisticConcurrencyException);
      expect(policyRepository.create).not.toHaveBeenCalled();
      expect(policyChangeRepository.create).not.toHaveBeenCalled();
    });

    it('on first edit with NO system default, only version 0 (or no validator) is accepted', async () => {
      policyRepository.findForExactTenant.mockResolvedValue(null);
      policyRepository.findSystemDefault.mockResolvedValue(null);
      policyRepository.create.mockImplementation(async (entity) => entity);

      await expect(service.updatePolicy({ coverageThreshold: 0.5 }, 7)).rejects.toBeInstanceOf(OptimisticConcurrencyException);
      expect(policyRepository.create).not.toHaveBeenCalled();

      // No validator at all (off-route/service caller) still creates.
      const result = await service.updatePolicy({ coverageThreshold: 0.5 });
      expect(policyRepository.create).toHaveBeenCalledTimes(1);
      expect(result.source).toBe('tenant');
    });

    it('propagates OptimisticConcurrencyException and writes NO change row on version drift', async () => {
      const own = HarnessPolicyFactory.CreateHarnessPolicy({ tenantId: TENANT, coverageThreshold: 0.8 });
      policyRepository.findForExactTenant.mockResolvedValue(own);
      policyRepository.updateWithVersion.mockRejectedValue(
        new OptimisticConcurrencyException('HarnessPolicy', own.id, { expectedVersion: 1, currentVersion: 2 }),
      );

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
  /**
   * TASK-816 Phase 4 — `safetyProvider`/`safetyModel` were dropped from the schema.
   *
   * `KNOB_KEYS` derives from `HARNESS_POLICY_DEFAULTS`, so a stale key there would put a
   * dropped column back into every merge / apply / WORM snapshot the service writes — the
   * shape that would 500 against the migrated table. Nothing read either value (Phase 2,
   * mutation-proven); the guardrail selection lives in the `guardrail.safety` AiTaskDefault,
   * resolved by apps/guardrail tenant-first.
   */
  describe('the retired safety selection knobs', () => {
    it.each(['safetyProvider', 'safetyModel'])('is not a policy knob default: %s', (key) => {
      expect(Object.keys(HARNESS_POLICY_DEFAULTS)).not.toContain(key);
    });

    it('never writes a retired key into the WORM change snapshot', async () => {
      const own = HarnessPolicyFactory.CreateHarnessPolicy({ tenantId: TENANT, coverageThreshold: 0.8 });
      policyRepository.findForExactTenant.mockResolvedValue(own);
      policyRepository.updateWithVersion.mockImplementation(async (_id: string, entity: unknown) => entity);

      await service.updatePolicy({ maxRegen: 3 }, 1);

      const change = policyChangeRepository.create.mock.calls[0][0] as { afterJson: Record<string, unknown>; beforeJson: Record<string, unknown> };
      for (const key of ['safetyProvider', 'safetyModel']) {
        expect(Object.keys(change.afterJson)).not.toContain(key);
        expect(Object.keys(change.beforeJson)).not.toContain(key);
      }
    });
  });
});
