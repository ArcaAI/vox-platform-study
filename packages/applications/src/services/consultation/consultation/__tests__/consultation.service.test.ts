/**
 * ConsultationService Unit Tests
 *
 * Tests for the ConsultationService that handles consultation lifecycle operations.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConsultationService } from '../consultation.service';
import { ConsultationDtoMapper } from '../consultation.dto.mapper';
import { SysEventType, ResourceStatusType } from '@arcaai/domains';

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
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
};

// TASK-305 D.2 — DepartmentRepository for cross-aggregate tenant check
const mockDepartmentRepository = {
    findById: vi.fn(),
};

// TASK-305 D.2 — UserRoleAssignmentRepository for doctor-in-tenant check
const mockUserRoleAssignmentRepository = {
    findFirst: vi.fn(),
};

// Helper to create mock consultation entity
const createMockConsultationEntity = (overrides: Partial<{
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
}> = {}) => ({
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

        // TASK-305 D.2 — defaults that pass the tenant guard checks. Cross-tenant
        // negative tests override these per-test.
        mockUserRoleAssignmentRepository.findFirst.mockResolvedValue({
            id: 'ura-1',
            userId: 'doctor-1',
            tenantId: 'tenant-1',
            resourceStatus: ResourceStatusType.ENABLED,
        });
        mockDepartmentRepository.findById.mockResolvedValue({
            id: 'dept-1',
            tenantId: 'tenant-1',
        });

        // Create service instance with mocks
        service = new ConsultationService(
            mockConsultationRepository as any,
            mockDepartmentRepository as any,
            mockUserRoleAssignmentRepository as any,
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

            await expect(
                service.getOrCreate({ patientId: 'patient-1' }, 'doctor-1')
            ).rejects.toThrow(BadRequestException);
            await expect(
                service.getOrCreate({ patientId: 'patient-1' }, 'doctor-1')
            ).rejects.toThrow('Tenant ID is required');
        });

        it('should return existing consultation when found', async () => {
            const existingConsultation = createMockConsultationEntity();
            mockConsultationRepository.findByUniqueKey.mockResolvedValue(existingConsultation);

            const result = await service.getOrCreate(
                { patientId: 'patient-1' },
                'doctor-1'
            );

            expect(result.id).toBe('consultation-id-1');
            expect(result.isNew).toBe(false);
            expect(mockConsultationRepository.findByUniqueKey).toHaveBeenCalledWith(
                'tenant-1',
                'patient-1',
                expect.any(Date),
                'doctor-1'
            );
            expect(mockConsultationRepository.create).not.toHaveBeenCalled();
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    resourceId: 'consultation-id-1',
                    data: { action: 'getOrCreate', found: true },
                })
            );
        });

        it('should create new consultation when not found', async () => {
            mockConsultationRepository.findByUniqueKey.mockResolvedValue(null);
            const newConsultation = createMockConsultationEntity({ id: 'new-consultation-id' });
            mockConsultationRepository.create.mockResolvedValue(newConsultation);

            const result = await service.getOrCreate(
                { patientId: 'patient-1' },
                'doctor-1'
            );

            expect(result.id).toBe('new-consultation-id');
            expect(result.isNew).toBe(true);
            expect(mockConsultationRepository.create).toHaveBeenCalled();
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceCreated,
                expect.objectContaining({
                    resourceId: 'new-consultation-id',
                    data: { action: 'getOrCreate', created: true },
                })
            );
        });

        it('should use provided appointment date', async () => {
            mockConsultationRepository.findByUniqueKey.mockResolvedValue(null);
            const newConsultation = createMockConsultationEntity();
            mockConsultationRepository.create.mockResolvedValue(newConsultation);

            await service.getOrCreate(
                { patientId: 'patient-1', appointmentDate: '2026-02-15' },
                'doctor-1'
            );

            expect(mockConsultationRepository.findByUniqueKey).toHaveBeenCalledWith(
                'tenant-1',
                'patient-1',
                new Date('2026-02-15'),
                'doctor-1'
            );
        });

        it('should use today date when appointment date not provided', async () => {
            mockConsultationRepository.findByUniqueKey.mockResolvedValue(null);
            const newConsultation = createMockConsultationEntity();
            mockConsultationRepository.create.mockResolvedValue(newConsultation);

            await service.getOrCreate({ patientId: 'patient-1' }, 'doctor-1');

            // Should use today's date (date part only, no time)
            const today = new Date(new Date().toISOString().split('T')[0]);
            expect(mockConsultationRepository.findByUniqueKey).toHaveBeenCalledWith(
                'tenant-1',
                'patient-1',
                today,
                'doctor-1'
            );
        });

        it('should set parentConsultationId when provided', async () => {
            mockConsultationRepository.findByUniqueKey.mockResolvedValue(null);
            // TASK-305 D.2 — parent must be resolvable and live in caller's tenant.
            mockConsultationRepository.findById.mockResolvedValue(
                createMockConsultationEntity({ id: 'parent-consultation-id' }),
            );
            const newConsultation = createMockConsultationEntity({
                parentConsultationId: 'parent-consultation-id',
            });
            mockConsultationRepository.create.mockResolvedValue(newConsultation);

            await service.getOrCreate(
                { patientId: 'patient-1', parentConsultationId: 'parent-consultation-id' },
                'doctor-1'
            );

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
                'doctor-1'
            );

            expect(mockConsultationRepository.create).toHaveBeenCalled();
        });

        it('should handle invalid date format gracefully', async () => {
            mockConsultationRepository.findByUniqueKey.mockResolvedValue(null);
            const newConsultation = createMockConsultationEntity();
            mockConsultationRepository.create.mockResolvedValue(newConsultation);

            // Invalid date should still work (JS Date will handle it)
            await service.getOrCreate(
                { patientId: 'patient-1', appointmentDate: 'invalid-date' },
                'doctor-1'
            );

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
                'doctor-1'
            );

            expect(mockConsultationRepository.create).toHaveBeenCalled();
        });

        it('should handle empty string patientId', async () => {
            mockConsultationRepository.findByUniqueKey.mockResolvedValue(null);
            const newConsultation = createMockConsultationEntity({ patientId: '' });
            mockConsultationRepository.create.mockResolvedValue(newConsultation);

            await service.getOrCreate({ patientId: '' }, 'doctor-1');

            expect(mockConsultationRepository.findByUniqueKey).toHaveBeenCalledWith(
                'tenant-1',
                '',
                expect.any(Date),
                'doctor-1'
            );
        });

        it('should handle special characters in patientId', async () => {
            mockConsultationRepository.findByUniqueKey.mockResolvedValue(null);
            const newConsultation = createMockConsultationEntity({ patientId: 'patient-123-äöü' });
            mockConsultationRepository.create.mockResolvedValue(newConsultation);

            await service.getOrCreate({ patientId: 'patient-123-äöü' }, 'doctor-1');

            expect(mockConsultationRepository.findByUniqueKey).toHaveBeenCalledWith(
                'tenant-1',
                'patient-123-äöü',
                expect.any(Date),
                'doctor-1'
            );
        });
    });

    describe('createRevisit', () => {
        it('should throw BadRequestException when tenant ID is not available', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'tenantId') return null;
                if (key === 'user') return { id: 'user-id-1' };
                return null;
            });

            await expect(
                service.createRevisit({ patientId: 'patient-1' }, 'doctor-1', 'parent-id')
            ).rejects.toThrow(BadRequestException);
        });

        // TASK-305 D.2 — the "parent not found" path is now routed through
        // `assertParentInScope`, which throws `NotFoundException` (no
        // existence leak) instead of `BadRequestException`. This is a
        // behaviour change vs. the previous error type, but it is required
        // to make missing-vs-cross-tenant indistinguishable.
        it('should throw NotFoundException when parent consultation not found', async () => {
            mockConsultationRepository.findById.mockResolvedValue(null);

            await expect(
                service.createRevisit({ patientId: 'patient-1' }, 'doctor-1', 'non-existent-id')
            ).rejects.toThrow(NotFoundException);
            await expect(
                service.createRevisit({ patientId: 'patient-1' }, 'doctor-1', 'non-existent-id')
            ).rejects.toThrow('Resource not found');
        });

        it('should create revisit consultation when parent exists', async () => {
            const parentConsultation = createMockConsultationEntity({ id: 'parent-id' });
            mockConsultationRepository.findById.mockResolvedValue(parentConsultation);
            const newRevisit = createMockConsultationEntity({
                id: 'new-revisit-id',
                parentConsultationId: 'parent-id',
            });
            mockConsultationRepository.create.mockResolvedValue(newRevisit);

            const result = await service.createRevisit(
                { patientId: 'patient-1' },
                'doctor-1',
                'parent-id'
            );

            expect(result.id).toBe('new-revisit-id');
            expect(result.isNew).toBe(true);
            expect(mockConsultationRepository.create).toHaveBeenCalled();
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceCreated,
                expect.objectContaining({
                    resourceId: 'new-revisit-id',
                    data: { action: 'createRevisit', parentId: 'parent-id' },
                })
            );
        });

        it('should use provided appointment date for revisit', async () => {
            const parentConsultation = createMockConsultationEntity();
            mockConsultationRepository.findById.mockResolvedValue(parentConsultation);
            const newRevisit = createMockConsultationEntity({ id: 'new-revisit-id' });
            mockConsultationRepository.create.mockResolvedValue(newRevisit);

            await service.createRevisit(
                { patientId: 'patient-1', appointmentDate: '2026-03-01' },
                'doctor-1',
                'parent-id'
            );

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

            const result = await service.createRevisit(
                { patientId: 'patient-1' },
                'different-doctor',
                'parent-id'
            );

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

            await service.createRevisit(
                { patientId: 'patient-1', metadata: { reason: 'follow-up' } },
                'doctor-1',
                'parent-id'
            );

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

            await service.createRevisit(
                { patientId: 'patient-1', departmentId: 'dept-cardio' },
                'doctor-1',
                'parent-id'
            );

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
                })
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
                })
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
                })
            );
        });
    });

    describe('getByPatientAndDate', () => {
        it('should throw BadRequestException when tenant ID is not available', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'tenantId') return null;
                return null;
            });

            await expect(
                service.getByPatientAndDate('patient-1', '2026-01-29')
            ).rejects.toThrow(BadRequestException);
        });

        it('should return consultations for patient on specific date', async () => {
            const consultations = [
                createMockConsultationEntity({ doctorId: 'doctor-1' }),
                createMockConsultationEntity({ id: 'consultation-2', doctorId: 'doctor-2' }),
            ];
            mockConsultationRepository.findByPatientAndDate.mockResolvedValue(consultations);

            const result = await service.getByPatientAndDate('patient-1', '2026-01-29');

            expect(result).toHaveLength(2);
            expect(mockConsultationRepository.findByPatientAndDate).toHaveBeenCalledWith(
                'tenant-1',
                'patient-1',
                new Date('2026-01-29')
            );
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { patientId: 'patient-1', date: '2026-01-29', count: 2 },
                })
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
                })
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
            mockConsultationRepository.findByUniqueKey
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce(existingConsultation);
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

            expect(mockConsultationRepository.findByUniqueKey).toHaveBeenCalledWith(
                'tenant-1',
                longPatientId,
                expect.any(Date),
                'doctor-1'
            );
        });

        it('should handle null metadata', async () => {
            mockConsultationRepository.findByUniqueKey.mockResolvedValue(null);
            const newConsultation = createMockConsultationEntity({ metadata: null });
            mockConsultationRepository.create.mockResolvedValue(newConsultation);

            await service.getOrCreate(
                { patientId: 'patient-1', metadata: null as any },
                'doctor-1'
            );

            expect(mockConsultationRepository.create).toHaveBeenCalled();
        });

        it('should handle empty metadata object', async () => {
            mockConsultationRepository.findByUniqueKey.mockResolvedValue(null);
            const newConsultation = createMockConsultationEntity({ metadata: {} });
            mockConsultationRepository.create.mockResolvedValue(newConsultation);

            await service.getOrCreate(
                { patientId: 'patient-1', metadata: {} },
                'doctor-1'
            );

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

            await expect(
                service.getPatientHistoryPaginated('patient-1', 1, 20),
            ).rejects.toThrow(BadRequestException);
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
            const consultations = Array.from({ length: 5 }, (_, i) =>
                createMockConsultationEntity({ id: `c-${i + 1}` }),
            );
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

            await expect(
                service.getByPatientAndDatePaginated('patient-1', '2026-02-17', 1, 20),
            ).rejects.toThrow(BadRequestException);
        });
    });

    // ============================================================
    // TASK-305 D.2 — Cross-aggregate tenant isolation
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
    describe('TASK-305 D.2 — cross-aggregate tenant checks', () => {
        describe('getOrCreate', () => {
            it('throws NotFoundException when doctorId has no role-assignment in caller tenant', async () => {
                mockConsultationRepository.findByUniqueKey.mockResolvedValue(null);
                mockUserRoleAssignmentRepository.findFirst.mockResolvedValue(null);

                await expect(
                    service.getOrCreate({ patientId: 'patient-1' }, 'cross-tenant-doctor'),
                ).rejects.toThrow(NotFoundException);
                await expect(
                    service.getOrCreate({ patientId: 'patient-1' }, 'cross-tenant-doctor'),
                ).rejects.toThrow('Resource not found');

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

                await expect(
                    service.getOrCreate(
                        { patientId: 'patient-1', departmentId: 'dept-other' },
                        'doctor-1',
                    ),
                ).rejects.toThrow(NotFoundException);
                await expect(
                    service.getOrCreate(
                        { patientId: 'patient-1', departmentId: 'dept-other' },
                        'doctor-1',
                    ),
                ).rejects.toThrow('Resource not found');

                expect(mockConsultationRepository.create).not.toHaveBeenCalled();
            });

            it('throws NotFoundException when departmentId does not exist (no existence leak)', async () => {
                mockConsultationRepository.findByUniqueKey.mockResolvedValue(null);
                mockDepartmentRepository.findById.mockResolvedValue(null);

                await expect(
                    service.getOrCreate(
                        { patientId: 'patient-1', departmentId: 'no-such-dept' },
                        'doctor-1',
                    ),
                ).rejects.toThrow(NotFoundException);
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

                await expect(
                    service.getOrCreate(
                        { patientId: 'patient-1', parentConsultationId: 'parent-other' },
                        'doctor-1',
                    ),
                ).rejects.toThrow(NotFoundException);
                await expect(
                    service.getOrCreate(
                        { patientId: 'patient-1', parentConsultationId: 'parent-other' },
                        'doctor-1',
                    ),
                ).rejects.toThrow('Resource not found');

                expect(mockConsultationRepository.create).not.toHaveBeenCalled();
            });

            it('throws NotFoundException when parentConsultationId does not exist (no existence leak)', async () => {
                mockConsultationRepository.findByUniqueKey.mockResolvedValue(null);
                mockConsultationRepository.findById.mockResolvedValue(null);

                await expect(
                    service.getOrCreate(
                        { patientId: 'patient-1', parentConsultationId: 'no-such-parent' },
                        'doctor-1',
                    ),
                ).rejects.toThrow(NotFoundException);
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
                mockConsultationRepository.findById.mockResolvedValue(
                    createMockConsultationEntity({ id: 'parent-id' }),
                );
                mockUserRoleAssignmentRepository.findFirst.mockResolvedValue(null);

                await expect(
                    service.createRevisit(
                        { patientId: 'patient-1' },
                        'cross-tenant-doctor',
                        'parent-id',
                    ),
                ).rejects.toThrow(NotFoundException);
                expect(mockConsultationRepository.create).not.toHaveBeenCalled();
            });

            it('throws NotFoundException when departmentId belongs to another tenant', async () => {
                mockConsultationRepository.findById.mockResolvedValue(
                    createMockConsultationEntity({ id: 'parent-id' }),
                );
                mockDepartmentRepository.findById.mockResolvedValue({
                    id: 'dept-other',
                    tenantId: 'tenant-OTHER',
                });

                await expect(
                    service.createRevisit(
                        { patientId: 'patient-1', departmentId: 'dept-other' },
                        'doctor-1',
                        'parent-id',
                    ),
                ).rejects.toThrow(NotFoundException);
                expect(mockConsultationRepository.create).not.toHaveBeenCalled();
            });

            it('throws NotFoundException when parentConsultationId belongs to another tenant (audit C-4)', async () => {
                mockConsultationRepository.findById.mockResolvedValue(
                    createMockConsultationEntity({
                        id: 'parent-other',
                        tenantId: 'tenant-OTHER',
                    }),
                );

                await expect(
                    service.createRevisit(
                        { patientId: 'patient-1' },
                        'doctor-1',
                        'parent-other',
                    ),
                ).rejects.toThrow(NotFoundException);
                await expect(
                    service.createRevisit(
                        { patientId: 'patient-1' },
                        'doctor-1',
                        'parent-other',
                    ),
                ).rejects.toThrow('Resource not found');

                expect(mockConsultationRepository.create).not.toHaveBeenCalled();
            });
        });
    });

    // ============================================================
    // TASK-306 P2.1 (audit C-1 / AC-8) — Consultation read-paths
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
    describe('TASK-306 P2.1 — Consultation read-paths defense-in-depth', () => {
        describe('getById', () => {
            it('returns DTO when the fetched entity tenant matches caller CLS tenant (sanity)', async () => {
                const consultation = createMockConsultationEntity({
                    id: 'consultation-id-1',
                    tenantId: 'tenant-1',
                });
                mockConsultationRepository.findWithContext.mockResolvedValue(consultation);

                const result = await service.getById('consultation-id-1');

                expect(result).not.toBeNull();
                expect(result?.id).toBe('consultation-id-1');
                expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                    SysEventType.ResourceViewed,
                    expect.objectContaining({ resourceId: 'consultation-id-1' }),
                );
            });

            it('throws NotFoundException with generic message when the fetched entity belongs to another tenant', async () => {
                const foreign = createMockConsultationEntity({
                    id: 'consultation-id-foreign',
                    tenantId: 'tenant-OTHER',
                });
                mockConsultationRepository.findWithContext.mockResolvedValue(foreign);

                await expect(
                    service.getById('consultation-id-foreign'),
                ).rejects.toThrow(NotFoundException);
                await expect(
                    service.getById('consultation-id-foreign'),
                ).rejects.toThrow('Resource not found');

                // Guard must short-circuit BEFORE the SysEvent broadcast: the
                // caller never sees a `ResourceViewed` event for a row they
                // should not be aware of.
                expect(mockEventEmitter.emit).not.toHaveBeenCalled();
            });

            it('throws fail-closed when CLS tenantId is missing and the repo returns a row', async () => {
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

                // `assertEqualTenants` raises BadRequestException when either
                // side's tenantId is missing — background / unprovisioned
                // contexts must fail closed rather than leak the row.
                await expect(
                    service.getById('consultation-id-1'),
                ).rejects.toThrow(BadRequestException);

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

                await expect(
                    service.getByIdWithRelations('consultation-id-foreign'),
                ).rejects.toThrow(NotFoundException);
                await expect(
                    service.getByIdWithRelations('consultation-id-foreign'),
                ).rejects.toThrow('Resource not found');

                // Guard must short-circuit BEFORE the SysEvent broadcast so
                // the caller never sees a `ResourceViewed` for relations
                // they should not be aware of.
                expect(mockEventEmitter.emit).not.toHaveBeenCalled();
            });

            it('throws fail-closed when CLS tenantId is missing and the repo returns a row', async () => {
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

                await expect(
                    service.getByIdWithRelations('consultation-id-1'),
                ).rejects.toThrow(BadRequestException);

                expect(mockEventEmitter.emit).not.toHaveBeenCalled();
            });
        });

        describe('getConsultationChain', () => {
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

                await expect(
                    service.getConsultationChain('foreign-parent'),
                ).rejects.toThrow(NotFoundException);
                await expect(
                    service.getConsultationChain('foreign-parent'),
                ).rejects.toThrow('Resource not found');

                expect(mockEventEmitter.emit).not.toHaveBeenCalled();
            });

            it('throws fail-closed when CLS tenantId is missing', async () => {
                mockClsService.get.mockImplementation((key: string) => {
                    if (key === 'tenantId') return null;
                    if (key === 'user') return { id: 'user-id-1' };
                    return null;
                });

                await expect(
                    service.getConsultationChain('any-id'),
                ).rejects.toThrow(BadRequestException);

                // Fail-closed must short-circuit BEFORE the repo round-trip.
                expect(mockConsultationRepository.findConsultationChain).not.toHaveBeenCalled();
            });
        });
    });
});
