/**
 * TASK-998 OD-4 — the per-provider cloud-ASR capacity cascade.
 *
 * > "platform admin will set minute volume by enabled provider globally OR
 * >  specific by tenant that has Pro plan and above"
 *
 * The four properties these lock down are the ones the owner rules turn on:
 *
 *   1. a tenant allocation WINS over the platform default;
 *   2. absence WIDENS to the platform default — per DIMENSION, not per provider;
 *   3. a sub-Pro tenant falls back to the PLATFORM DEFAULT, never to zero
 *      (`09-infrastructure-devops.md` §"Entitlements bound, they never supply");
 *   4. `0` is a real, enforceable allocation and must not read as "unset".
 */
import { describe, expect, it } from 'vitest';
import { TenantPlan } from '@arcaai/domains';
import { parseProviderQuotaMap, providerQuotaFor, resolveProviderQuotas, validateProviderQuotaMap } from '../provider-quotas';
import { resolveEntitlements } from '../resolve-entitlements';

/** The real allow-list shape, passed in exactly as the service passes it. */
const STT_PROVIDERS = ['azure-speech', 'azure-foundry', 'sarvam', 'openai'] as const;

describe('resolveProviderQuotas — tenant allocation over platform default', () => {
  it('uses the platform default when the tenant has no allocation at all', () => {
    const resolved = resolveProviderQuotas(null, { sarvam: { requestsPerMinute: 100, maxConcurrentStreams: 20 } });

    expect(resolved.sarvam).toEqual({ requestsPerMinute: 100, maxConcurrentStreams: 20 });
  });

  it("the tenant's allocation wins over the platform default", () => {
    const resolved = resolveProviderQuotas(
      { sarvam: { requestsPerMinute: 10, maxConcurrentStreams: 2 } },
      { sarvam: { requestsPerMinute: 100, maxConcurrentStreams: 20 } },
    );

    expect(resolved.sarvam).toEqual({ requestsPerMinute: 10, maxConcurrentStreams: 2 });
  });

  it('widens PER DIMENSION — a tenant that allocates only concurrency keeps the platform rate', () => {
    const resolved = resolveProviderQuotas(
      { sarvam: { maxConcurrentStreams: 5 } },
      { sarvam: { requestsPerMinute: 100, maxConcurrentStreams: 20 } },
    );

    expect(resolved.sarvam).toEqual({ requestsPerMinute: 100, maxConcurrentStreams: 5 });
  });

  it('a provider the tenant never mentions still resolves the platform default', () => {
    const resolved = resolveProviderQuotas({ sarvam: { maxConcurrentStreams: 5 } }, { 'azure-speech': { requestsPerMinute: 400 } });

    expect(resolved['azure-speech']).toEqual({ requestsPerMinute: 400, maxConcurrentStreams: null });
  });

  it('treats 0 as a real allocation, not as "unset"', () => {
    const resolved = resolveProviderQuotas({ sarvam: { maxConcurrentStreams: 0 } }, { sarvam: { maxConcurrentStreams: 20 } });

    // `||` instead of `??` in the merge would silently widen this back to 20 —
    // i.e. hand capacity to a tenant the platform admin deliberately zeroed.
    expect(resolved.sarvam.maxConcurrentStreams).toBe(0);
  });

  it('resolves to unlimited when neither tier bounds the provider', () => {
    expect(providerQuotaFor(resolveProviderQuotas(null, null), 'sarvam')).toEqual({ requestsPerMinute: null, maxConcurrentStreams: null });
  });

  it('a self-hosted engine (no provider) is never bounded', () => {
    const quotas = resolveProviderQuotas(null, { sarvam: { requestsPerMinute: 1 } });

    expect(providerQuotaFor(quotas, null)).toEqual({ requestsPerMinute: null, maxConcurrentStreams: null });
  });
});

