/**
 * ConsultationService Unit Tests
 *
 * Tests for the ConsultationService that handles consultation lifecycle operations.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConsultationService } from '../consultation.service';
import { ConsultationDtoMapper } from '../consultation.dto.mapper';
import { SysEventType, ResourceStatusType, ConsultationStatus } from '@arcaai/domains';

// Mock ClsService
const mockClsService = {
  get: vi.fn(),
  set: vi.fn(),
};

// Mock EventEmitter
const mockEventEmitter = {
  emit: vi.fn(),
};

// Mock ConsultationRepository
const mockConsultationRepository = {
  findByUniqueKey: vi.fn(),
  findById: vi.fn(),
  findWithContext: vi.fn(),
  findWithRelations: vi.fn(),
  findAll: vi.fn(),
  findPaginatedWithRelations: vi.fn(),
  findByPatientAndDate: vi.fn(),
  findConsultationChain: vi.fn(),
  findPaginatedWithSharedAccess: vi.fn(),
  countWithSharedAccess: vi.fn(),
  findDistinctPatientIds: vi.fn(),
  findCreatedInRange: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};

// DepartmentRepository for cross-aggregate tenant check
const mockDepartmentRepository = {
  findById: vi.fn(),
};

// UserRoleAssignmentRepository for doctor-in-tenant check
const mockUserRoleAssignmentRepository = {
  findFirst: vi.fn(),
};

// Membership guard now also reads the UserDepartment join
// table and the User table (service-account exemption).
const mockUserDepartmentRepository = {
  findFirst: vi.fn(),
};

const mockUserRepository = {
  findFirst: vi.fn(),
};

// Helper to create mock consultation entity
const createMockConsultationEntity = (
  overrides: Partial<{
    id: string;
    tenantId: string;
    patientId: string;
    doctorId: string;
    appointmentDate: Date;
    departmentId: string | null;
    parentConsultationId: string | null;
    metadata: Record<string, unknown> | null;
    createdAt: Date;
    updatedAt: Date;
    Doctor: any;
    Department: any;
    ContextItems: any[];
  }> = {},
) => ({
  id: overrides.id ?? 'consultation-id-1',
  tenantId: overrides.tenantId ?? 'tenant-1',
  patientId: overrides.patientId ?? 'patient-1',
  doctorId: overrides.doctorId ?? 'doctor-1',
  appointmentDate: overrides.appointmentDate ?? new Date('2026-01-29'),
  departmentId: overrides.departmentId ?? null,
  parentConsultationId: overrides.parentConsultationId ?? null,
  metadata: overrides.metadata ?? null,
  createdAt: overrides.createdAt ?? new Date('2026-01-29T10:00:00Z'),
  updatedAt: overrides.updatedAt ?? new Date('2026-01-29T10:00:00Z'),
  Doctor: overrides.Doctor ?? undefined,
  Department: overrides.Department ?? undefined,
  ContextItems: overrides.ContextItems ?? [],
});

// Mock ConsultationFactory
vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    ConsultationFactory: {
      CreateNewVisit: vi.fn((data) => ({
        ...data,
        id: 'new-consultation-id',
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
      CreateRevisit: vi.fn((data) => ({
        ...data,
        id: 'new-revisit-id',
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    },
  };
});

describe('ConsultationService', () => {
  let service: ConsultationService;

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: return valid user and tenant from CLS
    mockClsService.get.mockImplementation((key: string) => {
      switch (key) {
        case 'user':
          return { id: 'user-id-1' };
        case 'tenantId':
          return 'tenant-1';
        case 'correlationId':
          return 'corr-123';
        case 'requestIp':
          return '192.168.1.1';
        default:
          return null;
      }
    });

    // Default: findWithRelations returns null (callers override as needed)
    mockConsultationRepository.findWithRelations.mockResolvedValue(null);

    // Defaults that pass the tenant guard checks. Cross-tenant
    // negative tests override these per-test.
    mockUserRoleAssignmentRepository.findFirst.mockResolvedValue({
      id: 'ura-1',
      userId: 'doctor-1',
      tenantId: 'tenant-1',
      resourceStatus: ResourceStatusType.ENABLED,
    });
    // Default to a present in-tenant department so the
    // role+department membership guard passes for the happy path. Negative
    // tests override the role repo to null (short-circuits before this).
    mockUserDepartmentRepository.findFirst.mockResolvedValue({
      id: 'ud-1',
      userId: 'doctor-1',
      tenantId: 'tenant-1',
      resourceStatus: ResourceStatusType.ENABLED,
    });
    mockUserRepository.findFirst.mockResolvedValue({ id: 'doctor-1', isServiceAccount: false });
    mockDepartmentRepository.findById.mockResolvedValue({
      id: 'dept-1',
      tenantId: 'tenant-1',
    });
    mockConsultationRepository.findCreatedInRange.mockResolvedValue([]);

    // Create service instance with mocks
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

  describe('getOrCreate', () => {
    it('should throw BadRequestException when tenant ID is not available', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return null;
        if (key === 'user') return { id: 'user-id-1' };
        return null;
      });

      await expect(service.getOrCreate({ patientId: 'patient-1' }, 'doctor-1')).rejects.toThrow(BadRequestException);
      await expect(service.getOrCreate({ patientId: 'patient-1' }, 'doctor-1')).rejects.toThrow('Tenant ID is required');
    });

    it('should return existing consultation when found', async () => {
      const existingConsultation = createMockConsultationEntity();
      mockConsultationRepository.findByUniqueKey.mockResolvedValue(existingConsultation);

      const result = await service.getOrCreate({ patientId: 'patient-1' }, 'doctor-1');

      expect(result.id).toBe('consultation-id-1');
      expect(result.isNew).toBe(false);
      expect(mockConsultationRepository.findByUniqueKey).toHaveBeenCalledWith('tenant-1', 'patient-1', expect.any(Date), 'doctor-1');
      expect(mockConsultationRepository.create).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceViewed,
        expect.objectContaining({
          resourceId: 'consultation-id-1',
          data: { action: 'getOrCreate', found: true },
        }),
      );
    });

    it('should create new consultation when not found', async () => {
      mockConsultationRepository.findByUniqueKey.mockResolvedValue(null);
      const newConsultation = createMockConsultationEntity({ id: 'new-consultation-id' });
      mockConsultationRepository.create.mockResolvedValue(newConsultation);

      const result = await service.getOrCreate({ patientId: 'patient-1' }, 'doctor-1');

      expect(result.id).toBe('new-consultation-id');
      expect(result.isNew).toBe(true);
      expect(mockConsultationRepository.create).toHaveBeenCalled();
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceCreated,
        expect.objectContaining({
          resourceId: 'new-consultation-id',
          data: { action: 'getOrCreate', created: true },
        }),
      );
    });

    it('should use provided appointment date', async () => {
      mockConsultationRepository.findByUniqueKey.mockResolvedValue(null);
      const newConsultation = createMockConsultationEntity();
      mockConsultationRepository.create.mockResolvedValue(newConsultation);

      await service.getOrCreate({ patientId: 'patient-1', appointmentDate: '2026-02-15' }, 'doctor-1');

      expect(mockConsultationRepository.findByUniqueKey).toHaveBeenCalledWith('tenant-1', 'patient-1', new Date('2026-02-15'), 'doctor-1');
    });

    it('should use today date when appointment date not provided', async () => {
      mockConsultationRepository.findByUniqueKey.mockResolvedValue(null);
      const newConsultation = createMockConsultationEntity();
      mockConsultationRepository.create.mockResolvedValue(newConsultation);

      await service.getOrCreate({ patientId: 'patient-1' }, 'doctor-1');

      // Should use today's date (date part only, no time)
      const today = new Date(new Date().toISOString().split('T')[0]);
      expect(mockConsultationRepository.findByUniqueKey).toHaveBeenCalledWith('tenant-1', 'patient-1', today, 'doctor-1');
    });

    it('should set parentConsultationId when provided', async () => {
      mockConsultationRepository.findByUniqueKey.mockResolvedValue(null);
      // Parent must be resolvable and live in caller's tenant.
      mockConsultationRepository.findById.mockResolvedValue(createMockConsultationEntity({ id: 'parent-consultation-id' }));
      const newConsultation = createMockConsultationEntity({
        parentConsultationId: 'parent-consultation-id',
      });
      mockConsultationRepository.create.mockResolvedValue(newConsultation);

      await service.getOrCreate({ patientId: 'patient-1', parentConsultationId: 'parent-consultation-id' }, 'doctor-1');

      expect(mockConsultationRepository.create).toHaveBeenCalled();
    });

    it('should include departmentId and metadata when provided', async () => {
      mockConsultationRepository.findByUniqueKey.mockResolvedValue(null);
      const newConsultation = createMockConsultationEntity({
        departmentId: 'dept-1',
        metadata: { visitType: 'follow-up' },
      });
      mockConsultationRepository.create.mockResolvedValue(newConsultation);

      await service.getOrCreate(
        {
          patientId: 'patient-1',
          departmentId: 'dept-1',
          metadata: { visitType: 'follow-up' },
        },
        'doctor-1',
      );

      expect(mockConsultationRepository.create).toHaveBeenCalled();
    });

    it('should handle invalid date format gracefully', async () => {
      mockConsultationRepository.findByUniqueKey.mockResolvedValue(null);
      const newConsultation = createMockConsultationEntity();
      mockConsultationRepository.create.mockResolvedValue(newConsultation);

      // Invalid date should still work (JS Date will handle it)
      await service.getOrCreate({ patientId: 'patient-1', appointmentDate: 'invalid-date' }, 'doctor-1');

      expect(mockConsultationRepository.findByUniqueKey).toHaveBeenCalled();
    });

    it('should handle complex metadata objects', async () => {
      mockConsultationRepository.findByUniqueKey.mockResolvedValue(null);
      const complexMetadata = {
        visitType: 'follow-up',
        priority: 'high',
        referral: {
          from: 'Dr. Smith',
          reason: 'Second opinion',
        },
        tags: ['urgent', 'specialist'],
      };
      const newConsultation = createMockConsultationEntity({
        metadata: complexMetadata,
      });
      mockConsultationRepository.create.mockResolvedValue(newConsultation);

      await service.getOrCreate(
        {
          patientId: 'patient-1',
          metadata: complexMetadata,
        },
        'doctor-1',
      );

      expect(mockConsultationRepository.create).toHaveBeenCalled();
    });

    it('should handle empty string patientId', async () => {
      mockConsultationRepository.findByUniqueKey.mockResolvedValue(null);
      const newConsultation = createMockConsultationEntity({ patientId: '' });
      mockConsultationRepository.create.mockResolvedValue(newConsultation);

      await service.getOrCreate({ patientId: '' }, 'doctor-1');

      expect(mockConsultationRepository.findByUniqueKey).toHaveBeenCalledWith('tenant-1', '', expect.any(Date), 'doctor-1');
    });

    it('should handle special characters in patientId', async () => {
      mockConsultationRepository.findByUniqueKey.mockResolvedValue(null);
      const newConsultation = createMockConsultationEntity({ patientId: 'patient-123-äöü' });
      mockConsultationRepository.create.mockResolvedValue(newConsultation);

      await service.getOrCreate({ patientId: 'patient-123-äöü' }, 'doctor-1');

      expect(mockConsultationRepository.findByUniqueKey).toHaveBeenCalledWith('tenant-1', 'patient-123-äöü', expect.any(Date), 'doctor-1');
    });
  });

  describe('createRevisit', () => {
    it('should throw BadRequestException when tenant ID is not available', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return null;
        if (key === 'user') return { id: 'user-id-1' };
        return null;
      });

      await expect(service.createRevisit({ patientId: 'patient-1' }, 'doctor-1', 'parent-id')).rejects.toThrow(BadRequestException);
    });

    // The "parent not found" path is now routed through
    // `assertParentInScope`, which throws `NotFoundException` (no
    // existence leak) instead of `BadRequestException`. This is a
    // behaviour change vs. the previous error type, but it is required
    // to make missing-vs-cross-tenant indistinguishable.
    it('should throw NotFoundException when parent consultation not found', async () => {
      mockConsultationRepository.findById.mockResolvedValue(null);

      await expect(service.createRevisit({ patientId: 'patient-1' }, 'doctor-1', 'non-existent-id')).rejects.toThrow(NotFoundException);
      await expect(service.createRevisit({ patientId: 'patient-1' }, 'doctor-1', 'non-existent-id')).rejects.toThrow('Resource not found');
    });

    it('should create revisit consultation when parent exists', async () => {
      const parentConsultation = createMockConsultationEntity({ id: 'parent-id' });
      mockConsultationRepository.findById.mockResolvedValue(parentConsultation);
      const newRevisit = createMockConsultationEntity({
        id: 'new-revisit-id',
        parentConsultationId: 'parent-id',
      });
      mockConsultationRepository.create.mockResolvedValue(newRevisit);

      const result = await service.createRevisit({ patientId: 'patient-1' }, 'doctor-1', 'parent-id');

      expect(result.id).toBe('new-revisit-id');
      expect(result.isNew).toBe(true);
      expect(mockConsultationRepository.create).toHaveBeenCalled();
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceCreated,
        expect.objectContaining({
          resourceId: 'new-revisit-id',
          data: { action: 'createRevisit', parentId: 'parent-id' },
        }),
      );
    });

    it('should use provided appointment date for revisit', async () => {
      const parentConsultation = createMockConsultationEntity();
      mockConsultationRepository.findById.mockResolvedValue(parentConsultation);
      const newRevisit = createMockConsultationEntity({ id: 'new-revisit-id' });
      mockConsultationRepository.create.mockResolvedValue(newRevisit);

      await service.createRevisit({ patientId: 'patient-1', appointmentDate: '2026-03-01' }, 'doctor-1', 'parent-id');

      expect(mockConsultationRepository.create).toHaveBeenCalled();
    });

    it('should allow different doctor for revisit', async () => {
      const parentConsultation = createMockConsultationEntity({ doctorId: 'original-doctor' });
      mockConsultationRepository.findById.mockResolvedValue(parentConsultation);
      const newRevisit = createMockConsultationEntity({
        id: 'new-revisit-id',
        doctorId: 'different-doctor',
      });
      mockConsultationRepository.create.mockResolvedValue(newRevisit);

      const result = await service.createRevisit({ patientId: 'patient-1' }, 'different-doctor', 'parent-id');

      expect(result.isNew).toBe(true);
      expect(mockConsultationRepository.create).toHaveBeenCalled();
    });

    it('should include metadata in revisit', async () => {
      const parentConsultation = createMockConsultationEntity();
      mockConsultationRepository.findById.mockResolvedValue(parentConsultation);
      const newRevisit = createMockConsultationEntity({
        id: 'new-revisit-id',
        metadata: { reason: 'follow-up' },
      });
      mockConsultationRepository.create.mockResolvedValue(newRevisit);

      await service.createRevisit({ patientId: 'patient-1', metadata: { reason: 'follow-up' } }, 'doctor-1', 'parent-id');

      expect(mockConsultationRepository.create).toHaveBeenCalled();
    });

    it('should include departmentId in revisit', async () => {
      const parentConsultation = createMockConsultationEntity();
      mockConsultationRepository.findById.mockResolvedValue(parentConsultation);
      const newRevisit = createMockConsultationEntity({
        id: 'new-revisit-id',
        departmentId: 'dept-cardio',
      });
      mockConsultationRepository.create.mockResolvedValue(newRevisit);

      await service.createRevisit({ patientId: 'patient-1', departmentId: 'dept-cardio' }, 'doctor-1', 'parent-id');

      expect(mockConsultationRepository.create).toHaveBeenCalled();
    });
  });

  describe('getById', () => {
    it('should return null when consultation not found', async () => {
      mockConsultationRepository.findWithContext.mockResolvedValue(null);

      const result = await service.getById('non-existent-id');

      expect(result).toBeNull();
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('should return consultation with context when found', async () => {
      const consultation = createMockConsultationEntity({
        ContextItems: [
          {
            id: 'context-1',
            consultationId: 'consultation-id-1',
            type: 'transcription',
            content: 'Test content',
            source: 'user',
            currentVersionNumber: 1,
            qdrantSynced: false,
            isSummary: false,
            isTranscription: true,
            isAiGenerated: false,
            isMediaType: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      });
      mockConsultationRepository.findWithContext.mockResolvedValue(consultation);

      const result = await service.getById('consultation-id-1');

      expect(result).not.toBeNull();
      expect(result?.id).toBe('consultation-id-1');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceViewed,
        expect.objectContaining({
          resourceId: 'consultation-id-1',
        }),
      );
    });
  });

  describe('getByIdWithRelations', () => {
    it('should return null when consultation not found', async () => {
      mockConsultationRepository.findWithRelations.mockResolvedValue(null);

      const result = await service.getByIdWithRelations('non-existent-id');

      expect(result).toBeNull();
    });

    it('should return consultation with all relations when found', async () => {
      const consultation = createMockConsultationEntity({
        Doctor: {
          id: 'doctor-1',
          username: 'dr.smith',
          UserProfile: { firstName: 'John', lastName: 'Smith' },
        },
        Department: {
          id: 'dept-1',
          code: 'CARDIO',
          name: 'Cardiology',
        },
      });
      mockConsultationRepository.findWithRelations.mockResolvedValue(consultation);

      const result = await service.getByIdWithRelations('consultation-id-1');

      expect(result).not.toBeNull();
      expect(result?.doctor).toBeDefined();
      expect(result?.department).toBeDefined();
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceViewed,
        expect.objectContaining({
          data: { id: 'consultation-id-1', withRelations: true },
        }),
      );
    });
  });

  describe('getPatientHistory', () => {
    it('should throw BadRequestException when tenant ID is not available', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return null;
        return null;
      });

      await expect(service.getPatientHistory('patient-1')).rejects.toThrow(BadRequestException);
    });

    it('should return empty array when no consultations found', async () => {
      mockConsultationRepository.findAll.mockResolvedValue([]);

      const result = await service.getPatientHistory('patient-1');

      expect(result).toEqual([]);
      expect(mockConsultationRepository.findAll).toHaveBeenCalledWith({
        filters: { tenantId: 'tenant-1', patientId: 'patient-1' },
        sort: [{ appointmentDate: 'desc' }],
      });
    });

    it('should return patient consultation history sorted by date', async () => {
      const consultations = [
        createMockConsultationEntity({
          id: 'consultation-2',
          appointmentDate: new Date('2026-01-30'),
        }),
        createMockConsultationEntity({
          id: 'consultation-1',
          appointmentDate: new Date('2026-01-29'),
        }),
      ];
      mockConsultationRepository.findAll.mockResolvedValue(consultations);

      const result = await service.getPatientHistory('patient-1');

      expect(result).toHaveLength(2);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceViewed,
        expect.objectContaining({
          data: { patientId: 'patient-1', historyCount: 2 },
        }),
      );
    });
  });

  describe('getByPatientAndDate', () => {
    it('should throw BadRequestException when tenant ID is not available', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return null;
        return null;
      });

      await expect(service.getByPatientAndDate('patient-1', '2026-01-29')).rejects.toThrow(BadRequestException);
    });

    it('should return consultations for patient on specific date', async () => {
      const consultations = [
        createMockConsultationEntity({ doctorId: 'doctor-1' }),
        createMockConsultationEntity({ id: 'consultation-2', doctorId: 'doctor-2' }),
      ];
      mockConsultationRepository.findByPatientAndDate.mockResolvedValue(consultations);

      const result = await service.getByPatientAndDate('patient-1', '2026-01-29');

      expect(result).toHaveLength(2);
      expect(mockConsultationRepository.findByPatientAndDate).toHaveBeenCalledWith('tenant-1', 'patient-1', new Date('2026-01-29'));
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceViewed,
        expect.objectContaining({
          data: { patientId: 'patient-1', date: '2026-01-29', count: 2 },
        }),
      );
    });
  });

  describe('getConsultationChain', () => {
    it('should return consultation chain (parent and children)', async () => {
      const chain = [
        createMockConsultationEntity({ id: 'parent-id' }),
        createMockConsultationEntity({ id: 'child-1', parentConsultationId: 'parent-id' }),
        createMockConsultationEntity({ id: 'child-2', parentConsultationId: 'parent-id' }),
      ];
      mockConsultationRepository.findConsultationChain.mockResolvedValue(chain);

      const result = await service.getConsultationChain('parent-id');

      expect(result).toHaveLength(3);
      expect(mockConsultationRepository.findConsultationChain).toHaveBeenCalledWith('parent-id');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceViewed,
        expect.objectContaining({
          data: { consultationId: 'parent-id', chainCount: 3 },
        }),
      );
    });

    it('should return single consultation when no chain exists', async () => {
      const chain = [createMockConsultationEntity()];
      mockConsultationRepository.findConsultationChain.mockResolvedValue(chain);

      const result = await service.getConsultationChain('consultation-id-1');

      expect(result).toHaveLength(1);
    });

    it('should return empty array when consultation not found', async () => {
      mockConsultationRepository.findConsultationChain.mockResolvedValue([]);

      const result = await service.getConsultationChain('non-existent');

      expect(result).toHaveLength(0);
    });

    it('should handle deep chain hierarchy', async () => {
      const chain = [
        createMockConsultationEntity({ id: 'root' }),
        createMockConsultationEntity({ id: 'level-1', parentConsultationId: 'root' }),
        createMockConsultationEntity({ id: 'level-2', parentConsultationId: 'level-1' }),
        createMockConsultationEntity({ id: 'level-3', parentConsultationId: 'level-2' }),
      ];
      mockConsultationRepository.findConsultationChain.mockResolvedValue(chain);

      const result = await service.getConsultationChain('root');

      expect(result).toHaveLength(4);
    });
  });

  // ============================================
  // Edge Cases and Error Handling
  // ============================================

  describe('Edge Cases', () => {
    it('should handle concurrent getOrCreate calls for same patient', async () => {
      const existingConsultation = createMockConsultationEntity();
      // First call creates, second call returns existing
      mockConsultationRepository.findByUniqueKey.mockResolvedValueOnce(null).mockResolvedValueOnce(existingConsultation);
      mockConsultationRepository.create.mockResolvedValue(existingConsultation);

      const result1 = await service.getOrCreate({ patientId: 'patient-1' }, 'doctor-1');
      const result2 = await service.getOrCreate({ patientId: 'patient-1' }, 'doctor-1');

      expect(result1.isNew).toBe(true);
      expect(result2.isNew).toBe(false);
    });

    it('should handle very long patientId', async () => {
      const longPatientId = 'patient-' + 'x'.repeat(500);
      mockConsultationRepository.findByUniqueKey.mockResolvedValue(null);
      const newConsultation = createMockConsultationEntity({ patientId: longPatientId });
      mockConsultationRepository.create.mockResolvedValue(newConsultation);

      await service.getOrCreate({ patientId: longPatientId }, 'doctor-1');

      expect(mockConsultationRepository.findByUniqueKey).toHaveBeenCalledWith('tenant-1', longPatientId, expect.any(Date), 'doctor-1');
    });

    it('should handle null metadata', async () => {
      mockConsultationRepository.findByUniqueKey.mockResolvedValue(null);
      const newConsultation = createMockConsultationEntity({ metadata: null });
      mockConsultationRepository.create.mockResolvedValue(newConsultation);

      await service.getOrCreate({ patientId: 'patient-1', metadata: null as any }, 'doctor-1');

      expect(mockConsultationRepository.create).toHaveBeenCalled();
    });

    it('should handle empty metadata object', async () => {
      mockConsultationRepository.findByUniqueKey.mockResolvedValue(null);
      const newConsultation = createMockConsultationEntity({ metadata: {} });
      mockConsultationRepository.create.mockResolvedValue(newConsultation);

      await service.getOrCreate({ patientId: 'patient-1', metadata: {} }, 'doctor-1');

      expect(mockConsultationRepository.create).toHaveBeenCalled();
    });
  });

  // ============================================
  // ENH-3: Pagination Tests
  // ============================================

  describe('getPatientHistoryPaginated', () => {
    it('should return paginated consultation history', async () => {
      const consultations = [
        createMockConsultationEntity({ id: 'c-1' }),
        createMockConsultationEntity({ id: 'c-2' }),
        createMockConsultationEntity({ id: 'c-3' }),
      ];
      mockConsultationRepository.findPaginatedWithRelations.mockResolvedValue(consultations);
      mockConsultationRepository.count.mockResolvedValue(25);

      const result = await service.getPatientHistoryPaginated('patient-1', 1, 3);

      expect(result.data).toHaveLength(3);
      expect(result.count).toBe(25);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(3);
    });

    it('should pass correct page and limit to repository', async () => {
      mockConsultationRepository.findPaginatedWithRelations.mockResolvedValue([]);
      mockConsultationRepository.count.mockResolvedValue(0);

      await service.getPatientHistoryPaginated('patient-1', 2, 10);

      expect(mockConsultationRepository.findPaginatedWithRelations).toHaveBeenCalledWith(
        expect.objectContaining({
          page: 2,
          limit: 10,
          sort: [{ appointmentDate: 'desc' }],
        }),
      );
    });

    it('should throw BadRequestException when tenantId is missing', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return undefined;
        if (key === 'user') return { id: 'user-1' };
        return undefined;
      });

      await expect(service.getPatientHistoryPaginated('patient-1', 1, 20)).rejects.toThrow(BadRequestException);
    });

    it('should broadcast SysEvent with pagination metadata', async () => {
      mockConsultationRepository.findPaginatedWithRelations.mockResolvedValue([]);
      mockConsultationRepository.count.mockResolvedValue(42);

      await service.getPatientHistoryPaginated('patient-1', 3, 10);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          data: expect.objectContaining({
            patientId: 'patient-1',
            page: 3,
            limit: 10,
            count: 42,
          }),
        }),
      );
    });
  });

  describe('getByPatientAndDatePaginated', () => {
    it('should return paginated same-day consultations', async () => {
      const consultations = [
        createMockConsultationEntity({ id: 'c-1' }),
        createMockConsultationEntity({ id: 'c-2' }),
        createMockConsultationEntity({ id: 'c-3' }),
        createMockConsultationEntity({ id: 'c-4' }),
        createMockConsultationEntity({ id: 'c-5' }),
      ];
      mockConsultationRepository.findByPatientAndDate.mockResolvedValue(consultations);

      const result = await service.getByPatientAndDatePaginated('patient-1', '2026-02-17', 1, 3);

      expect(result.data).toHaveLength(3);
      expect(result.count).toBe(5);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(3);
    });

    it('should correctly slice for page 2', async () => {
      const consultations = Array.from({ length: 5 }, (_, i) => createMockConsultationEntity({ id: `c-${i + 1}` }));
      mockConsultationRepository.findByPatientAndDate.mockResolvedValue(consultations);

      const result = await service.getByPatientAndDatePaginated('patient-1', '2026-02-17', 2, 2);

      expect(result.data).toHaveLength(2);
      expect(result.page).toBe(2);
      // Should contain c-3 and c-4 (skip=2, take=2)
    });

    it('should handle empty results', async () => {
      mockConsultationRepository.findByPatientAndDate.mockResolvedValue([]);

      const result = await service.getByPatientAndDatePaginated('patient-1', '2026-02-17', 1, 20);

      expect(result.data).toHaveLength(0);
      expect(result.count).toBe(0);
      expect(result.page).toBe(1);
    });

    it('should handle page beyond data range', async () => {
      const consultations = [createMockConsultationEntity()];
      mockConsultationRepository.findByPatientAndDate.mockResolvedValue(consultations);

      const result = await service.getByPatientAndDatePaginated('patient-1', '2026-02-17', 10, 20);

      expect(result.data).toHaveLength(0);
      expect(result.count).toBe(1);
    });

    it('should throw BadRequestException when tenantId is missing', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return undefined;
        if (key === 'user') return { id: 'user-1' };
        return undefined;
      });

      await expect(service.getByPatientAndDatePaginated('patient-1', '2026-02-17', 1, 20)).rejects.toThrow(BadRequestException);
    });
  });

  // ============================================================
  // Tenant-wide admin listing (scope: all-in-tenant)
  //
  // listConsultationsForTenant is the admin counterpart to
  // listConsultations: it MUST NOT scope to the caller's doctorId,
  // so a tenant admin sees every consultation in their tenant. It
  // reuses findPaginatedWithRelations + count (no shared-patient
  // expansion) and is gated at the controller via @CanManage.
  // ============================================================
  describe('listConsultationsForTenant', () => {
    it('lists ALL consultations in the tenant without scoping to a doctorId', async () => {
      const consultations = [
        createMockConsultationEntity({ id: 'c-1', doctorId: 'doctor-1' }),
        createMockConsultationEntity({ id: 'c-2', doctorId: 'doctor-2' }),
      ];
      mockConsultationRepository.findPaginatedWithRelations.mockResolvedValue(consultations);
      mockConsultationRepository.count.mockResolvedValue(2);

      const result = await service.listConsultationsForTenant({ page: 1, pageSize: 10 });

      expect(result.data).toHaveLength(2);
      expect(result.count).toBe(2);
      // The repository filter is tenant-only — never the caller's doctorId.
      const callArg = mockConsultationRepository.findPaginatedWithRelations.mock.calls[0][0];
      expect(callArg.filters).toEqual({ tenantId: 'tenant-1' });
      expect(callArg.filters).not.toHaveProperty('doctorId');
    });

    it('applies optional patientId / doctorId / departmentId filters', async () => {
      mockConsultationRepository.findPaginatedWithRelations.mockResolvedValue([]);
      mockConsultationRepository.count.mockResolvedValue(0);

      await service.listConsultationsForTenant({
        page: 2,
        pageSize: 5,
        patientId: 'patient-9',
        doctorId: 'doctor-7',
        departmentId: 'dept-3',
      });

      expect(mockConsultationRepository.findPaginatedWithRelations).toHaveBeenCalledWith(
        expect.objectContaining({
          page: 2,
          limit: 5,
          sort: [{ appointmentDate: 'desc' }],
          filters: { tenantId: 'tenant-1', patientId: 'patient-9', doctorId: 'doctor-7', departmentId: 'dept-3' },
        }),
      );
      expect(mockConsultationRepository.count).toHaveBeenCalledWith({
        filters: { tenantId: 'tenant-1', patientId: 'patient-9', doctorId: 'doctor-7', departmentId: 'dept-3' },
      });
    });

    // Admin live console filters the tenant list to in-progress
    // recordings (?status=RECORDING) to find the consultations that may have a
    // live-documentation session.
    it('applies an optional status filter (e.g. RECORDING)', async () => {
      mockConsultationRepository.findPaginatedWithRelations.mockResolvedValue([]);
      mockConsultationRepository.count.mockResolvedValue(0);

      await service.listConsultationsForTenant({ page: 1, pageSize: 10, status: ConsultationStatus.RECORDING });

      expect(mockConsultationRepository.findPaginatedWithRelations).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: { tenantId: 'tenant-1', status: ConsultationStatus.RECORDING },
        }),
      );
      expect(mockConsultationRepository.count).toHaveBeenCalledWith({
        filters: { tenantId: 'tenant-1', status: ConsultationStatus.RECORDING },
      });
    });

    it('throws BadRequestException when tenantId is missing', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return undefined;
        if (key === 'user') return { id: 'user-1' };
        return undefined;
      });

      await expect(service.listConsultationsForTenant({ page: 1, pageSize: 10 })).rejects.toThrow(BadRequestException);
    });

    it('broadcasts a ResourceViewed event with pagination metadata', async () => {
      mockConsultationRepository.findPaginatedWithRelations.mockResolvedValue([]);
      mockConsultationRepository.count.mockResolvedValue(13);

      await service.listConsultationsForTenant({ page: 3, pageSize: 10 });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          data: expect.objectContaining({ scope: 'tenant', page: 3, pageSize: 10, count: 13 }),
        }),
      );
    });
  });

  // ============================================================
  // Server-side consultation range aggregation.
  //
  // Replaces the FE's client-side single-page bucketing. Counts are read
  // via `ConsultationRepository.findCreatedInRange` (the
  // read is behind the repository), zero-filled across the
  // whole window, and split into new (parentConsultationId IS NULL) vs
  // revisit. Bucket key/label mirror the FE chart (UTC boundaries).
  // ============================================================
  describe('aggregateConsultationsForTenant', () => {
    it('zero-fills daily buckets and splits new vs revisit by parentConsultationId', async () => {
      mockConsultationRepository.findCreatedInRange.mockResolvedValue([
        { createdAt: new Date('2026-01-01T08:00:00Z'), parentConsultationId: null },
        { createdAt: new Date('2026-01-01T18:00:00Z'), parentConsultationId: null },
        { createdAt: new Date('2026-01-01T20:00:00Z'), parentConsultationId: 'parent-1' },
        { createdAt: new Date('2026-01-03T09:00:00Z'), parentConsultationId: null },
      ]);

      const result = await service.aggregateConsultationsForTenant({
        from: '2026-01-01',
        to: '2026-01-03',
        granularity: 'day',
      });

      expect(result.granularity).toBe('day');
      expect(result.buckets).toHaveLength(3);
      expect(result.buckets[0]).toMatchObject({ key: '2026-01-01', label: 'Jan 1', newVisits: 2, revisits: 1, total: 3 });
      expect(result.buckets[1]).toMatchObject({ key: '2026-01-02', label: 'Jan 2', newVisits: 0, revisits: 0, total: 0 });
      expect(result.buckets[2]).toMatchObject({ key: '2026-01-03', label: 'Jan 3', newVisits: 1, revisits: 0, total: 1 });
      expect(result.totals).toEqual({ total: 4, newVisits: 3, revisits: 1 });
    });

    it('scopes the repository read to the CLS tenant for a tenant-admin', async () => {
      mockConsultationRepository.findCreatedInRange.mockResolvedValue([]);

      await service.aggregateConsultationsForTenant({ from: '2026-01-01', to: '2026-01-02', granularity: 'day' });

      const [rangeStart, rangeEnd, tenantId] = mockConsultationRepository.findCreatedInRange.mock.calls[0];
      expect(rangeStart).toBeInstanceOf(Date);
      expect(rangeEnd).toBeInstanceOf(Date);
      expect(tenantId).toBe('tenant-1');
    });

    it('auto-rolls up to month buckets for spans over 70 days', async () => {
      mockConsultationRepository.findCreatedInRange.mockResolvedValue([]);

      const result = await service.aggregateConsultationsForTenant({ from: '2026-01-01', to: '2026-04-15' });

      expect(result.granularity).toBe('month');
      expect(result.buckets.map((b) => b.key)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04']);
      expect(result.buckets[0].label).toBe('Jan');
    });

    it('throws BadRequestException for an invalid date', async () => {
      await expect(service.aggregateConsultationsForTenant({ from: 'nonsense', to: '2026-01-02' })).rejects.toThrow(BadRequestException);
    });
  });

  // ============================================================
  // (TD3 / DEF-1) — cross-tenant platform read for super-admin.
  //
  // The platform dashboard runs as a GLOBAL_ADMIN with NO working tenant; the
  // old hard 400 (`Tenant ID is required`) broke it. A super-admin with no
  // CLS tenant must now read cross-tenant (no tenantId filter → the Prisma
  // tenantScope extension passes through). Non-super callers are unchanged.
  // ============================================================
  describe('listConsultationsForTenant cross-tenant super-admin', () => {
    it('OMITS the tenantId filter for a GLOBAL_ADMIN with no working tenant', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return null;
        if (key === 'user') return { id: 'su-1', roles: ['GLOBAL_ADMIN'] };
        return null;
      });
      mockConsultationRepository.findPaginatedWithRelations.mockResolvedValue([]);
      mockConsultationRepository.count.mockResolvedValue(0);

      await service.listConsultationsForTenant({ page: 1, pageSize: 10 });

      const callArg = mockConsultationRepository.findPaginatedWithRelations.mock.calls[0][0];
      expect(callArg.filters).not.toHaveProperty('tenantId');
    });

    it('still throws BadRequestException for a non-super caller with no tenant', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return null;
        if (key === 'user') return { id: 'u-1', roles: ['TENANT_ADMIN'] };
        return null;
      });

      await expect(service.listConsultationsForTenant({ page: 1, pageSize: 10 })).rejects.toThrow(BadRequestException);
    });
  });

  // ============================================================
  // Cross-aggregate tenant isolation
  //
  // The Consultation aggregate owns three cross-aggregate references
  // that the multi-tenancy audit flagged as leak vectors:
  //   - parentConsultationId  (audit C-4 / B-3 — revisits + chains)
  //   - departmentId          (audit C-2 — Department lives in Department aggregate)
  //   - doctorId              (audit C-1 — User membership via UserRoleAssignment)
  //
  // Each must be asserted in the caller's tenant before any create.
  // Failures route through `assertParentInScope` /
  // `assertUserBelongsToTenant`, which return `NotFoundException`
  // (never `ForbiddenException`) so the response never reveals the
  // existence of a cross-tenant resource.
  // ============================================================
  describe('cross-aggregate tenant checks', () => {
    describe('getOrCreate', () => {
      it('throws NotFoundException when doctorId has no role-assignment in caller tenant', async () => {
        mockConsultationRepository.findByUniqueKey.mockResolvedValue(null);
        mockUserRoleAssignmentRepository.findFirst.mockResolvedValue(null);

        await expect(service.getOrCreate({ patientId: 'patient-1' }, 'cross-tenant-doctor')).rejects.toThrow(NotFoundException);
        await expect(service.getOrCreate({ patientId: 'patient-1' }, 'cross-tenant-doctor')).rejects.toThrow('Resource not found');

        expect(mockUserRoleAssignmentRepository.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              userId: 'cross-tenant-doctor',
              tenantId: 'tenant-1',
              resourceStatus: ResourceStatusType.ENABLED,
            }),
          }),
        );
        expect(mockConsultationRepository.create).not.toHaveBeenCalled();
      });

      it('throws NotFoundException when departmentId belongs to another tenant', async () => {
        mockConsultationRepository.findByUniqueKey.mockResolvedValue(null);
        mockDepartmentRepository.findById.mockResolvedValue({
          id: 'dept-other',
          tenantId: 'tenant-OTHER',
        });

        await expect(service.getOrCreate({ patientId: 'patient-1', departmentId: 'dept-other' }, 'doctor-1')).rejects.toThrow(NotFoundException);
        await expect(service.getOrCreate({ patientId: 'patient-1', departmentId: 'dept-other' }, 'doctor-1')).rejects.toThrow('Resource not found');

        expect(mockConsultationRepository.create).not.toHaveBeenCalled();
      });

      it('throws NotFoundException when departmentId does not exist (no existence leak)', async () => {
        mockConsultationRepository.findByUniqueKey.mockResolvedValue(null);
        mockDepartmentRepository.findById.mockResolvedValue(null);

        await expect(service.getOrCreate({ patientId: 'patient-1', departmentId: 'no-such-dept' }, 'doctor-1')).rejects.toThrow(NotFoundException);
        expect(mockConsultationRepository.create).not.toHaveBeenCalled();
      });

      it('throws NotFoundException when parentConsultationId belongs to another tenant', async () => {
        mockConsultationRepository.findByUniqueKey.mockResolvedValue(null);
        mockConsultationRepository.findById.mockResolvedValue(
          createMockConsultationEntity({
            id: 'parent-other',
            tenantId: 'tenant-OTHER',
          }),
        );

        await expect(service.getOrCreate({ patientId: 'patient-1', parentConsultationId: 'parent-other' }, 'doctor-1')).rejects.toThrow(
          NotFoundException,
        );
        await expect(service.getOrCreate({ patientId: 'patient-1', parentConsultationId: 'parent-other' }, 'doctor-1')).rejects.toThrow(
          'Resource not found',
        );

        expect(mockConsultationRepository.create).not.toHaveBeenCalled();
      });

      it('throws NotFoundException when parentConsultationId does not exist (no existence leak)', async () => {
        mockConsultationRepository.findByUniqueKey.mockResolvedValue(null);
        mockConsultationRepository.findById.mockResolvedValue(null);

        await expect(service.getOrCreate({ patientId: 'patient-1', parentConsultationId: 'no-such-parent' }, 'doctor-1')).rejects.toThrow(
          NotFoundException,
        );
        expect(mockConsultationRepository.create).not.toHaveBeenCalled();
      });

      it('does not call parent / department checks when those refs are absent', async () => {
        mockConsultationRepository.findByUniqueKey.mockResolvedValue(null);
        const newConsultation = createMockConsultationEntity();
        mockConsultationRepository.create.mockResolvedValue(newConsultation);

        await service.getOrCreate({ patientId: 'patient-1' }, 'doctor-1');

        expect(mockDepartmentRepository.findById).not.toHaveBeenCalled();
        expect(mockConsultationRepository.findById).not.toHaveBeenCalled();
        expect(mockUserRoleAssignmentRepository.findFirst).toHaveBeenCalledOnce();
      });
    });

    describe('createRevisit', () => {
      it('throws NotFoundException when doctorId has no role-assignment in caller tenant', async () => {
        mockConsultationRepository.findById.mockResolvedValue(createMockConsultationEntity({ id: 'parent-id' }));
        mockUserRoleAssignmentRepository.findFirst.mockResolvedValue(null);

        await expect(service.createRevisit({ patientId: 'patient-1' }, 'cross-tenant-doctor', 'parent-id')).rejects.toThrow(NotFoundException);
        expect(mockConsultationRepository.create).not.toHaveBeenCalled();
      });

      it('throws NotFoundException when departmentId belongs to another tenant', async () => {
        mockConsultationRepository.findById.mockResolvedValue(createMockConsultationEntity({ id: 'parent-id' }));
        mockDepartmentRepository.findById.mockResolvedValue({
          id: 'dept-other',
          tenantId: 'tenant-OTHER',
        });

        await expect(service.createRevisit({ patientId: 'patient-1', departmentId: 'dept-other' }, 'doctor-1', 'parent-id')).rejects.toThrow(
          NotFoundException,
        );
        expect(mockConsultationRepository.create).not.toHaveBeenCalled();
      });

      it('throws NotFoundException when parentConsultationId belongs to another tenant (audit)', async () => {
        mockConsultationRepository.findById.mockResolvedValue(
          createMockConsultationEntity({
            id: 'parent-other',
            tenantId: 'tenant-OTHER',
          }),
        );

        await expect(service.createRevisit({ patientId: 'patient-1' }, 'doctor-1', 'parent-other')).rejects.toThrow(NotFoundException);
        await expect(service.createRevisit({ patientId: 'patient-1' }, 'doctor-1', 'parent-other')).rejects.toThrow('Resource not found');

        expect(mockConsultationRepository.create).not.toHaveBeenCalled();
      });
    });
  });

  // ============================================================
  // Consultation read-paths
  // defense-in-depth.
  //
  // The three read methods (`getById`, `getByIdWithRelations`,
  // `getConsultationChain`) today rely SOLELY on the Prisma
  // `tenantScope` extension to filter foreign-tenant rows. If a
  // future PR ever bypasses the extension (raw query, platform-
  // admin path, mocked CLS in a test, background job with stale
  // CLS) the methods silently return foreign-tenant data.
  //
  // Service-layer assertions after the repo call provide an
  // EXPLICIT second line of defence: a generic
  // `NotFoundException('Resource not found')` on tenant mismatch
  // and `BadRequestException` when the caller has no CLS tenant.
  //
  // These tests mock the repository to RETURN foreign-tenant rows
  // (simulating an extension bypass) so the cross-tenant negatives
  // are red today and green after the service-layer guard lands.
  // ============================================================
  describe('Consultation read-paths defense-in-depth', () => {
    describe('getById', () => {
      // Regression-pin — intentional duplicate
      // of the happy-path test elsewhere. Kept under this describe
      // block so it is self-contained: deleting the
      // happy-path test elsewhere must not silently delete
      // this block's positive control.
      it('returns DTO when the fetched entity tenant matches caller CLS tenant (sanity)', async () => {
        const consultation = createMockConsultationEntity({
          id: 'consultation-id-1',
          tenantId: 'tenant-1',
        });
        mockConsultationRepository.findWithContext.mockResolvedValue(consultation);

        const result = await service.getById('consultation-id-1');

        expect(result).not.toBeNull();
        expect(result?.id).toBe('consultation-id-1');
        expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceViewed, expect.objectContaining({ resourceId: 'consultation-id-1' }));
      });

      it('throws NotFoundException with generic message when the fetched entity belongs to another tenant', async () => {
        const foreign = createMockConsultationEntity({
          id: 'consultation-id-foreign',
          tenantId: 'tenant-OTHER',
        });
        mockConsultationRepository.findWithContext.mockResolvedValue(foreign);

        await expect(service.getById('consultation-id-foreign')).rejects.toThrow(NotFoundException);
        await expect(service.getById('consultation-id-foreign')).rejects.toThrow('Resource not found');

        // Guard must short-circuit BEFORE the SysEvent broadcast: the
        // caller never sees a `ResourceViewed` event for a row they
        // should not be aware of.
        expect(mockEventEmitter.emit).not.toHaveBeenCalled();
      });

      it('throws fail-closed when CLS tenantId is missing and the repo returns a row (belt-and-suspenders for the post-fetch assertEqualTenants guard)', async () => {
        // After the hoisted CLS check
        // landed in `getById`, this test's `findWithContext` mock
        // is structurally unreachable: the hoist throws before the
        // repo call. The test is retained as a defense-in-depth
        // regression-pin for the post-fetch `assertEqualTenants`
        // guard — if a future change ever removes or weakens the
        // hoist, this test still catches the contract violation
        // (missing CLS must throw, not return). DO NOT delete the
        // mock; it documents that both layers fail closed.
        mockClsService.get.mockImplementation((key: string) => {
          if (key === 'tenantId') return null;
          if (key === 'user') return { id: 'user-id-1' };
          return null;
        });
        const consultation = createMockConsultationEntity({
          id: 'consultation-id-1',
          tenantId: 'tenant-1',
        });
        mockConsultationRepository.findWithContext.mockResolvedValue(consultation);

        await expect(service.getById('consultation-id-1')).rejects.toThrow(BadRequestException);

        expect(mockEventEmitter.emit).not.toHaveBeenCalled();
      });

      it('throws BadRequestException without calling repo when CLS tenantId is missing (getById, hoisted check)', async () => {
        // The hoisted CLS check short-
        // circuits BEFORE the repo round-trip, matching the
        // `getConsultationChain` convention. Saves a useless DB
        // call on background / unprovisioned contexts that have
        // no chance of returning a visible row.
        mockClsService.get.mockImplementation((key: string) => {
          if (key === 'tenantId') return null;
          if (key === 'user') return { id: 'user-id-1' };
          return null;
        });

        await expect(service.getById('any-id')).rejects.toThrow(BadRequestException);

        expect(mockConsultationRepository.findWithContext).not.toHaveBeenCalled();
        expect(mockEventEmitter.emit).not.toHaveBeenCalled();
      });
    });

    describe('getByIdWithRelations', () => {
      it('throws NotFoundException with generic message when the fetched entity belongs to another tenant', async () => {
        const foreign = createMockConsultationEntity({
          id: 'consultation-id-foreign',
          tenantId: 'tenant-OTHER',
          Doctor: { id: 'doctor-x', UserProfile: { firstName: 'A', lastName: 'B' } },
          Department: { id: 'dept-x', code: 'X', name: 'X' },
        });
        mockConsultationRepository.findWithRelations.mockResolvedValue(foreign);

        await expect(service.getByIdWithRelations('consultation-id-foreign')).rejects.toThrow(NotFoundException);
        await expect(service.getByIdWithRelations('consultation-id-foreign')).rejects.toThrow('Resource not found');

        // Guard must short-circuit BEFORE the SysEvent broadcast so
        // the caller never sees a `ResourceViewed` for relations
        // they should not be aware of.
        expect(mockEventEmitter.emit).not.toHaveBeenCalled();
      });

      it('throws fail-closed when CLS tenantId is missing and the repo returns a row (belt-and-suspenders for the post-fetch assertEqualTenants guard)', async () => {
        // Sibling of the getById
        // test's annotation above: the hoisted CLS check makes this
        // `findWithRelations` mock unreachable, but the test is
        // retained as a defense-in-depth regression-pin for the
        // post-fetch `assertEqualTenants` guard. See the getById
        // sibling test for the full rationale.
        mockClsService.get.mockImplementation((key: string) => {
          if (key === 'tenantId') return null;
          if (key === 'user') return { id: 'user-id-1' };
          return null;
        });
        const consultation = createMockConsultationEntity({
          id: 'consultation-id-1',
          tenantId: 'tenant-1',
        });
        mockConsultationRepository.findWithRelations.mockResolvedValue(consultation);

        await expect(service.getByIdWithRelations('consultation-id-1')).rejects.toThrow(BadRequestException);

        expect(mockEventEmitter.emit).not.toHaveBeenCalled();
      });

      it('throws BadRequestException without calling repo when CLS tenantId is missing (getByIdWithRelations, hoisted check)', async () => {
        // Sibling of the getById hoist
        // test: the missing-CLS check now short-circuits BEFORE the
        // relations round-trip (which is more expensive than a
        // plain findById on Consultation given the Doctor /
        // Department / Context joins).
        mockClsService.get.mockImplementation((key: string) => {
          if (key === 'tenantId') return null;
          if (key === 'user') return { id: 'user-id-1' };
          return null;
        });

        await expect(service.getByIdWithRelations('any-id')).rejects.toThrow(BadRequestException);

        expect(mockConsultationRepository.findWithRelations).not.toHaveBeenCalled();
        expect(mockEventEmitter.emit).not.toHaveBeenCalled();
      });
    });

    describe('getConsultationChain', () => {
      it('returns [] when repo returns an empty chain (vs. all-foreign chain → throw)', async () => {
        // Pin the empty-vs-all-foreign distinction,
        // self-contained in this block. Empty repo result is
        // a legitimate "no chain exists" case (return [], emit
        // ResourceViewed with chainCount=0). Non-empty all-foreign is
        // a leak attempt and MUST throw (see "throws … EVERY returned
        // chain row is foreign-tenant" test below).
        mockConsultationRepository.findConsultationChain.mockResolvedValue([]);

        const result = await service.getConsultationChain('any-id');

        expect(result).toEqual([]);
        expect(mockEventEmitter.emit).toHaveBeenCalledWith(
          SysEventType.ResourceViewed,
          expect.objectContaining({ data: { consultationId: 'any-id', chainCount: 0 } }),
        );
      });

      it('returns all rows when the entire chain lives in the caller tenant', async () => {
        const chain = [
          createMockConsultationEntity({ id: 'parent-id', tenantId: 'tenant-1' }),
          createMockConsultationEntity({ id: 'child-1', tenantId: 'tenant-1', parentConsultationId: 'parent-id' }),
          createMockConsultationEntity({ id: 'child-2', tenantId: 'tenant-1', parentConsultationId: 'parent-id' }),
        ];
        mockConsultationRepository.findConsultationChain.mockResolvedValue(chain);

        const result = await service.getConsultationChain('parent-id');

        expect(result).toHaveLength(3);
        expect(mockEventEmitter.emit).toHaveBeenCalledWith(
          SysEventType.ResourceViewed,
          expect.objectContaining({ data: { consultationId: 'parent-id', chainCount: 3 } }),
        );
      });

      it('filters out foreign-tenant rows when the chain straddles tenants', async () => {
        const chain = [
          createMockConsultationEntity({ id: 'parent-id', tenantId: 'tenant-1' }),
          createMockConsultationEntity({ id: 'foreign-child', tenantId: 'tenant-OTHER', parentConsultationId: 'parent-id' }),
        ];
        mockConsultationRepository.findConsultationChain.mockResolvedValue(chain);

        const result = await service.getConsultationChain('parent-id');

        // Only the own-tenant row survives the filter; the caller
        // never learns the foreign row exists.
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('parent-id');
        expect(mockEventEmitter.emit).toHaveBeenCalledWith(
          SysEventType.ResourceViewed,
          expect.objectContaining({ data: { consultationId: 'parent-id', chainCount: 1 } }),
        );
      });

      it('throws NotFoundException when EVERY returned chain row is foreign-tenant', async () => {
        // Repo returns a non-empty chain but ALL rows live in other
        // tenants. Returning [] here would leak existence by absence
        // (caller learns "chain exists but nothing visible"), so the
        // service must throw the generic NotFoundException instead.
        const chain = [
          createMockConsultationEntity({ id: 'foreign-parent', tenantId: 'tenant-OTHER' }),
          createMockConsultationEntity({ id: 'foreign-child', tenantId: 'tenant-OTHER-2', parentConsultationId: 'foreign-parent' }),
        ];
        mockConsultationRepository.findConsultationChain.mockResolvedValue(chain);

        await expect(service.getConsultationChain('foreign-parent')).rejects.toThrow(NotFoundException);
        await expect(service.getConsultationChain('foreign-parent')).rejects.toThrow('Resource not found');

        expect(mockEventEmitter.emit).not.toHaveBeenCalled();
      });

      it('throws fail-closed when CLS tenantId is missing', async () => {
        mockClsService.get.mockImplementation((key: string) => {
          if (key === 'tenantId') return null;
          if (key === 'user') return { id: 'user-id-1' };
          return null;
        });

        await expect(service.getConsultationChain('any-id')).rejects.toThrow(BadRequestException);

        // Fail-closed must short-circuit BEFORE the repo round-trip.
        expect(mockConsultationRepository.findConsultationChain).not.toHaveBeenCalled();
      });
    });
  });

  // ============================================================
  // Consultation lifecycle (close / reopen / update)
  //
  // The Consultation model has no dedicated open/closed column, so
  // lifecycle status lives in `metadata.status` (OPEN | CLOSED;
  // absent ⇒ OPEN). close/reopen are idempotent (no write/event when
  // already in the target state). PATCH updates safely-mutable fields
  // only (appointmentDate / departmentId / metadata-merge / status).
  // ============================================================
  describe('lifecycle (close / reopen / update)', () => {
    describe('closeConsultation', () => {
      it('transitions OPEN → CLOSED, persists, emits ResourceUpdated, returns status CLOSED', async () => {
        const entity = createMockConsultationEntity({ id: 'c-1', metadata: null });
        mockConsultationRepository.findWithRelations.mockResolvedValue(entity);
        mockConsultationRepository.update.mockResolvedValue(entity);

        const result = await service.closeConsultation('c-1');

        expect(result.status).toBe('CLOSED');
        expect(mockConsultationRepository.update).toHaveBeenCalledTimes(1);
        const [updateId, updatedEntity] = mockConsultationRepository.update.mock.calls[0];
        expect(updateId).toBe('c-1');
        expect((updatedEntity.metadata as Record<string, unknown>).status).toBe('CLOSED');
        expect(mockEventEmitter.emit).toHaveBeenCalledWith(
          SysEventType.ResourceUpdated,
          expect.objectContaining({
            resourceId: 'c-1',
            data: expect.objectContaining({ action: 'closeConsultation', status: 'CLOSED' }),
          }),
        );
      });

      it('is idempotent when already CLOSED (no update, no event)', async () => {
        const entity = createMockConsultationEntity({ id: 'c-1', metadata: { status: 'CLOSED' } });
        mockConsultationRepository.findWithRelations.mockResolvedValue(entity);

        const result = await service.closeConsultation('c-1');

        expect(result.status).toBe('CLOSED');
        expect(mockConsultationRepository.update).not.toHaveBeenCalled();
        expect(mockEventEmitter.emit).not.toHaveBeenCalled();
      });

      it('throws NotFoundException when consultation not found', async () => {
        mockConsultationRepository.findWithRelations.mockResolvedValue(null);

        await expect(service.closeConsultation('missing')).rejects.toThrow(NotFoundException);
        expect(mockConsultationRepository.update).not.toHaveBeenCalled();
      });

      it('throws BadRequestException when tenantId is missing', async () => {
        mockClsService.get.mockImplementation((key: string) => (key === 'user' ? { id: 'u' } : null));

        await expect(service.closeConsultation('c-1')).rejects.toThrow(BadRequestException);
      });

      it('throws NotFoundException (generic) for a cross-tenant consultation', async () => {
        const foreign = createMockConsultationEntity({ id: 'c-x', tenantId: 'tenant-OTHER' });
        mockConsultationRepository.findWithRelations.mockResolvedValue(foreign);

        await expect(service.closeConsultation('c-x')).rejects.toThrow(NotFoundException);
        expect(mockConsultationRepository.update).not.toHaveBeenCalled();
        expect(mockEventEmitter.emit).not.toHaveBeenCalled();
      });
    });

    describe('reopenConsultation', () => {
      it('transitions CLOSED → OPEN, persists, emits ResourceUpdated, returns status OPEN', async () => {
        const entity = createMockConsultationEntity({ id: 'c-1', metadata: { status: 'CLOSED' } });
        mockConsultationRepository.findWithRelations.mockResolvedValue(entity);
        mockConsultationRepository.update.mockResolvedValue(entity);

        const result = await service.reopenConsultation('c-1');

        expect(result.status).toBe('OPEN');
        expect(mockConsultationRepository.update).toHaveBeenCalledTimes(1);
        const [, updatedEntity] = mockConsultationRepository.update.mock.calls[0];
        expect((updatedEntity.metadata as Record<string, unknown>).status).toBe('OPEN');
        expect(mockEventEmitter.emit).toHaveBeenCalledWith(
          SysEventType.ResourceUpdated,
          expect.objectContaining({
            resourceId: 'c-1',
            data: expect.objectContaining({ action: 'reopenConsultation', status: 'OPEN' }),
          }),
        );
      });

      it('is idempotent when status is absent (treated as already OPEN)', async () => {
        const entity = createMockConsultationEntity({ id: 'c-1', metadata: null });
        mockConsultationRepository.findWithRelations.mockResolvedValue(entity);

        const result = await service.reopenConsultation('c-1');

        expect(result.status).toBe('OPEN');
        expect(mockConsultationRepository.update).not.toHaveBeenCalled();
        expect(mockEventEmitter.emit).not.toHaveBeenCalled();
      });

      it('throws NotFoundException when consultation not found', async () => {
        mockConsultationRepository.findWithRelations.mockResolvedValue(null);

        await expect(service.reopenConsultation('missing')).rejects.toThrow(NotFoundException);
      });
    });

    describe('updateConsultation', () => {
      it('updates departmentId (tenant-checked) and shallow-merges metadata; emits ResourceUpdated', async () => {
        const entity = createMockConsultationEntity({ id: 'c-1', metadata: { existing: 'keep' } });
        mockConsultationRepository.findWithRelations.mockResolvedValue(entity);
        mockConsultationRepository.update.mockResolvedValue(entity);

        const result = await service.updateConsultation('c-1', { departmentId: 'dept-1', metadata: { note: 'x' } });

        expect(mockDepartmentRepository.findById).toHaveBeenCalledWith('dept-1');
        const [updateId, updated] = mockConsultationRepository.update.mock.calls[0];
        expect(updateId).toBe('c-1');
        expect(updated.departmentId).toBe('dept-1');
        expect(updated.metadata).toEqual({ existing: 'keep', note: 'x' });
        expect(result.departmentId).toBe('dept-1');
        expect(mockEventEmitter.emit).toHaveBeenCalledWith(
          SysEventType.ResourceUpdated,
          expect.objectContaining({
            resourceId: 'c-1',
            data: expect.objectContaining({ action: 'updateConsultation' }),
          }),
        );
      });

      it('writes status into metadata.status and surfaces it on the response', async () => {
        const entity = createMockConsultationEntity({ id: 'c-1', metadata: null });
        mockConsultationRepository.findWithRelations.mockResolvedValue(entity);
        mockConsultationRepository.update.mockResolvedValue(entity);

        const result = await service.updateConsultation('c-1', { status: 'CLOSED' });

        expect(result.status).toBe('CLOSED');
        const [, updated] = mockConsultationRepository.update.mock.calls[0];
        expect((updated.metadata as Record<string, unknown>).status).toBe('CLOSED');
      });

      it('updates appointmentDate', async () => {
        const entity = createMockConsultationEntity({ id: 'c-1' });
        mockConsultationRepository.findWithRelations.mockResolvedValue(entity);
        mockConsultationRepository.update.mockResolvedValue(entity);

        const result = await service.updateConsultation('c-1', { appointmentDate: '2026-04-01' });

        const [, updated] = mockConsultationRepository.update.mock.calls[0];
        expect(updated.appointmentDate).toEqual(new Date('2026-04-01'));
        expect(result.appointmentDate).toBe('2026-04-01');
      });

      it('throws NotFoundException when consultation not found', async () => {
        mockConsultationRepository.findWithRelations.mockResolvedValue(null);

        await expect(service.updateConsultation('missing', { status: 'CLOSED' })).rejects.toThrow(NotFoundException);
      });

      it('throws BadRequestException when tenantId is missing', async () => {
        mockClsService.get.mockImplementation((key: string) => (key === 'user' ? { id: 'u' } : null));

        await expect(service.updateConsultation('c-1', {})).rejects.toThrow(BadRequestException);
      });

      it('throws NotFoundException when departmentId belongs to another tenant', async () => {
        const entity = createMockConsultationEntity({ id: 'c-1' });
        mockConsultationRepository.findWithRelations.mockResolvedValue(entity);
        mockDepartmentRepository.findById.mockResolvedValue({ id: 'dept-other', tenantId: 'tenant-OTHER' });

        await expect(service.updateConsultation('c-1', { departmentId: 'dept-other' })).rejects.toThrow(NotFoundException);
        expect(mockConsultationRepository.update).not.toHaveBeenCalled();
      });

      // TASK-701 — Displayed-SIGNED Status Forgery Containment.
      // `metadata.status` is a reserved key: the DTO mapper treats it as a
      // trusted lifecycle signal, but the `metadata` field's own validation
      // is only `@IsObject()` (any shape). A caller who supplies
      // `metadata: { status: 'SIGNED' }` must be rejected rather than have
      // it silently shallow-merged into the entity's metadata column.
      it('rejects PATCH with a reserved status key inside metadata (forgery attempt)', async () => {
        const entity = createMockConsultationEntity({ id: 'c-1', metadata: { existing: 'keep' } });
        mockConsultationRepository.findWithRelations.mockResolvedValue(entity);

        await expect(service.updateConsultation('c-1', { metadata: { status: 'SIGNED' } })).rejects.toThrow(BadRequestException);

        expect(mockConsultationRepository.update).not.toHaveBeenCalled();
        expect(mockEventEmitter.emit).not.toHaveBeenCalled();
      });
    });
  });
});
