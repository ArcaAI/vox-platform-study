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
