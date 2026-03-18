import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConsultationDtoMapper } from '../consultation.dto.mapper';

function createMockConsultationEntity(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cons-001',
    patientId: 'PAT_001',
    doctorId: 'doc-001',
    tenantId: 'tenant-001',
    departmentId: 'dept-gen',
    appointmentDate: new Date('2026-02-15'),
    parentConsultationId: null,
    metadata: { status: 'OPEN' },
    createdAt: new Date('2026-02-15T10:00:00Z'),
    updatedAt: new Date('2026-02-15T10:00:00Z'),
    Doctor: null,
    Department: null,
    ContextItems: [],
    ...overrides,
  };
}

describe('ConsultationDtoMapper with relations', () => {
  describe('toResponse with Doctor relation', () => {
    it('should include doctor info when Doctor relation is present', () => {
      const entity = createMockConsultationEntity({
        Doctor: {
          id: 'doc-001',
          username: 'doctor',
          UserProfile: {
            firstName: 'John',
            lastName: 'Smith',
          },
        },
      });

      const response = ConsultationDtoMapper.toResponse(entity as any);

      expect(response.doctor).toBeDefined();
      expect(response.doctor!.id).toBe('doc-001');
      expect(response.doctor!.username).toBe('doctor');
      expect(response.doctor!.firstName).toBe('John');
      expect(response.doctor!.lastName).toBe('Smith');
    });

    it('should have undefined doctor when Doctor relation is null', () => {
      const entity = createMockConsultationEntity({ Doctor: null });

      const response = ConsultationDtoMapper.toResponse(entity as any);

      expect(response.doctor).toBeUndefined();
    });

    it('should handle Doctor without UserProfile', () => {
      const entity = createMockConsultationEntity({
        Doctor: {
          id: 'doc-001',
          username: 'doctor_no_profile',
        },
      });

      const response = ConsultationDtoMapper.toResponse(entity as any);

      expect(response.doctor).toBeDefined();
      expect(response.doctor!.username).toBe('doctor_no_profile');
      expect(response.doctor!.firstName).toBeUndefined();
      expect(response.doctor!.lastName).toBeUndefined();
    });
  });

  describe('toResponse with Department relation', () => {
    it('should include department info when Department relation is present', () => {
      const entity = createMockConsultationEntity({
        Department: {
          id: 'dept-gen',
          code: 'GEN',
          name: 'General Medicine',
        },
      });

      const response = ConsultationDtoMapper.toResponse(entity as any);

      expect(response.department).toBeDefined();
      expect(response.department!.id).toBe('dept-gen');
      expect(response.department!.code).toBe('GEN');
      expect(response.department!.name).toBe('General Medicine');
    });

    it('should have undefined department when Department relation is null', () => {
      const entity = createMockConsultationEntity({
        Department: null,
        departmentId: null,
      });

      const response = ConsultationDtoMapper.toResponse(entity as any);

      expect(response.department).toBeUndefined();
    });
  });

  describe('toResponse preserves all standard fields', () => {
    it('should map id, patientId, doctorId, appointmentDate, timestamps', () => {
      const entity = createMockConsultationEntity();

      const response = ConsultationDtoMapper.toResponse(entity as any);

      expect(response.id).toBe('cons-001');
      expect(response.patientId).toBe('PAT_001');
      expect(response.doctorId).toBe('doc-001');
      expect(response.appointmentDate).toBe('2026-02-15');
      expect(response.createdAt).toBe('2026-02-15T10:00:00.000Z');
      expect(response.updatedAt).toBe('2026-02-15T10:00:00.000Z');
    });

    it('should set isNew flag when specified', () => {
      const entity = createMockConsultationEntity();

      const responseNew = ConsultationDtoMapper.toResponse(entity as any, true);
      const responseExisting = ConsultationDtoMapper.toResponse(entity as any, false);

      expect(responseNew.isNew).toBe(true);
      expect(responseExisting.isNew).toBe(false);
    });
  });
});
