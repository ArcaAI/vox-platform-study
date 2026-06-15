/**
 * PipelinePolicyAdminController authz/scoping unit tests (TASK-356 Phase 5).
 *
 * The CASL `@Authorize` tuples + `If-Match`/`@RequiresIfMatch` decorators are
 * exercised by the guard/interceptor (and e2e). These specs cover the
 * controller's OWN logic: super-admin vs. tenant read scoping, the effective
 * cascade GET (+ trace), the editable row GET (scope parsing), and the
 * If-Match-over-body version precedence forwarded to the policy service. The
 * max-scope 400 lives in the service (unit-tested there); here we assert the
 * controller faithfully forwards the scope/scopeId and propagates the rejection.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PipelinePolicyScope } from '@arcaai/domains';
import { PipelinePolicyAdminController } from '../pipeline-policy-admin.controller';

type Ctx = { user?: { roles?: string[] | null; tenantId?: string } | null; tenantId?: string };

const SUPER: Ctx['user'] = { roles: ['SUPER_ADMIN'] };
const TENANT_ADMIN = (tenantId: string): Ctx['user'] => ({ roles: ['TENANT_ADMIN'], tenantId });

function makeController(ctx: Ctx) {
  const policyService = {
    getEffective: vi.fn(),
    getRow: vi.fn(),
    upsertRow: vi.fn(),
  };
  const cls = { get: vi.fn((key: string) => (ctx as Record<string, unknown>)[key]) };
  const controller = new PipelinePolicyAdminController(policyService as never, cls as never);
  return { controller, policyService };
}

describe('PipelinePolicyAdminController — effective cascade', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the effective cascade (+ trace) for the caller tenant', async () => {
    const { controller, policyService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    const resp = {
      tenantId: 't1',
      departmentId: null,
      doctorId: null,
      autoSummaryEnabled: true,
      autoNerEnabled: true,
      harnessEnabled: false,
      dnaStyleEnabled: false,
      trace: { harnessEnabled: 'system-default' },
    };
    policyService.getEffective.mockResolvedValue(resp);

    await expect(controller.getEffective({})).resolves.toBe(resp);
    expect(policyService.getEffective).toHaveBeenCalledWith({ tenantId: 't1', departmentId: undefined, doctorId: undefined });
  });

  it('forwards the departmentId + doctorId resolution context', async () => {
    const { controller, policyService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    policyService.getEffective.mockResolvedValue({});

    await controller.getEffective({ departmentId: 'd1', doctorId: 'doc1' });
    expect(policyService.getEffective).toHaveBeenCalledWith({ tenantId: 't1', departmentId: 'd1', doctorId: 'doc1' });
  });

  it('lets a super-admin target another tenant via ?tenantId=', async () => {
    const { controller, policyService } = makeController({ user: SUPER });
    policyService.getEffective.mockResolvedValue({});

    await controller.getEffective({ tenantId: 't9' });
    expect(policyService.getEffective).toHaveBeenCalledWith({ tenantId: 't9', departmentId: undefined, doctorId: undefined });
  });

  it('forbids a tenant admin from reading another tenant', async () => {
    const { controller, policyService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.getEffective({ tenantId: 't2' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(policyService.getEffective).not.toHaveBeenCalled();
  });

  it('throws BadRequest when there is no tenant context', async () => {
    const { controller, policyService } = makeController({ user: { roles: ['TENANT_ADMIN'] } });
    await expect(controller.getEffective({})).rejects.toBeInstanceOf(BadRequestException);
    expect(policyService.getEffective).not.toHaveBeenCalled();
  });
});

describe('PipelinePolicyAdminController — editable row GET', () => {
  beforeEach(() => vi.clearAllMocks());

  it('defaults to the TENANT-scope row when no scope is supplied', async () => {
    const { controller, policyService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    const row = { id: 'p1', tenantId: 't1', scope: PipelinePolicyScope.TENANT, version: 2 };
    policyService.getRow.mockResolvedValue(row);

    await expect(controller.getRow({})).resolves.toBe(row);
    expect(policyService.getRow).toHaveBeenCalledWith({ tenantId: 't1', scope: PipelinePolicyScope.TENANT, scopeId: undefined });
  });

  it('forwards an explicit DEPARTMENT scope + scopeId', async () => {
    const { controller, policyService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    policyService.getRow.mockResolvedValue({});

    await controller.getRow({ scope: 'DEPARTMENT', scopeId: 'd1' });
    expect(policyService.getRow).toHaveBeenCalledWith({ tenantId: 't1', scope: PipelinePolicyScope.DEPARTMENT, scopeId: 'd1' });
  });

  it('rejects an unknown scope with BadRequest', async () => {
    const { controller, policyService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.getRow({ scope: 'GALAXY' })).rejects.toBeInstanceOf(BadRequestException);
    expect(policyService.getRow).not.toHaveBeenCalled();
  });
});

describe('PipelinePolicyAdminController — row PUT (OCC + max-scope)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prefers the If-Match header version over the body expectedVersion', async () => {
    const { controller, policyService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    policyService.upsertRow.mockResolvedValue({ id: 'p1', version: 6 });
    const dto = { autoSummaryEnabled: false, expectedVersion: 2 } as never;

    await controller.updateRow({}, dto, 5);
    expect(policyService.upsertRow).toHaveBeenCalledWith({
      tenantId: 't1',
      scope: PipelinePolicyScope.TENANT,
      scopeId: undefined,
      dto,
      expectedVersion: 5,
    });
  });

  it('falls back to the body expectedVersion when no If-Match header is present', async () => {
    const { controller, policyService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    policyService.upsertRow.mockResolvedValue({});
    const dto = { autoNerEnabled: true, expectedVersion: 3 } as never;

    await controller.updateRow({}, dto, undefined);
    expect(policyService.upsertRow).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 3 }));
  });

  it('forwards a DEPARTMENT-scope override write', async () => {
    const { controller, policyService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    policyService.upsertRow.mockResolvedValue({});
    const dto = { harnessEnabled: true } as never;

    await controller.updateRow({ scope: 'DEPARTMENT', scopeId: 'd1' }, dto, 1);
    expect(policyService.upsertRow).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', scope: PipelinePolicyScope.DEPARTMENT, scopeId: 'd1', dto }),
    );
  });

  it('propagates the service max-scope rejection (e.g. harnessEnabled at DOCTOR → 400)', async () => {
    const { controller, policyService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    policyService.upsertRow.mockRejectedValue(new BadRequestException("'harnessEnabled' cannot be set at DOCTOR scope (max scope: DEPARTMENT)."));

    await expect(
      controller.updateRow({ scope: 'DOCTOR', scopeId: 'doc1' }, { harnessEnabled: true } as never, 1),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(policyService.upsertRow).toHaveBeenCalledWith(
      expect.objectContaining({ scope: PipelinePolicyScope.DOCTOR, scopeId: 'doc1' }),
    );
  });

  it('forbids a tenant admin from writing another tenant', async () => {
    const { controller, policyService } = makeController({ user: TENANT_ADMIN('t1'), tenantId: 't1' });
    await expect(controller.updateRow({ tenantId: 't2' }, {} as never, 1)).rejects.toBeInstanceOf(ForbiddenException);
    expect(policyService.upsertRow).not.toHaveBeenCalled();
  });
});
