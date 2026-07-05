/**
 * HarnessAdminController authz/scoping unit tests (TASK-330 Phase 6).
 *
 * The CASL `@Authorize` tuples + `If-Match`/`@RequiresIfMatch` decorators are
 * exercised by the guard/interceptor (and e2e). These specs cover the
 * controller's OWN logic: global-admin vs. tenant read scoping, the platform
 * gate on the GLOBAL-DEFAULT routes, workflow tenant-ownership enforcement, and
 * the If-Match-over-body version precedence forwarded to the policy service.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { HarnessAdminController } from '../harness-admin.controller';

type Ctx = { user?: { roles?: string[] | null; tenantId?: string } | null; tenantId?: string };

const SUPER: Ctx['user'] = { roles: ['GLOBAL_ADMIN'] };
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
  const liveDocumentationService = {
    getActiveSessions: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    getSessionStats: vi.fn().mockResolvedValue(null),
    getEngineConfig: vi.fn().mockResolvedValue({ enabled: true, envDefault: true, source: 'env-default' }),
    setEngineEnabled: vi.fn().mockResolvedValue({ enabled: false, envDefault: true, source: 'redis-override' }),
  };
  const evalService = {
    listGoldenSets: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    getGoldenSet: vi.fn().mockResolvedValue({ id: 'set-1' }),
    listGoldenCases: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    addGoldenSet: vi.fn().mockResolvedValue({ id: 'set-1' }),
    addGoldenCase: vi.fn().mockResolvedValue({ id: 'case-1' }),
  };
  const cls = { get: vi.fn((key: string) => (ctx as Record<string, unknown>)[key]) };
  const controller = new HarnessAdminController(
    policyService as never,
    observabilityService as never,
    opsClient as never,
    cls as never,
    liveDocumentationService as never,
    evalService as never,
  );
  return { controller, policyService, observabilityService, opsClient, liveDocumentationService, evalService };
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

  it('getGlobalPolicy is forbidden for a tenant admin (global-admin only)', async () => {
    const { controller, policyService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.getGlobalPolicy()).rejects.toBeInstanceOf(ForbiddenException);
    expect(policyService.getGlobalDefault).not.toHaveBeenCalled();
  });

  it('getGlobalPolicy is allowed for a global-admin', async () => {
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

  it('lets a global-admin target any tenant via ?tenantId', async () => {
    const { controller, observabilityService } = makeController({ user: SUPER });
    await controller.gateQueue({ tenantId: 't9' });
    expect(observabilityService.gateQueue).toHaveBeenCalledWith('t9');
  });

  it('requires a global-admin to pass ?tenantId when there is no CLS tenant', async () => {
    const { controller } = makeController({ user: SUPER });
    await expect(controller.gateQueue({})).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('HarnessAdminController — workflow ops ownership', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists all tenants for a global-admin (undefined tenant filter)', async () => {
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

  it('lets a global-admin describe any tenant workflow', async () => {
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

// TASK-341 B2/B3 — admin live console: monitoring (tenant-scoped) + kill-switch (global-admin).
describe('HarnessAdminController — live sessions (TENANT_ADMIN, tenant-scoped)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists the caller tenant active sessions', async () => {
    const { controller, liveDocumentationService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    liveDocumentationService.getActiveSessions.mockResolvedValue({ items: [{ consultationId: 'c1', tenantId: 't1' }], total: 1 });

    const result = await controller.listLiveSessions({});
    expect(liveDocumentationService.getActiveSessions).toHaveBeenCalledWith('t1');
    expect(result.total).toBe(1);
  });

  it('pins a tenant admin to their own tenant (rejects ?tenantId targeting another tenant)', async () => {
    const { controller } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.listLiveSessions({ tenantId: 't2' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets a global-admin target a tenant via ?tenantId', async () => {
    const { controller, liveDocumentationService } = makeController({ user: SUPER });
    await controller.listLiveSessions({ tenantId: 't9' });
    expect(liveDocumentationService.getActiveSessions).toHaveBeenCalledWith('t9');
  });

  it('returns a single session scoped to the caller tenant', async () => {
    const { controller, liveDocumentationService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    liveDocumentationService.getSessionStats.mockResolvedValue({ consultationId: 'c1', tenantId: 't1' });

    const result = await controller.getLiveSession('c1', {});
    expect(liveDocumentationService.getSessionStats).toHaveBeenCalledWith('t1', 'c1');
    expect(result).toMatchObject({ consultationId: 'c1' });
  });

  it('404s when the session stats are absent / cross-tenant', async () => {
    const { controller, liveDocumentationService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    liveDocumentationService.getSessionStats.mockResolvedValue(null);
    await expect(controller.getLiveSession('c-missing', {})).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('HarnessAdminController — live engine kill-switch (GLOBAL_ADMIN / global-scope)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getLiveConfig is forbidden for a tenant admin', async () => {
    const { controller, liveDocumentationService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.getLiveConfig()).rejects.toBeInstanceOf(ForbiddenException);
    expect(liveDocumentationService.getEngineConfig).not.toHaveBeenCalled();
  });

  it('getLiveConfig is allowed for a global-admin', async () => {
    const { controller, liveDocumentationService } = makeController({ user: SUPER });
    const resp = { enabled: true, envDefault: true, source: 'env-default' };
    liveDocumentationService.getEngineConfig.mockResolvedValue(resp);
    await expect(controller.getLiveConfig()).resolves.toBe(resp);
  });

  it('updateLiveConfig is forbidden for a tenant admin and never toggles', async () => {
    const { controller, liveDocumentationService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.updateLiveConfig({ enabled: false } as never)).rejects.toBeInstanceOf(ForbiddenException);
    expect(liveDocumentationService.setEngineEnabled).not.toHaveBeenCalled();
  });

  it('updateLiveConfig toggles the kill-switch for a global-admin, carrying the actor + reason', async () => {
    const { controller, liveDocumentationService } = makeController({ user: { roles: ['GLOBAL_ADMIN'], id: 'admin-7' } as never });
    await controller.updateLiveConfig({ enabled: false, reason: 'incident' } as never);
    expect(liveDocumentationService.setEngineEnabled).toHaveBeenCalledWith(false, { userId: 'admin-7', reason: 'incident' });
  });
});

// TASK-419 item 1 — golden-set dataset surface (reads: read:HarnessEval,
// creates: manage:HarnessEval). Same tenant resolution as the other reads.
describe('HarnessAdminController — golden sets (TASK-419)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('listGoldenSets pins a tenant admin to their own tenant and forwards numeric paging', async () => {
    const { controller, evalService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await controller.listGoldenSets({ page: '2', limit: '5' });
    expect(evalService.listGoldenSets).toHaveBeenCalledWith('t1', { page: 2, limit: 5 });
  });

  it('listGoldenSets lets a global-admin target a tenant via ?tenantId', async () => {
    const { controller, evalService } = makeController({ user: SUPER });
    await controller.listGoldenSets({ tenantId: 't9' });
    expect(evalService.listGoldenSets).toHaveBeenCalledWith('t9', { page: undefined, limit: undefined });
  });

  it('getGoldenSet resolves the tenant and forwards the id', async () => {
    const { controller, evalService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await controller.getGoldenSet('set-1', {});
    expect(evalService.getGoldenSet).toHaveBeenCalledWith('t1', 'set-1');
  });

  it('listGoldenCases forwards the set id under the resolved tenant', async () => {
    const { controller, evalService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await controller.listGoldenCases('set-1', { page: '1', limit: '10' });
    expect(evalService.listGoldenCases).toHaveBeenCalledWith('t1', 'set-1', { page: 1, limit: 10 });
  });

  it('createGoldenSet writes under the resolved tenant, stamping the CLS user as createdBy', async () => {
    const { controller, evalService } = makeController({ user: { roles: ['TENANT_ADMIN'], tenantId: 't1', id: 'user-9' } as never, tenantId: 't1' });
    await controller.createGoldenSet({ name: 'GI set', description: 'gold' } as never, {});
    expect(evalService.addGoldenSet).toHaveBeenCalledWith({ tenantId: 't1', name: 'GI set', description: 'gold', pinnedVersion: undefined, createdBy: 'user-9' });
  });

  it('createGoldenSet rejects a tenant admin targeting another tenant', async () => {
    const { controller, evalService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.createGoldenSet({ name: 'x' } as never, { tenantId: 't2' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(evalService.addGoldenSet).not.toHaveBeenCalled();
  });

  it('createGoldenCase forwards the parent set id + PHI payload under the resolved tenant', async () => {
    const { controller, evalService } = makeController({ user: { roles: ['TENANT_ADMIN'], tenantId: 't1', id: 'user-9' } as never, tenantId: 't1' });
    await controller.createGoldenCase('set-1', { transcript: 't', referenceNote: 'r', label: 'a' } as never, {});
    expect(evalService.addGoldenCase).toHaveBeenCalledWith({
      tenantId: 't1',
      goldenSetId: 'set-1',
      transcript: 't',
      referenceNote: 'r',
      label: 'a',
      createdBy: 'user-9',
    });
  });
});

describe('HarnessAdminController — golden-set authorization metadata (TASK-419)', () => {
  it('reads are pinned to read:HarnessEval, creates to manage:HarnessEval', () => {
    const proto = HarnessAdminController.prototype;
    expect(Reflect.getMetadata('required_permissions', proto.listGoldenSets)).toEqual([{ action: 'read', subject: 'HarnessEval' }]);
    expect(Reflect.getMetadata('required_permissions', proto.getGoldenSet)).toEqual([{ action: 'read', subject: 'HarnessEval' }]);
    expect(Reflect.getMetadata('required_permissions', proto.listGoldenCases)).toEqual([{ action: 'read', subject: 'HarnessEval' }]);
    expect(Reflect.getMetadata('required_permissions', proto.createGoldenSet)).toEqual([{ action: 'manage', subject: 'HarnessEval' }]);
    expect(Reflect.getMetadata('required_permissions', proto.createGoldenCase)).toEqual([{ action: 'manage', subject: 'HarnessEval' }]);
  });
});
