/**
 * Plan → model clone-subset predicate.
 */
import { describe, it, expect } from 'vitest';
import { TenantPlan } from '@arcaai/domains';
import { modelAllowedForTier, modelTierForPlan } from '../model-access';

describe('modelTierForPlan (Q8)', () => {
  it('maps each plan to its seeded model tier', () => {
    expect(modelTierForPlan(TenantPlan.STARTER)).toBe('base');
    expect(modelTierForPlan(TenantPlan.PRO)).toBe('full');
    expect(modelTierForPlan(TenantPlan.TRIAL)).toBe('full'); // TRIAL = PRO
    expect(modelTierForPlan(TenantPlan.ENTERPRISE)).toBe('full_custom');
  });

  it('treats a null/ungated plan as the full catalog (Q3)', () => {
    expect(modelTierForPlan(null)).toBe('full_custom');
    expect(modelTierForPlan(undefined)).toBe('full_custom');
  });
});

describe('modelAllowedForTier (Q8)', () => {
  it('clones untagged models into EVERY tier (non-breaking for the current seed)', () => {
    expect(modelAllowedForTier([], 'base')).toBe(true);
    expect(modelAllowedForTier(['audio', 'whisper'], 'base')).toBe(true);
    expect(modelAllowedForTier(undefined, 'base')).toBe(true);
  });

  it('excludes a tier:full model from a base tenant, includes it for full/full_custom', () => {
    expect(modelAllowedForTier(['tier:full'], 'base')).toBe(false);
    expect(modelAllowedForTier(['tier:full'], 'full')).toBe(true);
    expect(modelAllowedForTier(['tier:full'], 'full_custom')).toBe(true);
  });

  it('excludes a tier:full_custom model from base + full, includes only full_custom', () => {
    expect(modelAllowedForTier(['tier:full_custom'], 'base')).toBe(false);
    expect(modelAllowedForTier(['tier:full_custom'], 'full')).toBe(false);
    expect(modelAllowedForTier(['tier:full_custom'], 'full_custom')).toBe(true);
  });

  it('uses the HIGHEST tier tag when several are present', () => {
    expect(modelAllowedForTier(['tier:base', 'tier:full_custom'], 'full')).toBe(false);
    expect(modelAllowedForTier(['tier:base', 'tier:full'], 'full')).toBe(true);
  });

  it('is case-insensitive on the tag', () => {
    expect(modelAllowedForTier(['TIER:FULL'], 'base')).toBe(false);
    expect(modelAllowedForTier(['Tier:Full'], 'full')).toBe(true);
  });
});
