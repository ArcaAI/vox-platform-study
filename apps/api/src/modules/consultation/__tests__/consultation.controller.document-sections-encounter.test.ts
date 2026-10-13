/**
 * The section list reads take an optional `?encounter=n`.
 *
 * Absent ⇒ the service answers the consultation's CURRENT encounter (the default lives in the
 * service, so the route passes nothing). Present ⇒ that encounter's sections. Not a positive
 * integer ⇒ 400 before the service is asked anything.
 */
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { ConsultationController } from '../consultation.controller';

function buildController() {
  const documentSectionService = {
    listSections: vi.fn().mockResolvedValue([]),
    listAllSections: vi.fn().mockResolvedValue([]),
  };
  const controller: ConsultationController = Object.create(ConsultationController.prototype);
  Object.assign(controller as unknown as Record<string, unknown>, {
    consultationService: { getById: vi.fn().mockResolvedValue({ id: 'consult-1', doctorId: 'doctor-1' }), doctorHasPatientRelationship: vi.fn() },
    documentSectionService,
    policyEngine: { can: vi.fn().mockReturnValue(false) },
    cls: {
      get: vi.fn((key: string) => {
        if (key === 'user') return { id: 'doctor-1' };
        if (key === 'tenantId') return 'tenant-1';
        if (key === 'userAbility') return { can: () => false };
        return undefined;
      }),
    },
    globalSettingRepository: { findAll: vi.fn().mockResolvedValue([]) },
    logger: { debug: vi.fn(), warn: vi.fn(), log: vi.fn(), error: vi.fn() },
  });
  return { controller, documentSectionService };
}

describe('GET :id/documents/sections?encounter=n', () => {
  it('passes an explicit encounter to the service', async () => {
    const { controller, documentSectionService } = buildController();
    await controller.listAllDocumentSections('consult-1', 2);
    expect(documentSectionService.listAllSections).toHaveBeenCalledWith('consult-1', 2);
  });

  it('passes no encounter when none is asked for — the service defaults to the current one', async () => {
    const { controller, documentSectionService } = buildController();
    await controller.listAllDocumentSections('consult-1');
    expect(documentSectionService.listAllSections).toHaveBeenCalledWith('consult-1');
  });

  it('refuses an encounter below 1 with 400', async () => {
    const { controller, documentSectionService } = buildController();
    await expect(controller.listAllDocumentSections('consult-1', 0)).rejects.toBeInstanceOf(BadRequestException);
    expect(documentSectionService.listAllSections).not.toHaveBeenCalled();
  });
});

describe('GET :id/documents/:documentKey/sections?encounter=n', () => {
  it('passes an explicit encounter to the service, and none when absent', async () => {
    const { controller, documentSectionService } = buildController();
    await controller.listDocumentSections('consult-1', 'soap_note', 1);
    await controller.listDocumentSections('consult-1', 'soap_note');
    expect(documentSectionService.listSections).toHaveBeenNthCalledWith(1, 'consult-1', 'soap_note', 1);
    expect(documentSectionService.listSections).toHaveBeenNthCalledWith(2, 'consult-1', 'soap_note');
  });

  it('refuses a negative encounter with 400', async () => {
    const { controller } = buildController();
    await expect(controller.listDocumentSections('consult-1', 'soap_note', -1)).rejects.toBeInstanceOf(BadRequestException);
  });
});
