/**
 * TASK-969 WS-1 — the twin-key pair: a write that succeeds and is never read.
 *
 * `requireMedical` and `includeReasoning` each exist as TWO keys, split by
 * DELIVERY CHANNEL rather than by audience:
 *
 *   text.externalGuardrail.<f>   maxScope 'system', consumedBy ['text']  (PULL)
 *   text.guardrailPolicy.<f>     maxScope 'tenant', no consumedBy        (PUSH)
 *
 * The split is correct. What was not is that a SYSTEM-scope write to the SECOND
 * key was ACCEPTED and read back faithfully while NOTHING read it: its only
 * consumer, `TextRequestEnrichmentService.applyTenantGuardrailPolicy`, skips
 * unless the cascade reports `sourceScope === 'tenant'`. Measured 2026-09-13: a
 * platform admin set it `false`, read back `false`, and the runtime kept
 * enforcing `true`.
 *
 * Two things close it, and both are DECLARED rather than branched on:
 *
 *  1. `platformTierKey` on the tenant half names its platform twin, so the
 *     console can render ONE row and the write lane can refuse the dead scope.
 *  2. an ASSEMBLY-time assertion, so a mispaired declaration is impossible to
 *     construct — not merely detectable by whoever runs the right request.
 */
import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { SettingsRegistry } from '../settings-registry';
import type { SettingDescriptor } from '../registry.types';

function desc(over: Partial<SettingDescriptor> = {}): SettingDescriptor {
  return {
    key: 'test.flag',
    tier: 'global-kv',
    dataType: 'boolean',
    sensitivity: 'internal',
    maxScope: 'tenant',
    editableBy: 'GlobalSetting',
    failMode: 'open-to-default',
    category: 'Test',
    ...over,
  };
}

/** A well-formed pair: tenant half + its platform twin. */
function pair(over: { tenant?: Partial<SettingDescriptor>; platform?: Partial<SettingDescriptor> } = {}): SettingDescriptor[] {
  return [
    desc({ key: 'test.platform.flag', maxScope: 'system', globalOnly: true, ...over.platform }),
    desc({ key: 'test.tenant.flag', maxScope: 'tenant', globalOnly: true, platformTierKey: 'test.platform.flag', ...over.tenant }),
  ];
}

describe('assembly-time pairing assertion', () => {
  it('accepts a well-formed pair', () => {
    expect(() => new SettingsRegistry().registerAll(pair()).assertPlatformTierPairs()).not.toThrow();
  });

  it('refuses a platformTierKey that names no registered key', () => {
    expect(() =>
      new SettingsRegistry().registerAll([desc({ key: 'test.tenant.flag', platformTierKey: 'test.nope' })]).assertPlatformTierPairs(),
    ).toThrow(/test\.nope/);
  });

  it('refuses a twin that is not maxScope system — a PUSH key cannot be a platform tier', () => {
    expect(() => new SettingsRegistry().registerAll(pair({ platform: { maxScope: 'tenant' } })).assertPlatformTierPairs()).toThrow(/maxScope/i);
  });

  it('refuses a twin whose dataType differs — the console renders ONE control for both', () => {
    expect(() => new SettingsRegistry().registerAll(pair({ platform: { dataType: 'number' } })).assertPlatformTierPairs()).toThrow(/dataType/i);
  });

  it('refuses a twin whose globalOnly differs — one row cannot have two audiences', () => {
    expect(() => new SettingsRegistry().registerAll(pair({ platform: { globalOnly: false } })).assertPlatformTierPairs()).toThrow(/globalOnly/i);
  });

  it('refuses a CHAIN: a platform tier that itself declares one', () => {
    // A -> B -> C, every hop otherwise well formed. The read lane follows
    // exactly ONE hop, so a chain would silently report the wrong half.
    const chain = [
      desc({ key: 'test.c.flag', maxScope: 'system', globalOnly: true }),
      desc({ key: 'test.b.flag', maxScope: 'system', globalOnly: true, platformTierKey: 'test.c.flag' }),
      desc({ key: 'test.a.flag', maxScope: 'tenant', globalOnly: true, platformTierKey: 'test.b.flag' }),
    ];
    expect(() => new SettingsRegistry().registerAll(chain).assertPlatformTierPairs()).toThrow(/itself/i);
  });
});

describe('the real registry declares both guardrail pairs', () => {
  it.each([
    ['text.guardrailPolicy.requireMedical', 'text.externalGuardrail.requireMedical'],
    ['text.guardrailPolicy.includeReasoning', 'text.externalGuardrail.includeReasoning'],
  ])('%s names %s as its platform tier', (tenantKey, platformKey) => {
    expect(HOPE_SETTINGS_REGISTRY.getOrThrow(tenantKey).platformTierKey).toBe(platformKey);
  });

  it('and the assembled registry satisfies the assertion (it ran at module load)', () => {
    expect(() => HOPE_SETTINGS_REGISTRY.assertPlatformTierPairs()).not.toThrow();
  });

  it('the TENANT half is titled after the CONCEPT, not after its scope', () => {
    // The pair renders as ONE row whose title is the tenant half's label, and
    // that row sets BOTH halves — so a "(this tenant)" suffix would be wrong on
    // the very control that also writes the platform default. The scope is what
    // the row's own picker says; the label names the concept.
    expect(HOPE_SETTINGS_REGISTRY.getOrThrow('text.guardrailPolicy.requireMedical').label).toBe('Require medical content');
    expect(HOPE_SETTINGS_REGISTRY.getOrThrow('text.guardrailPolicy.includeReasoning').label).toBe('Include guardrail reasoning');
  });

  it('the PLATFORM half keeps its label VERBATIM — the seed copies it into GlobalSetting.name', () => {
    // Not cosmetic and not ours to tidy: the seeded SYSTEM rows carry these
    // strings in their `name` column, so editing a label here silently desyncs
    // the seed from the descriptor it was transcribed from.
    expect(HOPE_SETTINGS_REGISTRY.getOrThrow('text.externalGuardrail.requireMedical').label).toBe('Require medical content (platform default)');
    expect(HOPE_SETTINGS_REGISTRY.getOrThrow('text.externalGuardrail.includeReasoning').label).toBe('Include guardrail reasoning (platform default)');
  });

  it('no OTHER key declares a platform tier — the pair is an exception, not a pattern', () => {
    const declaring = HOPE_SETTINGS_REGISTRY.list()
      .filter((d) => d.platformTierKey !== undefined)
      .map((d) => d.key)
      .sort();
    expect(declaring).toEqual(['text.guardrailPolicy.includeReasoning', 'text.guardrailPolicy.requireMedical']);
  });
});
