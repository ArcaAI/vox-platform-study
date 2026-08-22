/**
 * HarnessAdminController authz/scoping unit tests.
 *
 * The CASL `@Authorize` tuples + `If-Match`/`@RequiresIfMatch` decorators are
 * exercised by the guard/interceptor (and e2e). These specs cover the
 * controller's OWN logic: super-admin vs. tenant read scoping, the platform
 * gate on the GLOBAL-DEFAULT routes, workflow tenant-ownership enforcement, and
 * the If-Match-over-body version precedence forwarded to the policy service.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataNotFoundException } from '@arcaai/exceptions';
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
    getEditBurden: vi.fn(),
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
  const gateEditMiningService = {
    exportCorpusCandidates: vi.fn().mockResolvedValue({
      tenantId: 'tenant-1',
      reviewStatus: 'PENDING_SME_REVIEW',
      count: 0,
      candidates: [],
    }),
    // F-24: the curation write half.
    curateExemplar: vi.fn().mockResolvedValue({
      id: 'ex-1',
      tenantId: 'tenant-1',
      curationStatus: 'APPROVED',
      previousStatus: 'PENDING',
    }),
    // TASK-792 W4: the JSONL fine-tuning export. Declared here (not assigned
    // onto the object at the call site) so the mock's inferred type carries
    // them and `tsc --noEmit` stays clean.
    exportFineTuningDataset: vi.fn().mockResolvedValue({
      schemaVersion: 'hope.gate-edit.finetune.v1',
      tenantId: 'tenant-1',
      reviewStatus: 'SME_APPROVED',
      count: 0,
      records: [],
    }),
    toJsonl: vi.fn().mockReturnValue(''),
  };
  const evalRunService = {
    runGoldenSet: vi.fn().mockResolvedValue({ id: 'run-1' }),
  };
  // TASK-792 W3 — backs `POST gate-edit-exemplars/:id/promote-to-golden-set`.
  const goldenCasePromotionService = {
    promoteExemplarToGoldenCase: vi.fn().mockResolvedValue({ id: 'gc-1', label: 'CLINICIAN_DERIVED_PENDING_SME:ex-1' }),
  };
  const controller = new HarnessAdminController(
    policyService as never,
    observabilityService as never,
    opsClient as never,
    cls as never,
    liveDocumentationService as never,
    evalService as never,
    gateEditMiningService as never,
    evalRunService as never,
    goldenCasePromotionService as never,
  );
  return {
    controller,
    policyService,
    observabilityService,
    opsClient,
    liveDocumentationService,
    evalService,
    gateEditMiningService,
    goldenCasePromotionService,
    evalRunService,
  };
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

// Phase 0 D3 — expose HarnessObservabilityService#getEditBurden.
// The real service signature is `getEditBurden(tenantId, consultationId)` —
// a single-consultation lookup, not a `from`/`to` date range.
describe('HarnessAdminController — edit burden', () => {
  beforeEach(() => vi.clearAllMocks());

  const BURDEN = {
    consultationId: 'c1',
    editDistance: 3,
    editDistanceRatio: 0.1,
    deferralRate: 0.5,
    gateDecisionTotal: 2,
    deferralCount: 1,
    timeToSignSeconds: 1800,
    deliveredAt: '2026-07-10T10:00:00.000Z',
    signedAt: '2026-07-10T10:30:00.000Z',
  };

  const EMPTY_BURDEN = {
    consultationId: 'c-missing',
    editDistance: null,
    editDistanceRatio: null,
    deferralRate: null,
    gateDecisionTotal: 0,
    deferralCount: 0,
    timeToSignSeconds: null,
    deliveredAt: null,
    signedAt: null,
  };

  it('delegates to the service with the resolved tenantId and the query consultationId', async () => {
    const { controller, observabilityService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    observabilityService.getEditBurden.mockResolvedValue(BURDEN);

    const result = await controller.getEditBurden({ consultationId: 'c1' } as never);

    expect(observabilityService.getEditBurden).toHaveBeenCalledWith('t1', 'c1');
    expect(result).toBe(BURDEN);
  });

  it('rejects a tenant admin targeting another tenant via ?tenantId', async () => {
    const { controller, observabilityService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.getEditBurden({ consultationId: 'c1', tenantId: 't2' } as never)).rejects.toBeInstanceOf(ForbiddenException);
    expect(observabilityService.getEditBurden).not.toHaveBeenCalled();
  });

  it('lets a super-admin target any tenant via ?tenantId', async () => {
    const { controller, observabilityService } = makeController({ user: SUPER });
    observabilityService.getEditBurden.mockResolvedValue({ ...BURDEN, consultationId: 'c9' });

    await controller.getEditBurden({ consultationId: 'c9', tenantId: 't9' } as never);

    expect(observabilityService.getEditBurden).toHaveBeenCalledWith('t9', 'c9');
  });

  // a zeroed aggregate is NOT a not-found heuristic: a valid,
  // in-tenant consultation that simply has no recorded activity yet returns this
  // same shape and must surface as a normal 200, not a 404.
  it('returns a zeroed-but-valid edit-burden response as a normal 200 (no activity yet is not not-found)', async () => {
    const { controller, observabilityService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    observabilityService.getEditBurden.mockResolvedValue(EMPTY_BURDEN);

    await expect(controller.getEditBurden({ consultationId: 'c-no-activity' } as never)).resolves.toBe(EMPTY_BURDEN);
  });

  // Existence/tenancy is now the SERVICE's decision (it throws `DataNotFoundException`
  // for both an absent and a cross-tenant consultationId); the controller just lets
  // it propagate to the global `DataNotFoundExceptionFilter`, which maps it to 404.
  it('surfaces the service not-found exception as a 404 for an absent/cross-tenant consultationId', async () => {
    const { controller, observabilityService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    observabilityService.getEditBurden.mockRejectedValue(new DataNotFoundException('Consultation', 'c-missing'));

    await expect(controller.getEditBurden({ consultationId: 'c-missing' } as never)).rejects.toBeInstanceOf(DataNotFoundException);
  });

  it('carries the manage:HarnessPolicy permission metadata', () => {
    const proto = HarnessAdminController.prototype;
    expect(Reflect.getMetadata('required_permissions', proto.getEditBurden)).toEqual([{ action: 'manage', subject: 'HarnessPolicy' }]);
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

// Admin live console: monitoring (tenant-scoped) + kill-switch (super-admin).
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

  it('lets a super-admin target a tenant via ?tenantId', async () => {
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

describe('HarnessAdminController — live engine kill-switch (SUPER_ADMIN / global-scope)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getLiveConfig is forbidden for a tenant admin', async () => {
    const { controller, liveDocumentationService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.getLiveConfig()).rejects.toBeInstanceOf(ForbiddenException);
    expect(liveDocumentationService.getEngineConfig).not.toHaveBeenCalled();
  });

  it('getLiveConfig is allowed for a super-admin', async () => {
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

  it('updateLiveConfig toggles the kill-switch for a super-admin, carrying the actor + reason', async () => {
    const { controller, liveDocumentationService } = makeController({ user: { roles: ['SUPER_ADMIN'], id: 'admin-7' } as never });
    await controller.updateLiveConfig({ enabled: false, reason: 'incident' } as never);
    expect(liveDocumentationService.setEngineEnabled).toHaveBeenCalledWith(false, { userId: 'admin-7', reason: 'incident' });
  });
});

// Golden-set dataset surface (reads: read:HarnessEval,
// creates: manage:HarnessEval). Same tenant resolution as the other reads.
describe('HarnessAdminController — golden sets', () => {
  beforeEach(() => vi.clearAllMocks());

  it('listGoldenSets pins a tenant admin to their own tenant and forwards numeric paging', async () => {
    const { controller, evalService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await controller.listGoldenSets({ page: '2', limit: '5' });
    expect(evalService.listGoldenSets).toHaveBeenCalledWith('t1', { page: 2, limit: 5 });
  });

  it('listGoldenSets lets a super-admin target a tenant via ?tenantId', async () => {
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
    expect(evalService.addGoldenSet).toHaveBeenCalledWith({
      tenantId: 't1',
      name: 'GI set',
      description: 'gold',
      pinnedVersion: undefined,
      createdBy: 'user-9',
    });
  });

  it('createGoldenSet rejects a tenant admin targeting another tenant', async () => {
    const { controller, evalService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.createGoldenSet({ name: 'x' } as never, { tenantId: 't2' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(evalService.addGoldenSet).not.toHaveBeenCalled();
  });

  // Tail: GoldenSet.departmentId on the create lane — the body field
  // threads straight through to the service, which owns the department/tenant
  // validation (404-over-403; covered at the service-unit level).
  it('createGoldenSet threads an optional departmentId through to the service', async () => {
    const { controller, evalService } = makeController({ user: { roles: ['TENANT_ADMIN'], tenantId: 't1', id: 'user-9' } as never, tenantId: 't1' });
    await controller.createGoldenSet({ name: 'GI set', departmentId: 'dept-1' } as never, {});
    expect(evalService.addGoldenSet).toHaveBeenCalledWith({
      tenantId: 't1',
      name: 'GI set',
      description: undefined,
      pinnedVersion: undefined,
      departmentId: 'dept-1',
      createdBy: 'user-9',
    });
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

describe('HarnessAdminController — golden-set authorization metadata', () => {
  it('reads are pinned to read:HarnessEval, creates to manage:HarnessEval', () => {
    const proto = HarnessAdminController.prototype;
    expect(Reflect.getMetadata('required_permissions', proto.listGoldenSets)).toEqual([{ action: 'read', subject: 'HarnessEval' }]);
    expect(Reflect.getMetadata('required_permissions', proto.getGoldenSet)).toEqual([{ action: 'read', subject: 'HarnessEval' }]);
    expect(Reflect.getMetadata('required_permissions', proto.listGoldenCases)).toEqual([{ action: 'read', subject: 'HarnessEval' }]);
    expect(Reflect.getMetadata('required_permissions', proto.createGoldenSet)).toEqual([{ action: 'manage', subject: 'HarnessEval' }]);
    expect(Reflect.getMetadata('required_permissions', proto.createGoldenCase)).toEqual([{ action: 'manage', subject: 'HarnessEval' }]);
  });
});

/**
 * Eval regression-corpus export.
 *
 * The route is a thin pass-through by design; what must be locked here is the
 * TENANT resolution (a super admin may target a tenant, a tenant admin may
 * not) and the fact that the SME-gate marker survives to the wire.
 */
