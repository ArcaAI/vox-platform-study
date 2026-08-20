import { describe, expect, it } from 'vitest';

import { docsAccessFromRules, isSpecPlane, NO_DOCS_ACCESS, specForPlane } from '../api-docs';

/**
 * TASK-783 — the documentation access gate.
 *
 * The business projection is served to tenant developers and the admin
 * projection describes every `/api/v1/admin/**` route, so "which document does
 * this caller get" is an authorization decision, not a UI preference. These
 * tests pin the two properties that matter: `manage:all` opens both, and
 * anything short of the required ability opens neither.
 */
describe('docsAccessFromRules', () => {
  it('denies everything when the rules could not be fetched', () => {
    // `fetchPermissionRules` returns null when the gateway is unreachable or
    // refuses. An unavailable authority must never read as an unrestricted one.
    expect(docsAccessFromRules(null)).toEqual(NO_DOCS_ACCESS);
  });

  it('denies everything for a caller with no relevant rule', () => {
    expect(docsAccessFromRules([{ action: 'manage', subject: 'Consultation' }])).toEqual(NO_DOCS_ACCESS);
  });

  it('grants the business projection on read:ApiDocumentation, but not the admin one', () => {
    const access = docsAccessFromRules([{ action: 'read', subject: 'ApiDocumentation' }]);

    expect(access.canRead).toBe(true);
    expect(access.canReadAdminPlane).toBe(false);
  });

  it('grants both to a super admin via manage:all', () => {
    // CASL: `manage` covers every action and `all` covers every subject.
    const access = docsAccessFromRules([{ action: 'manage', subject: 'all' }]);

    expect(access.canRead).toBe(true);
    expect(access.canReadAdminPlane).toBe(true);
  });

  it('grants both on an explicit manage:ApiDocumentation', () => {
    const access = docsAccessFromRules([{ action: 'manage', subject: 'ApiDocumentation' }]);

    expect(access.canRead).toBe(true);
    expect(access.canReadAdminPlane).toBe(true);
  });

  it('is not fooled by read on a different subject', () => {
    expect(docsAccessFromRules([{ action: 'read', subject: 'ApiKey' }])).toEqual(NO_DOCS_ACCESS);
  });
});

describe('specForPlane', () => {
  const businessOnly = { canRead: true, canReadAdminPlane: false };
  const full = { canRead: true, canReadAdminPlane: true };

  it('serves nothing at all without the read ability', () => {
    expect(specForPlane('business', NO_DOCS_ACCESS)).toBeNull();
    expect(specForPlane('admin', NO_DOCS_ACCESS)).toBeNull();
  });

  it('refuses the admin projection to a business-only caller', () => {
    expect(specForPlane('admin', businessOnly)).toBeNull();
  });

  it('serves the business projection to a business-only caller', () => {
    expect(specForPlane('business', businessOnly)).not.toBeNull();
  });

  it('serves both to a fully entitled caller', () => {
    expect(specForPlane('business', full)).not.toBeNull();
    expect(specForPlane('admin', full)).not.toBeNull();
  });

  it('never returns a document containing /admin paths on the business plane', () => {
    // The projections are generated, but this is the property the generation
    // exists to guarantee, so it is asserted against the real committed file
    // rather than the generator's own fixtures.
    const spec = specForPlane('business', full) as { paths: Record<string, unknown> };
    const adminPaths = Object.keys(spec.paths).filter((path) => path.includes('/admin/'));

    expect(adminPaths).toEqual([]);
  });

  it('serves a business projection that is genuinely populated', () => {
    // Guards against a generator regression that emits an empty document —
    // which would make the leak assertion above pass vacuously.
    const spec = specForPlane('business', full) as { paths: Record<string, unknown> };

    expect(Object.keys(spec.paths).length).toBeGreaterThan(50);
  });

  it('serves an admin projection that is a strict superset of the business one', () => {
    const business = specForPlane('business', full) as { paths: Record<string, unknown> };
    const admin = specForPlane('admin', full) as { paths: Record<string, unknown> };

    expect(Object.keys(admin.paths).length).toBeGreaterThan(Object.keys(business.paths).length);
    for (const path of Object.keys(business.paths)) {
      expect(admin.paths).toHaveProperty([path]);
    }
  });
});

describe('isSpecPlane', () => {
  it('accepts the two real planes', () => {
    expect(isSpecPlane('business')).toBe(true);
    expect(isSpecPlane('admin')).toBe(true);
  });

  it('rejects anything else, including path-traversal shapes', () => {
    expect(isSpecPlane('internal')).toBe(false);
    expect(isSpecPlane('../../etc/passwd')).toBe(false);
    expect(isSpecPlane('')).toBe(false);
  });
});
