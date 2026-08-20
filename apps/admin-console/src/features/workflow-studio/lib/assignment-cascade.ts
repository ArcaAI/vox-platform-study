/**
 * Client-side "which tier wins" derivation for the assignment matrix (TASK-733 half (a) Task 6).
 *
 * There is no admin-facing `resolve` endpoint — `IWorkflowAssignmentService.resolve()` is an
 * internal dispatcher seam, not exposed on `WorkflowAssignmentController`. The admin screen
 * shows the SAME cascade order the service walks (`department override -> tenant default ->
 * platform default`, `packages/applications/src/services/workflow-assignment/workflow-assignment.service.ts`)
 * but derives it from the raw rows this screen already reads (`GET /admin/workflow-assignments`)
 * rather than re-querying a resolve endpoint that does not exist here. "Platform default" is
 * therefore reported as a SOURCE, never as a resolved slug — the screen has no visibility into
 * the SYSTEM-tenant row (assignment rows are tenant-scoped, `WorkflowAssignment` is deliberately
 * NOT in `SYSTEM_SHARED_READ_MODELS` — rule 02), matching the service's own `{ slug: null,
 * source: 'platform-default' }` contract.
 */

import type { WorkflowAssignment } from '../api/types';

export type AssignmentCellSource = 'explicit' | 'tenant' | 'platform-default';

export interface ResolvedAssignmentCell {
  /** The row backing an EXPLICIT assignment at this tier, or `null` when inheriting. */
  explicit: WorkflowAssignment | null;
  /** The slug this cell currently resolves to; `null` = platform default (no visibility here). */
  slug: string | null;
  source: AssignmentCellSource;
}

/** The tenant-default row (`scope: 'TENANT'`, `scopeId: null`) for one palette, or `undefined`. */
export function findTenantAssignment(rows: readonly WorkflowAssignment[]): WorkflowAssignment | undefined {
  return rows.find((row) => row.scope === 'TENANT');
}

/** The department-override row for one palette + department, or `undefined`. */
export function findDepartmentAssignment(rows: readonly WorkflowAssignment[], departmentId: string): WorkflowAssignment | undefined {
  return rows.find((row) => row.scope === 'DEPARTMENT' && row.scopeId === departmentId);
}

/** Tenant-tier cell: explicit tenant row, or inherits the platform default. */
export function resolveTenantCell(rows: readonly WorkflowAssignment[]): ResolvedAssignmentCell {
  const tenantRow = findTenantAssignment(rows);
  if (tenantRow) return { explicit: tenantRow, slug: tenantRow.workflowDefinitionSlug, source: 'explicit' };
  return { explicit: null, slug: null, source: 'platform-default' };
}

/** Department-tier cell: explicit department row wins; else inherits tenant; else platform default. */
export function resolveDepartmentCell(rows: readonly WorkflowAssignment[], departmentId: string): ResolvedAssignmentCell {
  const departmentRow = findDepartmentAssignment(rows, departmentId);
  if (departmentRow) return { explicit: departmentRow, slug: departmentRow.workflowDefinitionSlug, source: 'explicit' };

  const tenantRow = findTenantAssignment(rows);
  if (tenantRow) return { explicit: null, slug: tenantRow.workflowDefinitionSlug, source: 'tenant' };

  return { explicit: null, slug: null, source: 'platform-default' };
}
