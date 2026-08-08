/**
 * TASK-641 Lane B — tenant-full-access RBAC grant for TenantAllowedOrigin.
 *
 * Static assertion over the EXPORTED `DEFAULT_POLICIES` seed data (no live DB),
 * following the conventions of `tenant-tts-config-seed.test.ts` in this directory.
 *
 * The `tenant-full-access` policy (TENANT_ADMIN) must carry a
 * `manage:TenantAllowedOrigin` rule so a tenant admin can self-serve their own
 * tenant's CORS allowed-origin rows (TASK-641 §3.1 step 1, closing blocker B-2).
 * The `conditions: { tenantId: '${context.tenantId}' }` clause is load-bearing —
 * without it the grant would be cross-tenant.
 */

import { describe, it, expect } from 'vitest';

import { DEFAULT_POLICIES } from '../01-policy';

describe('tenant-full-access policy — TenantAllowedOrigin grant (TASK-641)', () => {
  const policy = DEFAULT_POLICIES.find((p) => p.name === 'tenant-full-access');

  it('policy exists', () => {
    expect(policy).toBeDefined();
  });

  it('grants manage:TenantAllowedOrigin', () => {
    expect(policy?.rules).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'manage', subject: 'TenantAllowedOrigin' })]),
    );
  });

  it('scopes the grant to the caller tenant via conditions.tenantId (not cross-tenant)', () => {
    const rule = policy?.rules.find((r) => r.subject === 'TenantAllowedOrigin');
    expect(rule?.conditions).toEqual({ tenantId: '${context.tenantId}' });
  });
});
