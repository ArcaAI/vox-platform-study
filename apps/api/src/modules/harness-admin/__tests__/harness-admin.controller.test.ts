/**
 * HarnessAdminController authz/scoping unit tests (TASK-330 Phase 6).
 *
 * The CASL `@Authorize` tuples + `If-Match`/`@RequiresIfMatch` decorators are
 * exercised by the guard/interceptor (and e2e). These specs cover the
 * controller's OWN logic: super-admin vs. tenant read scoping, the platform
 * gate on the GLOBAL-DEFAULT routes, workflow tenant-ownership enforcement, and
 * the If-Match-over-body version precedence forwarded to the policy service.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { HarnessAdminController } from '../harness-admin.controller';

type Ctx = { user?: { roles?: string[] | null; tenantId?: string } | null; tenantId?: string };

const SUPER: Ctx['user'] = { roles: ['SUPER_ADMIN'] };
const TENANT_ADMIN = (tenantId: string): Ctx['user'] => ({ roles: ['TENANT_ADMIN'], tenantId });

function makeController(ctx: Ctx) {
  const policyService = {
    getEffectivePolicy: vi.fn(),
    updatePolicy: vi.fn(),
    getGlobalDefault: vi.fn(),
    updateGlobalDefault: vi.fn(),
  };
  const observabilityService = {
    listAuditEvents: vi.fn().mockResolvedValue({ items: [] }),
    listEvalRuns: vi.fn().mockResolvedValue({ items: [] }),
    getEvalRun: vi.fn(),
    gateQueue: vi.fn().mockResolvedValue({ items: [] }),
  };
  const opsClient = {
    listWorkflows: vi.fn().mockResolvedValue({ items: [] }),
    describeWorkflow: vi.fn(),
    cancelWorkflow: vi.fn().mockResolvedValue({ requested: true }),
    terminateWorkflow: vi.fn().mockResolvedValue({ requested: true }),
    signalWorkflow: vi.fn().mockResolvedValue({ requested: true }),
  };
  const cls = { get: vi.fn((key: string) => (ctx as Record<string, unknown>)[key]) };
  const controller = new HarnessAdminController(
    policyService as never,
    observabilityService as never,
    opsClient as never,
    cls as never,
  );
  return { controller, policyService, observabilityService, opsClient };
}

describe('HarnessAdminController — policy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getPolicy returns the effective policy for the caller tenant', async () => {
    const { controller, policyService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    const resp = { id: 'p1', tenantId: 't1', version: 3 };
    policyService.getEffectivePolicy.mockResolvedValue(resp);

    await expect(controller.getPolicy()).resolves.toBe(resp);
    expect(policyService.getEffectivePolicy).toHaveBeenCalledWith();
  });

  it('updatePolicy prefers the If-Match header version over the body expectedVersion', async () => {
    const { controller, policyService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    const request = { expectedVersion: 2, coverage: 0.9 } as never;

    await controller.updatePolicy(request, 5);
    expect(policyService.updatePolicy).toHaveBeenCalledWith(request, 5);
  });

  it('updatePolicy falls back to the body expectedVersion when no If-Match header', async () => {
    const { controller, policyService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    const request = { expectedVersion: 2 } as never;

    await controller.updatePolicy(request, undefined);
    expect(policyService.updatePolicy).toHaveBeenCalledWith(request, 2);
  });

  it('getGlobalPolicy is forbidden for a tenant admin (super-admin only)', async () => {
    const { controller, policyService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.getGlobalPolicy()).rejects.toBeInstanceOf(ForbiddenException);
    expect(policyService.getGlobalDefault).not.toHaveBeenCalled();
  });

  it('getGlobalPolicy is allowed for a super-admin', async () => {
    const { controller, policyService } = makeController({ user: SUPER });
    const resp = { id: 'global', tenantId: '00000000-0000-0000-0000-000000000000', version: 1 };
    policyService.getGlobalDefault.mockResolvedValue(resp);
    await expect(controller.getGlobalPolicy()).resolves.toBe(resp);
  });

  it('updateGlobalPolicy is forbidden for a tenant admin', async () => {
    const { controller, policyService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.updateGlobalPolicy({} as never, 1)).rejects.toBeInstanceOf(ForbiddenException);
    expect(policyService.updateGlobalDefault).not.toHaveBeenCalled();
  });
});

describe('HarnessAdminController — read tenant scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pins a tenant admin to their own tenant', async () => {
    const { controller, observabilityService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await controller.listAudit({});
    expect(observabilityService.listAuditEvents).toHaveBeenCalledWith('t1', expect.anything());
  });

  it('forwards the consultation, action, and date-range audit filters to the service', async () => {
    const { controller, observabilityService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await controller.listAudit({
      consultationId: 'c1',
      action: 'GATE_DECISION',
      from: '2026-02-01T00:00:00.000Z',
      to: '2026-02-28T23:59:59.999Z',
      limit: '25',
      offset: '50',
    });
    expect(observabilityService.listAuditEvents).toHaveBeenCalledWith('t1', {
      consultationId: 'c1',
      action: 'GATE_DECISION',
      from: '2026-02-01T00:00:00.000Z',
      to: '2026-02-28T23:59:59.999Z',
      limit: 25,
      offset: 50,
    });
  });

  it('rejects a tenant admin targeting another tenant via ?tenantId', async () => {
    const { controller } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.listAudit({ tenantId: 't2' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets a super-admin target any tenant via ?tenantId', async () => {
    const { controller, observabilityService } = makeController({ user: SUPER });
    await controller.gateQueue({ tenantId: 't9' });
    expect(observabilityService.gateQueue).toHaveBeenCalledWith('t9');
  });

  it('requires a super-admin to pass ?tenantId when there is no CLS tenant', async () => {
    const { controller } = makeController({ user: SUPER });
    await expect(controller.gateQueue({})).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('HarnessAdminController — workflow ops ownership', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists all tenants for a super-admin (undefined tenant filter)', async () => {
    const { controller, opsClient } = makeController({ user: SUPER });
    await controller.listWorkflows({});
    expect(opsClient.listWorkflows).toHaveBeenCalledWith(expect.objectContaining({ tenantId: undefined }));
  });

  it('scopes the workflow list to a tenant admin own tenant', async () => {
    const { controller, opsClient } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await controller.listWorkflows({});
    expect(opsClient.listWorkflows).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1' }));
  });

  it('forbids a tenant admin from describing another tenant workflow', async () => {
    const { controller, opsClient } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    opsClient.describeWorkflow.mockResolvedValue({ workflowId: 'wf-1', tenantId: 't2' });
    await expect(controller.describeWorkflow('wf-1', {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets a super-admin describe any tenant workflow', async () => {
    const { controller, opsClient } = makeController({ user: SUPER });
    const detail = { workflowId: 'wf-1', tenantId: 't2' };
    opsClient.describeWorkflow.mockResolvedValue(detail);
    await expect(controller.describeWorkflow('wf-1', {})).resolves.toBe(detail);
  });

  it('cancels an owned workflow and forwards the owning tenantId to the harness', async () => {
    const { controller, opsClient } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    opsClient.describeWorkflow.mockResolvedValue({ workflowId: 'wf-1', tenantId: 't1' });
    await controller.cancelWorkflow('wf-1', { reason: 'duplicate' } as never);
    expect(opsClient.cancelWorkflow).toHaveBeenCalledWith('wf-1', { tenantId: 't1', reason: 'duplicate' });
  });

  it('forbids cancelling another tenant workflow and never calls the harness', async () => {
    const { controller, opsClient } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    opsClient.describeWorkflow.mockResolvedValue({ workflowId: 'wf-1', tenantId: 't2' });
    await expect(controller.cancelWorkflow('wf-1', {} as never)).rejects.toBeInstanceOf(ForbiddenException);
    expect(opsClient.cancelWorkflow).not.toHaveBeenCalled();
  });
});
