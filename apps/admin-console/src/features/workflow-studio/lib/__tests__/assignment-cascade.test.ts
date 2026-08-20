/**
 * TDD for the assignment matrix's client-side cascade derivation (TASK-733 half (a) Task 6):
 * department override -> tenant default -> platform default, mirroring
 * `WorkflowAssignmentService.resolve()`'s tier order without re-querying a resolve endpoint
 * that the admin controller does not expose.
 */

import { describe, expect, it } from 'vitest';
import { findDepartmentAssignment, findTenantAssignment, resolveDepartmentCell, resolveTenantCell } from '../assignment-cascade';
import type { WorkflowAssignment } from '../../api/types';

function makeRow(overrides: Partial<WorkflowAssignment>): WorkflowAssignment {
  return {
    id: 'row-1',
    tenantId: 'tenant-1',
    scope: 'TENANT',
    scopeId: null,
    paletteKey: 'consultation',
    workflowDefinitionSlug: 'default-note',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

describe('assignment-cascade', () => {
  it('finds the tenant-default row (scope TENANT, scopeId null) among mixed rows', () => {
    const tenantRow = makeRow({ id: 'tenant-row' });
    const deptRow = makeRow({ id: 'dept-row', scope: 'DEPARTMENT', scopeId: 'dept-1' });
    expect(findTenantAssignment([deptRow, tenantRow])).toBe(tenantRow);
  });

  it('finds a department override by scopeId, ignoring other departments', () => {
    const deptA = makeRow({ id: 'dept-a', scope: 'DEPARTMENT', scopeId: 'dept-a' });
    const deptB = makeRow({ id: 'dept-b', scope: 'DEPARTMENT', scopeId: 'dept-b' });
    expect(findDepartmentAssignment([deptA, deptB], 'dept-b')).toBe(deptB);
    expect(findDepartmentAssignment([deptA], 'dept-missing')).toBeUndefined();
  });

  it('resolveTenantCell: an explicit tenant row wins', () => {
    const tenantRow = makeRow({ workflowDefinitionSlug: 'radiology-note' });
    expect(resolveTenantCell([tenantRow])).toEqual({ explicit: tenantRow, slug: 'radiology-note', source: 'explicit' });
  });

  it('resolveTenantCell: no tenant row -> platform default, no slug visibility', () => {
    expect(resolveTenantCell([])).toEqual({ explicit: null, slug: null, source: 'platform-default' });
  });

  it('resolveDepartmentCell: a department override wins over the tenant default', () => {
    const tenantRow = makeRow({ id: 'tenant-row', workflowDefinitionSlug: 'tenant-note' });
    const deptRow = makeRow({ id: 'dept-row', scope: 'DEPARTMENT', scopeId: 'dept-1', workflowDefinitionSlug: 'radiology-note' });
    expect(resolveDepartmentCell([tenantRow, deptRow], 'dept-1')).toEqual({ explicit: deptRow, slug: 'radiology-note', source: 'explicit' });
  });

  it('resolveDepartmentCell: absent department override inherits the tenant default', () => {
    const tenantRow = makeRow({ id: 'tenant-row', workflowDefinitionSlug: 'tenant-note' });
    expect(resolveDepartmentCell([tenantRow], 'dept-1')).toEqual({ explicit: null, slug: 'tenant-note', source: 'tenant' });
  });

  it('resolveDepartmentCell: no tenant row either -> platform default', () => {
    expect(resolveDepartmentCell([], 'dept-1')).toEqual({ explicit: null, slug: null, source: 'platform-default' });
  });

  it('resolveDepartmentCell: a cross-tenant / cross-department row never leaks in (as if absent)', () => {
    const otherDept = makeRow({ id: 'other-dept', scope: 'DEPARTMENT', scopeId: 'dept-other', workflowDefinitionSlug: 'other-note' });
    expect(resolveDepartmentCell([otherDept], 'dept-1')).toEqual({ explicit: null, slug: null, source: 'platform-default' });
  });
});
