/**
 * TASK-1050 follow-up E — the block-floor rule over a notice that lists several checks (one notice per
 * direction, type and target). `acknowledged` is refused when ANY listed check is catalogue-locked at
 * block; the one-action approve path uses this same rule, so it is covered here.
 */
import { describe, expect, it } from 'vitest';
import { assertResolutionAllowed, hasBlockFloor } from '../guardrail-hold.rules';

const tenantSet = (checkId: string) => ({ checkId, category: 'x', severity: 'high' });

describe('hasBlockFloor over multi-check notices', () => {
  it('is false when every listed check is tenant-configurable', () => {
    expect(hasBlockFloor({ messageKey: 'guardrail.blocked.inbound', checks: [tenantSet('injection_judge'), tenantSet('unsafe_content_judge'), tenantSet('leakage_judge')] })).toBe(false);
  });

  it('is true when the locked check is anywhere in the list — first, middle or last', () => {
    const locked = tenantSet('medical_validation');
    for (const checks of [[locked, tenantSet('injection_judge')], [tenantSet('injection_judge'), locked, tenantSet('leakage_judge')], [tenantSet('injection_judge'), tenantSet('leakage_judge'), locked]]) {
      expect(hasBlockFloor({ messageKey: 'guardrail.blocked.inbound', checks })).toBe(true);
    }
  });
});

describe('assertResolutionAllowed over multi-check notices', () => {
  const notice = (checks: unknown[]) => ({ id: 'n-1', messageKey: 'guardrail.blocked.inbound', checks });

  it('allows acknowledged for three tenant-set checks, and refuses it with a locked one among them', () => {
    expect(() => assertResolutionAllowed(notice([tenantSet('injection_judge'), tenantSet('unsafe_content_judge'), tenantSet('leakage_judge')]), 'acknowledged')).not.toThrow();
    expect(() => assertResolutionAllowed(notice([tenantSet('injection_judge'), tenantSet('medical_validation'), tenantSet('leakage_judge')]), 'acknowledged')).toThrow();
  });

  it('always allows the item resolutions', () => {
    const locked = notice([tenantSet('injection_judge'), tenantSet('medical_validation')]);
    expect(() => assertResolutionAllowed(locked, 'item_excluded')).not.toThrow();
    expect(() => assertResolutionAllowed(locked, 'item_edited')).not.toThrow();
  });
});
