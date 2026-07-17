import { ArgumentInvalidException } from '@arcaai/exceptions';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigResolver, ResolvedPipelineToggles } from '../../config-resolver/config-resolver.service';
import { EffectiveSettingsService } from '../effective-settings.service';

// TASK-504 — the facade delegates pipeline keys to ConfigResolver, threads the
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
): EffectiveSettingsService {
  const configResolver = { resolvePipelineToggles: vi.fn(async () => toggles) } as unknown as ConfigResolver;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new EffectiveSettingsService(configResolver, aiTaskDefaults as any);
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

  it('throws for a non-secret key with no registered resolver', async () => {
    const svc = serviceWith(resolved());
    await expect(svc.resolveEffective('entitlements.enabled', CTX)).rejects.toThrow(/no effective resolver/i);
  });

  // TASK-506 — models.* keys delegate to AiTaskDefaultService.getEffective
  // (never re-implementing data access).
  describe('models.* branch (TASK-506)', () => {
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

    it('maps an unconfigured default (source null) to sourceScope none with a null value', async () => {
      const getEffective = vi.fn(async () => ({
        tenantId: 'tnt-1',
        taskKey: 'guardrail.validate',
        modelSlug: null,
        source: null,
        configJson: null,
        model: null,
      }));
      const svc = serviceWith(resolved(), { getEffective });

      await expect(svc.resolveEffective('models.guardrail.validate', CTX)).resolves.toMatchObject({
        value: null,
        sourceScope: 'none',
      });
    });

    it('throws when no AiTaskDefaultService is wired', async () => {
      const svc = serviceWith(resolved());
      await expect(svc.resolveEffective('models.nlp.ner', CTX)).rejects.toThrow(/no effective resolver/i);
    });
  });
});
