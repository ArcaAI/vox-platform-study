/**
 * Plan → rate-limit composition.
 */
import { describe, it, expect } from 'vitest';
import { resolvePlanRateLimit } from '../rate-limit-plan';

describe('resolvePlanRateLimit (Q7)', () => {
  const baseline = { limit: 100, ttl: 60000 };

  it('uses the plan-tier baseline when there is no per-tenant override', () => {
    expect(resolvePlanRateLimit('default', null, baseline)).toEqual({ tier: 'default', limit: 100, ttl: 60000, source: 'plan-tier' });
    expect(resolvePlanRateLimit('strict', undefined, { limit: 10, ttl: 60000 })).toMatchObject({ limit: 10, source: 'plan-tier' });
  });

  it('lets a per-tenant override raise the limit (Q7 "increase on demand"), keeping the tier window', () => {
    const result = resolvePlanRateLimit('default', 500, baseline);
    expect(result).toEqual({ tier: 'default', limit: 500, ttl: 60000, source: 'per-tenant-override' });
  });

  it('treats a zero override as an explicit value (not "unset")', () => {
    expect(resolvePlanRateLimit('strict', 0, { limit: 10, ttl: 60000 })).toMatchObject({ limit: 0, source: 'per-tenant-override' });
  });
});
