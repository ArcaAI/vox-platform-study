/**
 * TASK-762 §5.6 — audit attribution for a MACHINE actor.
 *
 * `AuditLog` carried only `responsibleUserId`/`responsibleIp`, so an admin
 * action performed by a machine was recorded against a PERSON — the human the
 * credential happened to be bound to. That is wrong in a way a reviewer cannot
 * detect, which is why this is the prerequisite that had to land before the
 * credential class itself.
 *
 * The invariant: the two actor columns are MUTUALLY EXCLUSIVE. A machine row
 * leaves `responsibleUserId` NULL rather than borrowing an identity.
 */
import { describe, it, expect } from 'vitest';
import { AuditLogFactory } from '../../../../factories/generated/core/AuditLogFactory';
import { AuditAction, ResourceType } from '../../../../enums';

const base = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  resourceType: ResourceType.Department,
  action: AuditAction.UPDATE,
  data: {},
  previousData: {},
};

describe('AuditLog machine-actor attribution', () => {
  it('records a service-account actor and leaves responsibleUserId null', () => {
    const entity = AuditLogFactory.CreateAuditLog({
      ...base,
      responsibleServiceAccountId: 'sa-1',
    });

    expect(entity.responsibleServiceAccountId).toBe('sa-1');
    expect(entity.responsibleUserId).toBeNull();
  });

  it('records a human actor with no service-account id — no regression to existing attribution', () => {
    const entity = AuditLogFactory.CreateAuditLog({
      ...base,
      responsibleUserId: 'user-1',
    });

    expect(entity.responsibleUserId).toBe('user-1');
    expect(entity.responsibleServiceAccountId).toBeNull();
  });

  it('keeps the pre-existing empty-string default for a human row that names no actor', () => {
    // Behaviour deliberately unchanged: only the machine path opts into null.
    const entity = AuditLogFactory.CreateAuditLog({ ...base });
    expect(entity.responsibleUserId).toBe('');
    expect(entity.responsibleServiceAccountId).toBeNull();
  });

  it('rejects a row claiming BOTH a human and a machine actor', () => {
    const entity = AuditLogFactory.CreateAuditLog({
      ...base,
      responsibleUserId: 'user-1',
      responsibleServiceAccountId: 'sa-1',
    });
    expect(() => entity.validate()).toThrow(/exactly one actor/i);
  });

  it('exposes the machine actor through the ordinary change-tracked setter', () => {
    const entity = AuditLogFactory.CreateAuditLog({ ...base, responsibleUserId: 'user-1' });
    entity.responsibleServiceAccountId = 'sa-2';
    expect(entity.changes).toMatchObject({ responsibleServiceAccountId: 'sa-2' });
  });
});
