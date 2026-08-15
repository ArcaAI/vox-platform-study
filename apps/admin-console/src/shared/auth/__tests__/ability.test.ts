import { describe, expect, it } from 'vitest';
import { can, canAny, isElevated, type PermissionRule } from '../ability';

const rules: PermissionRule[] = [
  { action: 'read', subject: 'AuditLog' },
  { action: 'read,update', subject: 'Tenant', conditions: { id: 'tenant-1' } },
  { action: 'manage', subject: 'Department' },
];

describe('can', () => {
  it('matches exact action/subject pairs', () => {
    expect(can(rules, 'read', 'AuditLog')).toBe(true);
    expect(can(rules, 'delete', 'AuditLog')).toBe(false);
    expect(can(rules, 'read', 'Consultation')).toBe(false);
  });

  it('splits comma-joined actions from POST /rbac/check/my-permissions', () => {
    expect(can(rules, 'update', 'Tenant')).toBe(true);
    expect(can(rules, 'read', 'Tenant')).toBe(true);
    expect(can(rules, 'delete', 'Tenant')).toBe(false);
  });

  it('treats manage as granting every action on the subject', () => {
    expect(can(rules, 'read', 'Department')).toBe(true);
    expect(can(rules, 'delete', 'Department')).toBe(true);
  });

  it('treats manage:all as granting everything (global-admin set)', () => {
    const globalAdmin: PermissionRule[] = [{ action: 'manage', subject: 'all' }];
    expect(can(globalAdmin, 'read', 'PlatformMetrics')).toBe(true);
    expect(can(globalAdmin, 'manage', 'Tenant')).toBe(true);
  });

  it('denies on empty or missing rules', () => {
    expect(can([], 'read', 'AuditLog')).toBe(false);
    expect(can(null, 'read', 'AuditLog')).toBe(false);
    expect(can(undefined, 'read', 'AuditLog')).toBe(false);
  });
});

describe('canAny', () => {
  it('grants when any pair matches', () => {
    expect(
      canAny(rules, [
        ['manage', 'Tenant'],
        ['update', 'Tenant'],
      ]),
    ).toBe(true);
    expect(
      canAny(rules, [
        ['manage', 'Tenant'],
        ['manage', 'all'],
      ]),
    ).toBe(false);
  });
});

describe('isElevated', () => {
  it('recognizes SUPER_ADMIN as the single elevated role (renamed from GLOBAL_ADMIN)', () => {
    expect(isElevated(['SUPER_ADMIN'])).toBe(true);
    // The pre-rename GLOBAL_ADMIN literal no longer elevates.
    expect(isElevated(['GLOBAL_ADMIN'])).toBe(false);
    expect(isElevated(['TENANT_ADMIN'])).toBe(false);
    expect(isElevated([])).toBe(false);
    expect(isElevated(undefined)).toBe(false);
  });
});
