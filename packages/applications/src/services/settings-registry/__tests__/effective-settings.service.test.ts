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

function serviceWith(toggles: ResolvedPipelineToggles): EffectiveSettingsService {
  const configResolver = { resolvePipelineToggles: vi.fn(async () => toggles) } as unknown as ConfigResolver;
  return new EffectiveSettingsService(configResolver);
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
});