describe('parseProviderQuotaMap — a malformed stored value fails OPEN', () => {
  it('reads a junk dimension as "no opinion" rather than as a cap of 0', () => {
    // A hand-edited or partially-migrated row must not become an accidental
    // zero on the path that starts a consultation recording.
    const parsed = parseProviderQuotaMap({ sarvam: { requestsPerMinute: 'lots', maxConcurrentStreams: -3 } });

    expect(parsed.sarvam).toEqual({ requestsPerMinute: null, maxConcurrentStreams: null });
  });

  it('ignores a non-object column value entirely', () => {
    expect(parseProviderQuotaMap('nonsense')).toEqual({});
    expect(parseProviderQuotaMap([1, 2, 3])).toEqual({});
    expect(parseProviderQuotaMap(null)).toEqual({});
  });
});

describe('validateProviderQuotaMap — the WRITE path rejects loudly', () => {
  it('accepts a well-formed map and a null (clear)', () => {
    expect(validateProviderQuotaMap({ sarvam: { requestsPerMinute: 100 } }, STT_PROVIDERS)).toEqual([]);
    expect(validateProviderQuotaMap(null, STT_PROVIDERS)).toEqual([]);
  });

  it('rejects a provider that is not tenant-BYO-eligible for STT', () => {
    const problems = validateProviderQuotaMap({ bedrock: { requestsPerMinute: 10 } }, STT_PROVIDERS);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("Unknown STT provider 'bedrock'");
  });

  it('rejects a dimension that is not one of the two', () => {
    const problems = validateProviderQuotaMap({ sarvam: { requestsPerHour: 10 } }, STT_PROVIDERS);

    expect(problems[0]).toContain('is not a capacity dimension');
  });

  it('rejects a non-integer or negative limit', () => {
    expect(validateProviderQuotaMap({ sarvam: { requestsPerMinute: 1.5 } }, STT_PROVIDERS)).toHaveLength(1);
    expect(validateProviderQuotaMap({ sarvam: { maxConcurrentStreams: -1 } }, STT_PROVIDERS)).toHaveLength(1);
  });

  it('accepts an explicit null dimension (inherit this one, set the other)', () => {
    expect(validateProviderQuotaMap({ sarvam: { requestsPerMinute: null, maxConcurrentStreams: 20 } }, STT_PROVIDERS)).toEqual([]);
  });
});

describe('resolveEntitlements — the "Pro and above" bound BOUNDS, it does not SUPPLY', () => {
  const platformDefault = { sarvam: { requestsPerMinute: 100, maxConcurrentStreams: 20 } };

  it('a sub-Pro tenant resolves the PLATFORM DEFAULT, not zero', () => {
    const resolved = resolveEntitlements(
      TenantPlan.STARTER,
      { featureProviderQuotaAllocation: false, sttProviderQuotas: platformDefault },
      null,
    );

    // The bound says it may not HOLD its own number. It says nothing about what
    // it resolves — which is the platform's, in full.
    expect(resolved.features.providerQuotaAllocation).toBe(false);
    expect(resolved.providerQuotas.sarvam).toEqual({ requestsPerMinute: 100, maxConcurrentStreams: 20 });
  });

  it('never consults the bound when resolving, so a downgrade does not strand an existing allocation at zero', () => {
    // A tenant that WAS on PRO, holds an allocation, and has since been moved to
    // STARTER. Resolution must still be a number, not a refusal.
    const resolved = resolveEntitlements(
      TenantPlan.STARTER,
      { featureProviderQuotaAllocation: false, sttProviderQuotas: platformDefault },
      { sttProviderQuotas: { sarvam: { maxConcurrentStreams: 4 } } },
    );

    expect(resolved.features.providerQuotaAllocation).toBe(false);
    expect(resolved.providerQuotas.sarvam).toEqual({ requestsPerMinute: 100, maxConcurrentStreams: 4 });
  });

  it('a Pro tenant carries the bound', () => {
    const resolved = resolveEntitlements(TenantPlan.PRO, { featureProviderQuotaAllocation: true }, null);

    expect(resolved.features.providerQuotaAllocation).toBe(true);
  });

  it('an ungated (null-plan) tenant is bounded by nothing', () => {
    const resolved = resolveEntitlements(null, { sttProviderQuotas: platformDefault }, null);

    expect(resolved.gated).toBe(false);
    expect(resolved.providerQuotas).toEqual({});
  });
});
