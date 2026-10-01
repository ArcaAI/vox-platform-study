import { describe, expect, it } from 'vitest';
import { CHECKPOINT_REGISTRY, descriptorFor } from '../registry';
import { scopePredicate } from '../scope';

const MEMBERS =
  '(SELECT "userId" FROM core."UserRoleAssignment" WHERE "tenantId" = $1 UNION SELECT "userId" FROM core."UserDepartment" WHERE "tenantId" = $1)';

describe('scopePredicate', () => {
  it('tenantColumn', () => {
    expect(scopePredicate(descriptorFor('Agent'), 's')).toBe('s."tenantId" = $1');
    expect(scopePredicate(descriptorFor('ApiKey'), 'l')).toBe('l."tenantId" = $1');
  });

  it('honours a tenantColumn override', () => {
    const d = { ...descriptorFor('Agent'), scope: { kind: 'tenantColumn' as const, column: 'ownerTenantId' } };
    expect(scopePredicate(d, 's')).toBe('s."ownerTenantId" = $1');
  });

  it('parent', () => {
    expect(scopePredicate(descriptorFor('WebhookRunHistory'), 's')).toBe(
      's."webhookId" IN (SELECT p."id" FROM core."Webhook" p WHERE p."tenantId" = $1)',
    );
    expect(scopePredicate(descriptorFor('RolePolicy'), 's')).toBe(
      's."roleId" IN (SELECT p."id" FROM core."Role" p WHERE p."tenantId" = $1)',
    );
  });

  it('tenantMembers', () => {
    expect(scopePredicate(descriptorFor('User'), 's')).toBe(`s."id" IN ${MEMBERS}`);
  });

  it('parent → tenantMembers nests with its own alias', () => {
    expect(scopePredicate(descriptorFor('UserProfile'), 's')).toBe(
      `s."userId" IN (SELECT p."id" FROM core."User" p WHERE p."id" IN ${MEMBERS})`,
    );
  });

  it('two-level parents use p, p2', () => {
    const child = { ...descriptorFor('WebhookRunHistory'), model: 'X', scope: { kind: 'parent' as const, fk: 'historyId', parent: 'WebhookRunHistory' } };
    expect(scopePredicate(child, 's')).toBe(
      's."historyId" IN (SELECT p."id" FROM core."WebhookRunHistory" p WHERE p."webhookId" IN (SELECT p2."id" FROM core."Webhook" p2 WHERE p2."tenantId" = $1))',
    );
  });

  it('refuses EXCLUDED models', () => {
    expect(() => scopePredicate(descriptorFor('Tenant'), 's')).toThrow(/EXCLUDED/);
  });

  it('every captured model yields a predicate bound to $1', () => {
    for (const d of CHECKPOINT_REGISTRY.filter((x) => x.policy !== 'EXCLUDED')) {
      expect(scopePredicate(d, 's'), d.model).toContain('= $1');
    }
  });
});
