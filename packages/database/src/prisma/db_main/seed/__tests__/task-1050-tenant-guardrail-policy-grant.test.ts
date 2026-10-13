import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICIES } from '../01-policy';
import { DEFAULT_ROLES } from '../03-role';

/**
 * TASK-1050 — `GET/PUT admin/guardrail/policy` gates on `read` / `manage:TenantGuardrailPolicy`. The
 * seeded TENANT_ADMIN must hold it (tenant-pinned), or the tenant on/off screen is code-correct and
 * unreachable by role; a clinician must not. SUPER_ADMIN reaches it through `manage:all`.
 */
function rulesFor(roleName: string) {
  const role = DEFAULT_ROLES.find((r) => r.name === roleName);
  if (!role) throw new Error(`No seeded role ${roleName}`);
  const names = [...role.policies];
  let parentId = (role as { parentRoleId?: string }).parentRoleId;
  while (parentId) {
    const parent = DEFAULT_ROLES.find((r) => r.id === parentId);
    if (!parent) break;
    names.push(...parent.policies);
    parentId = (parent as { parentRoleId?: string }).parentRoleId;
  }
  return DEFAULT_POLICIES.filter((policy) => names.includes(policy.name)).flatMap((policy) => policy.rules);
}

const grants = (roleName: string, subject: string) => rulesFor(roleName).filter((rule) => rule.subject === subject || rule.subject === 'all');

describe('TenantGuardrailPolicy CASL grant', () => {
  it('TENANT_ADMIN manages its OWN tenant`s guardrail policy', () => {
    expect(grants('TENANT_ADMIN', 'TenantGuardrailPolicy')).toContainEqual({
      action: 'manage',
      subject: 'TenantGuardrailPolicy',
      conditions: { tenantId: '${context.tenantId}' },
    });
  });

  it.each(['DOCTOR', 'NURSE', 'DEPARTMENT_HEAD', 'SENIOR_NURSE'])('%s holds no grant on it', (roleName) => {
    expect(grants(roleName, 'TenantGuardrailPolicy')).toEqual([]);
  });

  it('SUPER_ADMIN reaches it through manage:all', () => {
    expect(grants('SUPER_ADMIN', 'TenantGuardrailPolicy')).toContainEqual(expect.objectContaining({ action: 'manage', subject: 'all' }));
  });
});