describe('HarnessAdminController — gate-edit corpus export', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exports for the caller tenant and passes the filters through', async () => {
    const { controller, gateEditMiningService } = makeController({ user: SUPER, tenantId: 'tenant-1' });

    await controller.exportGateEditExemplars({ departmentId: 'dept-1', qualitySignal: 'APPROVED_CLEAN', limit: 50 });

    expect(gateEditMiningService.exportCorpusCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', departmentId: 'dept-1', qualitySignal: 'APPROVED_CLEAN', limit: 50 }),
    );
  });

  it('surfaces the SME-review marker to the caller', async () => {
    const { controller } = makeController({ user: SUPER, tenantId: 'tenant-1' });

    const result = await controller.exportGateEditExemplars({});

    expect(result.reviewStatus).toBe('PENDING_SME_REVIEW');
  });

  it('rejects a tenant admin targeting another tenant via ?tenantId (and never reaches the store)', async () => {
    // House convention on this controller: a foreign ?tenantId= is a 403, not a
    // silent re-pin — see the sibling audit / edit-burden / golden-set specs.
    const { controller, gateEditMiningService } = makeController({ user: TENANT_ADMIN('tenant-1'), tenantId: 'tenant-1' });

    await expect(controller.exportGateEditExemplars({ tenantId: 'tenant-elsewhere' })).rejects.toThrow(ForbiddenException);
    expect(gateEditMiningService.exportCorpusCandidates).not.toHaveBeenCalled();
  });

  it('pins a tenant admin to their own tenant when no ?tenantId= is given', async () => {
    const { controller, gateEditMiningService } = makeController({ user: TENANT_ADMIN('tenant-1'), tenantId: 'tenant-1' });

    await controller.exportGateEditExemplars({});

    expect(gateEditMiningService.exportCorpusCandidates).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1' }));
  });

  it('defaults the limit rather than requesting an unbounded export', async () => {
    const { controller, gateEditMiningService } = makeController({ user: SUPER, tenantId: 'tenant-1' });

    await controller.exportGateEditExemplars({});

    const [args] = gateEditMiningService.exportCorpusCandidates.mock.calls[0];
    expect(typeof args.limit).toBe('number');
    expect(args.limit).toBeGreaterThan(0);
  });
});

