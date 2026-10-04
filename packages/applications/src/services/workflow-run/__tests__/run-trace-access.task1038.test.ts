/**
 * TASK-1038 B3a deliverable 3 — who may open the ADMIN TRACE of a run (protocol-v2.md §5: the
 * console Test tab, and only the console). Every stored event, PHI included, so the audience is
 * narrower than `read:WorkflowRun`: a SUPER_ADMIN, or a TENANT_ADMIN of the working tenant —
 * never a doctor, never a machine credential.
 */
import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowRunTraceAccessService } from '../run-trace-access';

const TENANT = '10000000-0000-0000-0000-000000000001';
const OTHER = '10000000-0000-0000-0000-000000000002';

function service(rows: Array<{ tenantId: string; Roles: Array<{ name: string }> }> | Error) {
  const roleAssignments = {
    findAll: vi.fn(async () => {
      if (rows instanceof Error) throw rows;
      return rows;
    }),
  };
  return { svc: new WorkflowRunTraceAccessService(roleAssignments as never), roleAssignments };
}

describe('WorkflowRunTraceAccessService.assertCanTrace', () => {
  it('a super admin by session roles passes without a role read', async () => {
    const { svc, roleAssignments } = service([]);
    await expect(svc.assertCanTrace({ user: { id: 'u', roles: ['SUPER_ADMIN'] }, tenantId: TENANT })).resolves.toBeUndefined();
    expect(roleAssignments.findAll).not.toHaveBeenCalled();
  });

  it('a TENANT_ADMIN of THIS tenant passes (read from the tenant-scoped assignments)', async () => {
    const { svc } = service([{ tenantId: TENANT, Roles: [{ name: 'TENANT_ADMIN' }] }]);
    await expect(svc.assertCanTrace({ user: { id: 'u' }, tenantId: TENANT })).resolves.toBeUndefined();
  });

  it('a SUPER_ADMIN assignment passes even on a ticket-restored session that carries no roles', async () => {
    const { svc } = service([{ tenantId: '00000000-0000-0000-0000-000000000000', Roles: [{ name: 'SUPER_ADMIN' }] }]);
    await expect(svc.assertCanTrace({ user: { id: 'u' }, tenantId: TENANT })).resolves.toBeUndefined();
  });

  it.each([
    ['a TENANT_ADMIN of another tenant', [{ tenantId: OTHER, Roles: [{ name: 'TENANT_ADMIN' }] }]],
    ['a doctor', [{ tenantId: TENANT, Roles: [{ name: 'DOCTOR' }] }]],
  ])('%s is 403', async (_label, rows) => {
    const { svc } = service(rows);
    await expect(svc.assertCanTrace({ user: { id: 'u' }, tenantId: TENANT })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a service account is 403 — the trace is the console only', async () => {
    const { svc } = service([]);
    await expect(svc.assertCanTrace({ user: null, serviceAccount: { id: 'sa' }, tenantId: TENANT })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('fails closed on an unreadable role list or no user', async () => {
    await expect(service(new Error('db down')).svc.assertCanTrace({ user: { id: 'u' }, tenantId: TENANT })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service([]).svc.assertCanTrace({ user: null, tenantId: TENANT })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(new WorkflowRunTraceAccessService(undefined).assertCanTrace({ user: { id: 'u' }, tenantId: TENANT })).rejects.toBeInstanceOf(ForbiddenException);
  });
});
