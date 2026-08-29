/**
 * TASK-813 — `GET /consultations/:id/workflow`, the discovery route.
 *
 * The controller holds no business logic here, so what is worth pinning is the
 * ACCESS ORDER: `verifyConsultationAccess` runs BEFORE the service is asked
 * anything. That check is what makes an unknown or cross-tenant id a 404 rather
 * than a disclosure, and it is the same helper `getById` uses — calling the
 * service first and filtering afterwards would answer for rows the caller may
 * not see.
 */
import { describe, it, expect, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { API_KEY_REQUIRED_SCOPES, REQUIRED_PERMISSIONS_KEY, SERVICE_ACCOUNT_REQUIRED_SCOPES } from '@arcaai/applications';
import { ConsultationController } from '../consultation.controller';

const GOVERNED = {
  consultationId: 'consult-1',
  governed: true,
  workflowDefinitionSlug: 'caller_picked_v1',
  workflowRunId: 'run-1',
  decidedAt: '2026-08-29T00:00:00.000Z',
  name: 'Caller Picked',
  description: null,
  paletteKey: 'consultation',
  activeVersionNumber: 3,
  inputSchema: null,
};

function buildController(overrides: { doctorId?: string; consultation?: unknown } = {}) {
  const consultationService = {
    getById: vi.fn().mockResolvedValue(overrides.consultation === undefined ? { id: 'consult-1', doctorId: overrides.doctorId ?? 'doctor-1' } : overrides.consultation),
    getGoverningWorkflow: vi.fn().mockResolvedValue(GOVERNED),
  };
  const policyEngine = { can: vi.fn().mockReturnValue(false) };
  const cls = { get: vi.fn((key: string) => (key === 'user' ? { id: 'doctor-1' } : key === 'tenantId' ? 'tenant-1' : undefined)) };

  // Sharing is the LAST layer of `verifyConsultationAccess` and is default-CLOSED; an empty
  // settings table is what a tenant that never enabled it actually has.
  const globalSettingRepository = { findAll: vi.fn().mockResolvedValue([]) };
  const logger = { debug: vi.fn(), warn: vi.fn(), log: vi.fn(), error: vi.fn() };

  const controller: ConsultationController = Object.create(ConsultationController.prototype);
  Object.assign(controller as unknown as Record<string, unknown>, { consultationService, policyEngine, cls, globalSettingRepository, logger });
  return { controller, consultationService };
}

describe('ConsultationController.getGoverningWorkflow', () => {
  it('returns the governing workflow for a consultation the caller owns', async () => {
    const { controller } = buildController();
    await expect(controller.getGoverningWorkflow('consult-1')).resolves.toEqual(GOVERNED);
  });

  it('verifies access BEFORE asking the service — an unknown id never reaches the read', async () => {
    const { controller, consultationService } = buildController({ consultation: null });

    await expect(controller.getGoverningWorkflow('nope')).rejects.toBeInstanceOf(NotFoundException);
    expect(consultationService.getGoverningWorkflow).not.toHaveBeenCalled();
  });

  it('refuses a consultation belonging to another doctor with no read ability, and reads nothing', async () => {
    const { controller, consultationService } = buildController({ doctorId: 'someone-else' });

    await expect(controller.getGoverningWorkflow('consult-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(consultationService.getGoverningWorkflow).not.toHaveBeenCalled();
  });
});

/**
 * TASK-813 §8 — `GET /consultations/workflows`, the SELECTABLE-set route.
 *
 * Two things here are not covered by the generated route-level authz sweep
 * (`task-776-route-authz-matrix.spec.ts`), and both fail SILENTLY if they regress, so they are
 * hand-written depth rather than matrix breadth:
 *
 *   1. **The class-level bare `@Authorize()` must stay overridden.** Deleting this route's
 *      method-level `@Authorize(['create','Consultation'])` leaves a perfectly valid
 *      declaration behind — the class default — under which ANY authenticated tenant user may
 *      enumerate the tenant's authored workflows. The manifest would simply change from
 *      `[["create","Consultation"]]` to `[]`, and a conformance matrix reading the manifest as
 *      its own oracle accepts both. Nest does not copy class-level decorators onto method refs
 *      (rule 05 §Metadata trap), so reading the METHOD ref is what distinguishes them.
 *   2. **Declaration order.** `/consultations/workflows` is a single static segment competing
 *      with `getById`'s `:id`; Express matches in registration order and Nest registers in
 *      method-definition order, so moving this method below `getById` turns the route into a
 *      404 with nothing else changing.
 */
describe('ConsultationController.listSelectableWorkflows', () => {
  it('delegates to the service — the tenant comes from the session, so the route takes no argument', async () => {
    const { controller } = buildController();
    const selectable = { data: [{ slug: 'clinic_intake_v1', name: 'Clinic Intake', description: null, isTenantDefault: true }] };
    const consultationService = (controller as unknown as { consultationService: Record<string, unknown> }).consultationService;
    consultationService.listSelectableWorkflows = vi.fn().mockResolvedValue(selectable);

    await expect(controller.listSelectableWorkflows()).resolves.toEqual(selectable);
    expect(consultationService.listSelectableWorkflows).toHaveBeenCalledWith();
  });

  it('declares create:Consultation ON THE METHOD — never inheriting the class-level bare @Authorize()', () => {
    const required = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, ConsultationController.prototype.listSelectableWorkflows);

    // The ability that gates `open`. Anything else here — most of all an empty array, which is
    // what the class default reads as — widens enumeration beyond the callers who can act on it.
    expect(required).toEqual([{ action: 'create', subject: 'Consultation' }]);
  });

  it('declares the scope `open` carries, so the reachable set is exactly the set that can select', () => {
    const scopes = Reflect.getMetadata(API_KEY_REQUIRED_SCOPES, ConsultationController.prototype.listSelectableWorkflows);
    expect(scopes).toEqual(['consultation:session:write']);
  });

  it('refuses service accounts by declaring no svc scope — deny-by-default, exactly as `open` does', () => {
    const svcScopes = Reflect.getMetadata(SERVICE_ACCOUNT_REQUIRED_SCOPES, ConsultationController.prototype.listSelectableWorkflows);
    expect(svcScopes).toBeUndefined();
  });

  it('is registered BEFORE the :id route, or Express reads `workflows` as a consultation id', () => {
    const methods = Object.getOwnPropertyNames(ConsultationController.prototype);
    expect(methods.indexOf('listSelectableWorkflows')).toBeGreaterThan(-1);
    expect(methods.indexOf('listSelectableWorkflows')).toBeLessThan(methods.indexOf('getById'));
  });

  it('is mounted at the static path `workflows`', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ConsultationController.prototype.listSelectableWorkflows)).toBe('workflows');
  });
});
