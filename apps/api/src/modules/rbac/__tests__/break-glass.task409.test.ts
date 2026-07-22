/**
 * Controller-layer contract for the break-glass flow.
 *
 * The heavy matrix lives in the applications-layer suites
 * (`policy.service.break-glass.task409.test.ts` /
 * `role.service.break-glass.task409.test.ts`) and the live E2E spec
 * (`apps/api/tests/e2e/task-409-break-glass.spec.ts`). These tests pin the
 * thin wiring the controllers own:
 *   • DELETE handlers forward the body credentials to the service verbatim;
 *   • update/patch forward `dto.breakGlass` and NEVER forward `isProtected`
 *     (server-side strip — the response marker cannot round-trip into a
 *     mutation);
 *   • `toResponse` surfaces `isProtected` (default false when absent).
 */
import { describe, it, expect, vi } from 'vitest';
import { PoliciesController } from '../policies.controller';
import { RolesController } from '../roles.controller';

const POLICY_ROW = {
  id: 'p-1',
  name: 'team-policy',
  description: null,
  scope: 'TENANT',
  rules: [],
  resourceStatus: 'ENABLED',
  isProtected: false,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

function makePoliciesController() {
  const service = {
    validateRules: vi.fn(),
    findAll: vi.fn(),
    findOne: vi.fn(),
    create: vi.fn().mockResolvedValue(POLICY_ROW),
    update: vi.fn().mockResolvedValue(POLICY_ROW),
    patch: vi.fn().mockResolvedValue(POLICY_ROW),
    softDelete: vi.fn().mockResolvedValue({ id: 'p-1', name: 'team-policy' }),
  };
  return { controller: new PoliciesController(service as never), service };
}

function makeRolesController() {
  const service = {
    findAll: vi.fn(),
    findOne: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    patch: vi.fn(),
    softDelete: vi.fn().mockResolvedValue({ id: 'r-1', name: 'Care Team' }),
    assignPolicy: vi.fn(),
    removePolicy: vi.fn().mockResolvedValue(undefined),
  };
  return { controller: new RolesController(service as never), service };
}

describe('PoliciesController break-glass wiring', () => {
  it('DELETE forwards the body credentials to softDelete', async () => {
    const { controller, service } = makePoliciesController();
    const creds = { password: 'pw', confirmationName: 'team-policy' };
    await controller.remove('p-1', creds);
    expect(service.softDelete).toHaveBeenCalledWith('p-1', creds);
  });

  it('DELETE without a body forwards undefined (service maps to 428)', async () => {
    const { controller, service } = makePoliciesController();
    await controller.remove('p-1', undefined);
    expect(service.softDelete).toHaveBeenCalledWith('p-1', undefined);
  });

  it('PATCH forwards breakGlass and strips isProtected from the service request', async () => {
    const { controller, service } = makePoliciesController();
    const creds = { password: 'pw', confirmationName: 'team-policy' };
    await controller.patch('p-1', { rules: [], breakGlass: creds, isProtected: false } as never);
    const request = service.patch.mock.calls[0][1] as Record<string, unknown>;
    expect(request.breakGlass).toEqual(creds);
    expect('isProtected' in request).toBe(false);
  });

  it('PUT forwards breakGlass and strips isProtected from the service request', async () => {
    const { controller, service } = makePoliciesController();
    await controller.update('p-1', { name: 'x', isProtected: true } as never);
    const request = service.update.mock.calls[0][1] as Record<string, unknown>;
    expect('isProtected' in request).toBe(false);
  });

  it('toResponse surfaces isProtected (and defaults to false when absent)', async () => {
    const { controller, service } = makePoliciesController();
    service.findOne.mockResolvedValue({ ...POLICY_ROW, isProtected: true });
    const protectedResponse = await controller.findOne('p-1');
    expect(protectedResponse.isProtected).toBe(true);

    service.findOne.mockResolvedValue({ ...POLICY_ROW, isProtected: undefined });
    const legacyResponse = await controller.findOne('p-1');
    expect(legacyResponse.isProtected).toBe(false);
  });
});

describe('RolesController break-glass wiring', () => {
  it('DELETE role forwards the body credentials to softDelete', async () => {
    const { controller, service } = makeRolesController();
    const creds = { password: 'pw', confirmationName: 'Care Team' };
    await controller.remove('r-1', creds);
    expect(service.softDelete).toHaveBeenCalledWith('r-1', creds);
  });

  it('DELETE role/policy detach forwards the body credentials to removePolicy', async () => {
    const { controller, service } = makeRolesController();
    const creds = { password: 'pw', confirmationName: 'team-policy' };
    await controller.removePolicy('r-1', 'p-1', creds);
    expect(service.removePolicy).toHaveBeenCalledWith('r-1', 'p-1', creds);
  });
});
