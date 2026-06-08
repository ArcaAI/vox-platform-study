/**
 * ConsultationService — recording lifecycle (Clinical Workflow Playground WS2)
 *
 * Verifies startRecording/stopRecording write the typed `status` COLUMN
 * (RECORDING on start, OPEN on stop), persist, broadcast ResourceUpdated, and
 * surface the column value via ConsultationResponse.status.
 */
import { ConsultationStatus, SysEventType } from '@arcaai/domains';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsultationService } from '../consultation.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockConsultationRepository = {
  findWithRelations: vi.fn(),
  update: vi.fn(),
};
const mockDepartmentRepository = {};
const mockUserRoleAssignmentRepository = {};
const mockUserDepartmentRepository = {};
const mockUserRepository = {};

function makeEntity(overrides: Partial<{ id: string; tenantId: string; status: string }> = {}) {
  return {
    id: overrides.id ?? 'c-1',
    tenantId: overrides.tenantId ?? 'tenant-1',
    patientId: 'patient-1',
    doctorId: 'doctor-1',
    appointmentDate: new Date('2026-06-08'),
    departmentId: null,
    parentConsultationId: null,
    metadata: null,
    status: overrides.status,
    createdAt: new Date('2026-06-08T00:00:00Z'),
    updatedAt: new Date('2026-06-08T00:00:00Z'),
    ContextItems: [],
  } as any;
}

describe('ConsultationService — recording lifecycle (WS2)', () => {
  let service: ConsultationService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => {
      if (key === 'user') return { id: 'doctor-1' };
      if (key === 'tenantId') return 'tenant-1';
      return null;
    });
    service = new ConsultationService(
      mockConsultationRepository as any,
      mockDepartmentRepository as any,
      mockUserRoleAssignmentRepository as any,
      mockUserDepartmentRepository as any,
      mockUserRepository as any,
      mockEventEmitter as any,
      mockClsService as any,
    );
  });

  it('startRecording sets status=RECORDING, persists, emits ResourceUpdated', async () => {
    const entity = makeEntity();
    mockConsultationRepository.findWithRelations.mockResolvedValue(entity);
    mockConsultationRepository.update.mockResolvedValue(entity);

    const result = await service.startRecording('c-1');

    expect(result.status).toBe(ConsultationStatus.RECORDING);
    expect(entity.status).toBe(ConsultationStatus.RECORDING);
    expect(mockConsultationRepository.update).toHaveBeenCalledTimes(1);
    expect(mockEventEmitter.emit).toHaveBeenCalledWith(
      SysEventType.ResourceUpdated,
      expect.objectContaining({ resourceId: 'c-1', data: expect.objectContaining({ action: 'startRecording', status: ConsultationStatus.RECORDING }) }),
    );
  });

  it('stopRecording reverts status=OPEN, persists, emits ResourceUpdated', async () => {
    const entity = makeEntity({ status: ConsultationStatus.RECORDING });
    mockConsultationRepository.findWithRelations.mockResolvedValue(entity);
    mockConsultationRepository.update.mockResolvedValue(entity);

    const result = await service.stopRecording('c-1');

    expect(result.status).toBe(ConsultationStatus.OPEN);
    expect(entity.status).toBe(ConsultationStatus.OPEN);
    expect(mockEventEmitter.emit).toHaveBeenCalledWith(
      SysEventType.ResourceUpdated,
      expect.objectContaining({ data: expect.objectContaining({ action: 'stopRecording', status: ConsultationStatus.OPEN }) }),
    );
  });

  it('throws NotFoundException when consultation is missing', async () => {
    mockConsultationRepository.findWithRelations.mockResolvedValue(null);
    await expect(service.startRecording('missing')).rejects.toThrow(NotFoundException);
    expect(mockConsultationRepository.update).not.toHaveBeenCalled();
  });

  it('throws NotFoundException (generic) for a cross-tenant consultation', async () => {
    mockConsultationRepository.findWithRelations.mockResolvedValue(makeEntity({ tenantId: 'tenant-OTHER' }));
    await expect(service.startRecording('c-1')).rejects.toThrow(NotFoundException);
    expect(mockConsultationRepository.update).not.toHaveBeenCalled();
  });

  it('throws BadRequestException when tenantId is missing', async () => {
    mockClsService.get.mockImplementation((key: string) => (key === 'user' ? { id: 'doctor-1' } : null));
    await expect(service.startRecording('c-1')).rejects.toThrow(BadRequestException);
  });
});