/**
 * The curation WRITE half (F-24). Same tenancy posture as the export
 * beside it — a foreign `?tenantId=` is a 403 that never reaches the store —
 * plus the one property specific to a write: the verdict body reaches the
 * service verbatim, so an admin console cannot smuggle extra fields through.
 */
describe('HarnessAdminController — gate-edit exemplar curation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records the verdict for the caller tenant', async () => {
    const { controller, gateEditMiningService } = makeController({ user: SUPER, tenantId: 'tenant-1' });

    const result = await controller.curateGateEditExemplar('ex-1', { status: 'APPROVED' } as never, {});

    expect(gateEditMiningService.curateExemplar).toHaveBeenCalledWith({ id: 'ex-1', tenantId: 'tenant-1', status: 'APPROVED' });
    expect(result).toEqual(expect.objectContaining({ id: 'ex-1', curationStatus: 'APPROVED' }));
  });

  it("rejects a tenant admin curating another tenant's exemplar (and never reaches the store)", async () => {
    const { controller, gateEditMiningService } = makeController({ user: TENANT_ADMIN('tenant-1'), tenantId: 'tenant-1' });

    await expect(controller.curateGateEditExemplar('ex-1', { status: 'APPROVED' } as never, { tenantId: 'tenant-elsewhere' })).rejects.toThrow(
      ForbiddenException,
    );
    expect(gateEditMiningService.curateExemplar).not.toHaveBeenCalled();
  });

  it('pins a tenant admin to their own tenant', async () => {
    const { controller, gateEditMiningService } = makeController({ user: TENANT_ADMIN('tenant-1'), tenantId: 'tenant-1' });

    await controller.curateGateEditExemplar('ex-1', { status: 'REJECTED' } as never, {});

    expect(gateEditMiningService.curateExemplar).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1', status: 'REJECTED' }));
  });
});

