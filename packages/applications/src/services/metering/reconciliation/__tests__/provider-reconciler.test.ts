import { describe, expect, it } from 'vitest';
import {
  buildStubProviderReconcilerRegistry,
  summarizeProviderReconcilerAvailability,
} from '../provider-reconciler';

describe('buildStubProviderReconcilerRegistry', () => {
  it('registers openai, anthropic, and azure', () => {
    const registry = buildStubProviderReconcilerRegistry();
    expect(Array.from(registry.keys()).sort()).toEqual(['anthropic', 'azure', 'openai']);
  });

  it('every stub reports itself unavailable with a credential hint, never throws on checkAvailability', () => {
    const registry = buildStubProviderReconcilerRegistry();
    for (const reconciler of registry.values()) {
      const availability = reconciler.checkAvailability();
      expect(availability.available).toBe(false);
      if (!availability.available) {
        expect(availability.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it('fetchControlTotal on a stub throws rather than silently returning a fake total', async () => {
    const registry = buildStubProviderReconcilerRegistry();
    const openai = registry.get('openai')!;
    await expect(openai.fetchControlTotal(new Date(), new Date())).rejects.toThrow(/stub/i);
  });
});

describe('summarizeProviderReconcilerAvailability', () => {
  it('produces one row per registered provider, all unavailable for the stub registry', () => {
    const registry = buildStubProviderReconcilerRegistry();
    const summary = summarizeProviderReconcilerAvailability(registry);

    expect(summary).toHaveLength(3);
    expect(summary.every((row) => row.available === false)).toBe(true);
    expect(summary.map((row) => row.provider).sort()).toEqual(['anthropic', 'azure', 'openai']);
  });
});
