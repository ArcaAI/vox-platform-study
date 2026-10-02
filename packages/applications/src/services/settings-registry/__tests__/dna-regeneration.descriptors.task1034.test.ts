import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';

// TASK-1034 §4b — every `dna-regen.*` key is a governed, tenant-overridable descriptor.
describe('dna-regen.* descriptors (TASK-1034)', () => {
  const expected: Record<string, unknown> = {
    'dna-regen.enabled': true,
    'dna-regen.cron': '0 2 * * 1',
    'dna-regen.min-new-samples': 3,
    'dna-regen.max-samples': 50,
    'dna-regen.max-context-chars': 100_000,
    'dna-regen.job-delay-ms': 5000,
  };

  it.each(Object.entries(expected))('%s is registered, tenant-overridable, with its default', (key, def) => {
    const d = HOPE_SETTINGS_REGISTRY.get(key);
    expect(d).toBeDefined();
    expect(d!.maxScope).toBe('tenant');
    expect(d!.tier).toBe('global-kv');
    expect(d!.globalOnly).toBeFalsy();
    expect(d!.default).toEqual(def);
  });

  it('rejects an invalid cron and a floor below 1', () => {
    expect(HOPE_SETTINGS_REGISTRY.get('dna-regen.cron')!.validate?.('not a cron')).toBeTruthy();
    expect(HOPE_SETTINGS_REGISTRY.get('dna-regen.cron')!.validate?.('0 2 * * 1')).toBeFalsy();
    expect(HOPE_SETTINGS_REGISTRY.get('dna-regen.min-new-samples')!.validate?.(0)).toBeTruthy();
  });
});
