/**
 * HighlightService Unit Tests (TASK-344 Workstream B)
 *
 * Covers create (tenant guard + ResourceCreated event), list (tenant-scoped),
 * and delete (soft-delete + ResourceDeleted). Cross-tenant / cross-consultation
 * / missing inputs surface as NotFound (no existence leak) or BadRequest.
 */

import { HighlightFactory, HighlightTargetKind, ResourceType, SysEventType } from '@arcaai/domains';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HighlightService } from '../highlight.service';

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';
const CONSULTATION = 'consultation-1';

const mockClsService = {
  get: vi.fn(),
  set: vi.fn(),
};

const mockEventEmitter = {
  emit: vi.fn(),
};

const mockHighlightRepository = {
  create: vi.fn(),
  findById: vi.fn(),
  findByConsultation: vi.fn(),
  softDelete: vi.fn(),
};

const mockConsultationRepository = {
  findById: vi.fn(),
};

function buildService(): HighlightService {
  return new HighlightService(
    mockHighlightRepository as never,
    mockConsultationRepository as never,
    mockEventEmitter as never,
    mockClsService as never,
  );
}

function makeHighlight(overrides: { consultationId?: string; tenantId?: string } = {}) {
  return HighlightFactory.CreateHighlight({
    tenantId: overrides.tenantId ?? TENANT,
    consultationId: overrides.consultationId ?? CONSULTATION,
    targetKind: HighlightTargetKind.TRANSCRIPT,
    exact: 'severe chest pain',
    startOffset: 10,
    endOffset: 27,
  });
}

const validRequest = {
  targetKind: HighlightTargetKind.TRANSCRIPT,
  exact: 'severe chest pain',
  startOffset: 10,
  endOffset: 27,
  color: '#ffcc00',
};

describe('HighlightService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => {
      if (key === 'tenantId') return TENANT;
      if (key === 'user') return { id: 'user-1' };
      return undefined;
    });
  });

  describe('createHighlight', () => {
    it('creates a highlight scoped to the consultation tenant and broadcasts ResourceCreated', async () => {
      mockConsultationRepository.findById.mockResolvedValue({ id: CONSULTATION, tenantId: TENANT });
      mockHighlightRepository.create.mockImplementation((e) => Promise.resolve(e));

      const service = buildService();
      const res = await service.createHighlight(CONSULTATION, validRequest);

      expect(res.consultationId).toBe(CONSULTATION);
      expect(res.exact).toBe('severe chest pain');
      expect(res.targetKind).toBe(HighlightTargetKind.TRANSCRIPT);
      expect(res.startOffset).toBe(10);
      expect(res.endOffset).toBe(27);
      expect(res.color).toBe('#ffcc00');
      expect(mockHighlightRepository.create).toHaveBeenCalledTimes(1);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceCreated,
        expect.objectContaining({ resourceId: res.id, resourceType: ResourceType.Highlight }),
      );
    });

    it('throws NotFound when the consultation belongs to another tenant', async () => {
      mockConsultationRepository.findById.mockResolvedValue({ id: CONSULTATION, tenantId: OTHER_TENANT });
      const service = buildService();
      await expect(service.createHighlight(CONSULTATION, validRequest)).rejects.toThrow(NotFoundException);
      expect(mockHighlightRepository.create).not.toHaveBeenCalled();
    });

    it('throws BadRequest when there is no tenant context', async () => {
      mockClsService.get.mockReturnValue(undefined);
      const service = buildService();
      await expect(service.createHighlight(CONSULTATION, validRequest)).rejects.toThrow(BadRequestException);
    });
  });

  describe('getHighlights', () => {
    it('returns the tenant-scoped highlights for a consultation', async () => {
      mockConsultationRepository.findById.mockResolvedValue({ id: CONSULTATION, tenantId: TENANT });
      mockHighlightRepository.findByConsultation.mockResolvedValue([makeHighlight(), makeHighlight()]);

      const service = buildService();
      const res = await service.getHighlights(CONSULTATION);

      expect(res).toHaveLength(2);
      expect(mockHighlightRepository.findByConsultation).toHaveBeenCalledWith(CONSULTATION);
    });

    it('throws NotFound when the consultation belongs to another tenant', async () => {
      mockConsultationRepository.findById.mockResolvedValue({ id: CONSULTATION, tenantId: OTHER_TENANT });
      const service = buildService();
      await expect(service.getHighlights(CONSULTATION)).rejects.toThrow(NotFoundException);
      expect(mockHighlightRepository.findByConsultation).not.toHaveBeenCalled();
    });
  });

  describe('deleteHighlight', () => {
    it('soft-deletes the highlight and broadcasts ResourceDeleted', async () => {
      mockHighlightRepository.findById.mockResolvedValue(makeHighlight());
      mockHighlightRepository.softDelete.mockResolvedValue(makeHighlight());

      const service = buildService();
      await service.deleteHighlight(CONSULTATION, 'hl-1');

      expect(mockHighlightRepository.softDelete).toHaveBeenCalledWith('hl-1', 'user-1');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceDeleted,
        expect.objectContaining({ resourceId: 'hl-1', resourceType: ResourceType.Highlight }),
      );
    });

    it('throws NotFound when the highlight is anchored to a different consultation', async () => {
      mockHighlightRepository.findById.mockResolvedValue(makeHighlight({ consultationId: 'other-consultation' }));
      const service = buildService();
      await expect(service.deleteHighlight(CONSULTATION, 'hl-1')).rejects.toThrow(NotFoundException);
      expect(mockHighlightRepository.softDelete).not.toHaveBeenCalled();
    });

    it('throws NotFound when the highlight belongs to another tenant', async () => {
      mockHighlightRepository.findById.mockResolvedValue(makeHighlight({ tenantId: OTHER_TENANT }));
      const service = buildService();
      await expect(service.deleteHighlight(CONSULTATION, 'hl-1')).rejects.toThrow(NotFoundException);
      expect(mockHighlightRepository.softDelete).not.toHaveBeenCalled();
    });
  });
});
