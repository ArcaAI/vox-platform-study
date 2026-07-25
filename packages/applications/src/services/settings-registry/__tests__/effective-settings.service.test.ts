import { ArgumentInvalidException } from '@arcaai/exceptions';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigResolver, ResolvedPipelineToggles } from '../../config-resolver/config-resolver.service';
import { EffectiveSettingsService } from '../effective-settings.service';

// The facade delegates pipeline keys to ConfigResolver, threads the
// cascade trace through, and refuses secret keys.

function resolved(over: Partial<ResolvedPipelineToggles> = {}): ResolvedPipelineToggles {
  return {
    autoSummaryEnabled: true,
    autoNerEnabled: true,
    harnessEnabled: true,
    dnaStyleEnabled: false,
    trace: {
      autoSummaryEnabled: 'code-default',
      autoNerEnabled: 'code-default',
      harnessEnabled: 'department',
      dnaStyleEnabled: 'code-default',
    },
    ...over,
  };
}

function serviceWith(
  toggles: ResolvedPipelineToggles,
  aiTaskDefaults?: { getEffective: ReturnType<typeof vi.fn> },
  // Backs the global-kv override lane. Omitted ⇒ no DB override, so
  // global-kv keys resolve to their descriptor default.
  appSettings?: { getValueWithDefault: ReturnType<typeof vi.fn> },
): EffectiveSettingsService {
  const configResolver = { resolvePipelineToggles: vi.fn(async () => toggles) } as unknown as ConfigResolver;
  return new EffectiveSettingsService(configResolver, aiTaskDefaults as any, appSettings as any);
}

const CTX = { tenantId: 'tnt-1', departmentId: 'dep-1', doctorId: null };

