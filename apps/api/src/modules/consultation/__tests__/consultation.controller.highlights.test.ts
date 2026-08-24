/**
 * ConsultationController — Manual Highlight routes.
 *
 * Verifies the POST/GET/DELETE `:id/highlights` routes delegate to the
 * HighlightService behind the existing ownership/access guards.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConsultationController } from '../consultation.controller';

const DOCTOR_A = 'doctor-a-id';
const DOCTOR_B = 'doctor-b-id';
const TENANT_ID = 'tenant-1';
const CONSULTATION_OWN = 'consult-own';

function makeConsultation(overrides: Record<string, unknown> = {}) {
  return { id: CONSULTATION_OWN, doctorId: DOCTOR_A, patientId: 'patient-1', tenantId: TENANT_ID, ...overrides };
}

function buildController(overrides: { userId?: string | null; consultation?: unknown } = {}) {
  const { userId = DOCTOR_A, consultation = makeConsultation() } = overrides;

  const consultationService = { getById: vi.fn().mockResolvedValue(consultation), doctorHasPatientRelationship: vi.fn() };
  const highlightService = {
    createHighlight: vi.fn(),
    getHighlights: vi.fn(),
    deleteHighlight: vi.fn(),
  };
  const cls = {
    get: vi.fn((key: string) => {
      if (key === 'user') return userId ? { id: userId, tenantId: TENANT_ID } : null;
      if (key === 'tenantId') return TENANT_ID;
      return undefined;
    }),
  };
  const policyEngine = { can: vi.fn().mockReturnValue(false) };
  const empty = {} as never;

  const controller = new ConsultationController(
    consultationService as never, // consultationService
    empty, // contextService
    empty, // summaryService
    empty, // chainSummaryService
    empty, // consultationJobService
    empty, // noteGenerationService — TASK-732
    empty, // timelineService
    cls as never, // cls
    policyEngine as never, // policyEngine
    empty, // globalSettingRepository
    empty, // tagService
    empty, // liveDocumentationService
    highlightService as never, // highlightService
    empty, // harnessProgressService
    empty, // harnessAssuranceService
    empty, // harnessLiveAssistService
    empty, // redisSubscriber
    empty, // loopContextSignalService
  );

  return { controller, consultationService, highlightService };
}

describe('ConsultationController highlights routes', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('POST :id/highlights', () => {
    it('creates a highlight for the owning doctor', async () => {
      const { controller, highlightService } = buildController();
      const request = { targetKind: 'TRANSCRIPT', exact: 'chest pain', startOffset: 0, endOffset: 10 } as never;
      const created = { id: 'hl-1', consultationId: CONSULTATION_OWN };
      highlightService.createHighlight.mockResolvedValue(created);

      const res = await controller.createHighlight(CONSULTATION_OWN, request);

      expect(res).toBe(created);
      expect(highlightService.createHighlight).toHaveBeenCalledWith(CONSULTATION_OWN, request);
    });

    it('rejects a non-owning doctor with Forbidden', async () => {
      const { controller, highlightService } = buildController({ consultation: makeConsultation({ doctorId: DOCTOR_B }) });
      await expect(
        controller.createHighlight(CONSULTATION_OWN, { targetKind: 'TRANSCRIPT', exact: 'x', startOffset: 0, endOffset: 1 } as never),
      ).rejects.toThrow(ForbiddenException);
      expect(highlightService.createHighlight).not.toHaveBeenCalled();
    });
  });

  describe('GET :id/highlights', () => {
    it('returns highlights for an accessible consultation', async () => {
      const { controller, highlightService } = buildController();
      const list = [{ id: 'hl-1' }, { id: 'hl-2' }];
      highlightService.getHighlights.mockResolvedValue(list);

      const res = await controller.getHighlights(CONSULTATION_OWN);

      expect(res).toBe(list);
      expect(highlightService.getHighlights).toHaveBeenCalledWith(CONSULTATION_OWN);
    });
  });

  describe('DELETE :id/highlights/:highlightId', () => {
    it('deletes a highlight for the owning doctor and returns ok', async () => {
      const { controller, highlightService } = buildController();
      highlightService.deleteHighlight.mockResolvedValue(undefined);

      const res = await controller.deleteHighlight(CONSULTATION_OWN, 'hl-1');

      expect(res).toEqual({ ok: true });
      expect(highlightService.deleteHighlight).toHaveBeenCalledWith(CONSULTATION_OWN, 'hl-1');
    });

    it('throws NotFound when the consultation does not exist', async () => {
      const { controller, highlightService } = buildController({ consultation: null });
      await expect(controller.deleteHighlight('missing', 'hl-1')).rejects.toThrow(NotFoundException);
      expect(highlightService.deleteHighlight).not.toHaveBeenCalled();
    });
  });
});
