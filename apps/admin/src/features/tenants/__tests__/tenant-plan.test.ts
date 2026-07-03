import { describe, expect, it } from 'vitest';
import { planBadgeRole, planLabel, TENANT_PLAN_VALUES } from '../tenant-plan';

describe('tenant-plan helpers', () => {
  it('exposes the four commercial tiers in review order', () => {
    expect(TENANT_PLAN_VALUES).toEqual(['ENTERPRISE', 'PRO', 'TRIAL', 'STARTER']);
  });

  describe('planLabel', () => {
    it('title-cases each tier and renders an em-dash for an unset plan', () => {
      expect(planLabel('ENTERPRISE')).toBe('Enterprise');
      expect(planLabel('PRO')).toBe('Pro');
      expect(planLabel('TRIAL')).toBe('Trial');
      expect(planLabel('STARTER')).toBe('Starter');
      expect(planLabel(null)).toBe('—');
      expect(planLabel(undefined)).toBe('—');
    });
  });

  describe('planBadgeRole', () => {
    it('maps each tier to a distinct semantic color role', () => {
      expect(planBadgeRole('ENTERPRISE')).toBe('hope');
      expect(planBadgeRole('PRO')).toBe('info');
      expect(planBadgeRole('TRIAL')).toBe('warning');
      expect(planBadgeRole('STARTER')).toBe('neutral');
      expect(planBadgeRole(null)).toBe('neutral');
    });
  });
});