describe('EffectiveSettingsService', () => {
  it('resolves a pipeline key with its value and the winning cascade tier', async () => {
    const svc = serviceWith(resolved());
    await expect(svc.resolveEffective('pipeline.harnessEnabled', CTX)).resolves.toEqual({
      key: 'pipeline.harnessEnabled',
      tier: 'db-config',
      value: true,
      sourceScope: 'department',
    });
  });

  it('refuses a secret key (never surfaces a secret value)', async () => {
    const svc = serviceWith(resolved());
    await expect(svc.resolveEffective('tts.credential.azure', CTX)).rejects.toBeInstanceOf(ArgumentInvalidException);
  });

  it('throws for an unknown registry key', async () => {
    const svc = serviceWith(resolved());
    await expect(svc.resolveEffective('nope.key', CTX)).rejects.toThrow(/unknown setting/i);
  });

  // The tier that genuinely has no resolver is `entitlement` (the
  // plan feature-flag matrix). `entitlements.enabled` USED to land here too,
  // because no global-kv lane existed; it now resolves (see the global-kv
  // describe block below).
  it('throws for a non-secret key whose tier has no registered resolver', async () => {
    const svc = serviceWith(resolved());
    await expect(svc.resolveEffective('entitlements.featureDnaReports', CTX)).rejects.toThrow(/no effective resolver/i);
  });

  // The global-kv override lane. Before this,
  // `agentic.context.*` short-circuited to the descriptor default and a value
  // written to the KV store was invisible here, so the read surface lied.
  describe('global-kv override lane', () => {
    it('reports a DB override with sourceScope global-kv', async () => {
      const appSettings = { getValueWithDefault: vi.fn(() => 9000) };
      const svc = serviceWith(resolved(), undefined, appSettings);

      await expect(svc.resolveEffective('agentic.context.liveDelta.maxChars', CTX)).resolves.toEqual({
        key: 'agentic.context.liveDelta.maxChars',
        tier: 'global-kv',
        value: 9000,
        sourceScope: 'global-kv',
      });
    });

    it('falls back to the descriptor default with sourceScope code-default', async () => {
      const appSettings = { getValueWithDefault: vi.fn(() => null) };
      const svc = serviceWith(resolved(), undefined, appSettings);

      await expect(svc.resolveEffective('agentic.context.liveDelta.maxChars', CTX)).resolves.toEqual({
        key: 'agentic.context.liveDelta.maxChars',
        tier: 'global-kv',
        value: 12000,
        sourceScope: 'code-default',
      });
    });

    it('falls back to the descriptor default when no AppSettings resolver is wired', async () => {
      const svc = serviceWith(resolved());
      const res = await svc.resolveEffective('agentic.context.liveDelta.maxChars', CTX);
      expect(res.sourceScope).toBe('code-default');
      expect(res.value).toBe(12000);
    });

    it('now resolves entitlements.enabled (a global-kv key) instead of throwing', async () => {
      const svc = serviceWith(resolved());
      const res = await svc.resolveEffective('entitlements.enabled', CTX);
      expect(res.tier).toBe('global-kv');
      expect(res.value).toBe(false);
    });

    it('resolves the newly registered platform-ops keys', async () => {
      const svc = serviceWith(resolved());
      await expect(svc.resolveEffective('rate-limit.enabled', CTX)).resolves.toMatchObject({
        value: true,
        sourceScope: 'code-default',
      });
      await expect(svc.resolveEffective('agentic.trajectory.retentionDays', CTX)).resolves.toMatchObject({
        value: 30,
      });
    });
  });

  // Models.* keys delegate to AiTaskDefaultService.getEffective
  // (never re-implementing data access).
  describe('models.* branch', () => {
    it('delegates models.<taskKey> to AiTaskDefaultService and threads the winning tier through', async () => {
      const getEffective = vi.fn(async () => ({
        tenantId: 'tnt-1',
        taskKey: 'nlp.ner',
        modelSlug: 'medical-ner',
        source: 'system' as const,
        configJson: null,
        model: null,
      }));
      const svc = serviceWith(resolved(), { getEffective });

      await expect(svc.resolveEffective('models.nlp.ner', CTX)).resolves.toEqual({
        key: 'models.nlp.ner',
        tier: 'db-config',
        value: 'medical-ner',
        sourceScope: 'system',
      });
      expect(getEffective).toHaveBeenCalledWith('nlp.ner', 'tnt-1');
    });

    // TASK-558 lane F (plan §9.3 M5): an UNRESOLVED model selection now FAILS
    // CLOSED. This test previously asserted `{ value: null, sourceScope: 'none' }`
    // — i.e. it locked in exactly the silent fail-open M5 forbids: a caller
    // reading "the effective model" got a null that is indistinguishable from a
    // deliberately-null value. `models.*` descriptors declare `failMode: 'closed'`,
    // so the facade raises instead of inventing an answer.
    it('FAILS CLOSED when the selection is unconfigured (source null)', async () => {
      const getEffective = vi.fn(async () => ({
        tenantId: 'tnt-1',
        taskKey: 'guardrail.validate',
        modelSlug: null,
        source: null,
        configJson: null,
        model: null,
      }));
      const svc = serviceWith(resolved(), { getEffective });

      await expect(svc.resolveEffective('models.guardrail.validate', CTX)).rejects.toBeInstanceOf(ArgumentInvalidException);
      await expect(svc.resolveEffective('models.guardrail.validate', CTX)).rejects.toThrow(/fail(s|ing)? closed|could not be resolved/i);
    });

    it('throws when no AiTaskDefaultService is wired', async () => {
      const svc = serviceWith(resolved());
      await expect(svc.resolveEffective('models.nlp.ner', CTX)).rejects.toThrow(/no effective resolver/i);
    });
  });

  // TASK-558 lane F — the declared failure mode, honoured by the read facade.
  describe('failMode', () => {
    it('open-to-default: an unset global-kv tuning knob resolves to the descriptor default', async () => {
      const appSettings = { getValueWithDefault: vi.fn(() => null) };
      const svc = serviceWith(resolved(), undefined, appSettings);

      // `rate-limit.enabled` is a tuning/protection flag → open-to-default.
      await expect(svc.resolveEffective('rate-limit.enabled', CTX)).resolves.toMatchObject({
        value: true,
        sourceScope: 'code-default',
      });
    });

    it('closed: an unresolved value raises instead of substituting a default', async () => {
      const getEffective = vi.fn(async () => ({
        tenantId: 'tnt-1',
        taskKey: 'smr.live',
        modelSlug: null,
        source: null,
        configJson: null,
        model: null,
      }));
      const svc = serviceWith(resolved(), { getEffective });
      await expect(svc.resolveEffective('models.smr.live', CTX)).rejects.toBeInstanceOf(ArgumentInvalidException);
    });

    it('closed does NOT swallow a backend error — transport failures still propagate', async () => {
      const getEffective = vi.fn(async () => {
        throw new Error('db unreachable');
      });
      const svc = serviceWith(resolved(), { getEffective });
      await expect(svc.resolveEffective('models.smr.live', CTX)).rejects.toThrow(/db unreachable/);
    });
  });
});