/**
 * TASK-792 W3 + W4 — the two routes that close the feedback loop's tail.
 *
 * Both are thin: the service owns the rules (curation gate, fail-closed
 * redaction, tenant checks) and is unit-tested there. What the CONTROLLER must
 * get right is that it does not leak clinical text into a response, and that it
 * scopes to the resolved tenant rather than a caller-supplied one.
 */
describe('HarnessAdminController — gate-edit loop tail (TASK-792)', () => {
  it('promote-to-golden-set returns ids + provenance only, never note text', async () => {
    const { controller, goldenCasePromotionService } = makeController({ user: TENANT_ADMIN('tenant-1'), tenantId: 'tenant-1' });

    const result = await controller.promoteExemplarToGoldenSet('ex-1', { goldenSetId: 'gs-1' } as never, {});

    expect(goldenCasePromotionService.promoteExemplarToGoldenCase).toHaveBeenCalledWith(
      expect.objectContaining({ exemplarId: 'ex-1', goldenSetId: 'gs-1' }),
    );
    expect(result).toEqual({ goldenCaseId: 'gc-1', goldenSetId: 'gs-1', label: 'CLINICIAN_DERIVED_PENDING_SME:ex-1' });
    // No transcript / referenceNote / redacted* key may appear in the response.
    expect(Object.keys(result)).toEqual(['goldenCaseId', 'goldenSetId', 'label']);
  });

  it('fine-tuning export serialises the dataset to JSONL', async () => {
    const { controller, gateEditMiningService } = makeController({ user: TENANT_ADMIN('tenant-1'), tenantId: 'tenant-1' });
    gateEditMiningService.exportFineTuningDataset.mockResolvedValue({
      schemaVersion: 'hope.gate-edit.finetune.v1',
      tenantId: 'tenant-1',
      reviewStatus: 'SME_APPROVED',
      count: 1,
      records: [{ exemplarId: 'ex-1' }],
    });
    gateEditMiningService.toJsonl.mockReturnValue('{"exemplarId":"ex-1"}');

    const body = await controller.exportGateEditFineTuningDataset({});

    expect(gateEditMiningService.exportFineTuningDataset).toHaveBeenCalledWith(
      // An omitted limit must never become an unbounded read of clinical text.
      expect.objectContaining({ tenantId: 'tenant-1', limit: 100 }),
    );
    expect(body).toBe('{"exemplarId":"ex-1"}');
  });
});
