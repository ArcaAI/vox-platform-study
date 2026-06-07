import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { ConsultationController } from '../consultation.controller';

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const DOCTOR_A = 'doctor-a-id';
const DOCTOR_B = 'doctor-b-id';
const TENANT_ID = 'tenant-1';
const PATIENT_SHARED = 'patient-shared';
const PATIENT_UNRELATED = 'patient-unrelated';
const CONSULTATION_OWN = 'consult-own';
const CONSULTATION_OTHER = 'consult-other';
const CONSULTATION_MISSING = 'consult-missing';

function makeConsultation(overrides: Record<string, unknown> = {}) {
    return {
        id: CONSULTATION_OWN,
        doctorId: DOCTOR_A,
        patientId: PATIENT_SHARED,
        tenantId: TENANT_ID,
        appointmentDate: '2026-03-01',
        ...overrides,
    };
}

// ─── Mock Factories ─────────────────────────────────────────────────────────

function createMockConsultationService() {
    return {
        getById: vi.fn(),
        getByIdWithRelations: vi.fn(),
        getOrCreate: vi.fn(),
        listConsultations: vi.fn(),
        getPatientHistoryPaginated: vi.fn(),
        getByPatientAndDate: vi.fn(),
        getConsultationChain: vi.fn(),
        doctorHasPatientRelationship: vi.fn(),
        closeConsultation: vi.fn(),
        reopenConsultation: vi.fn(),
        updateConsultation: vi.fn(),
    };
}

function createMockContextService() {
    return {
        addContext: vi.fn(),
        addAudioRecording: vi.fn(),
        getAudioRecordings: vi.fn(),
        getContextItems: vi.fn(),
        getSharedContext: vi.fn(),
        getTranscriptions: vi.fn(),
        updateContext: vi.fn(),
        getVersionHistory: vi.fn(),
        getVersion: vi.fn(),
        getAggregateNamedEntities: vi.fn(),
    };
}

function createMockSummaryService() {
    return {
        generateSummary: vi.fn(),
        getSummaries: vi.fn(),
        generatePreSummary: vi.fn(),
        getLatestSummary: vi.fn(),
        getLatestPreSummary: vi.fn(),
        updateSummary: vi.fn(),
        extractEntities: vi.fn(),
        approveSummary: vi.fn(),
        getSummaryProvenance: vi.fn(),
    };
}

function createMockChainSummaryService() {
    return { generateComprehensiveSummary: vi.fn() };
}

function createMockJobService() {
    return {
        createSummaryJob: vi.fn(),
        createPreSummaryJob: vi.fn(),
        createComprehensiveSummaryJob: vi.fn(),
    };
}

function createMockTimelineService() {
    return { getTimeline: vi.fn() };
}

function createMockCls(userId: string | null = DOCTOR_A, tenantId: string | null = TENANT_ID, ability?: unknown) {
    return {
        get: vi.fn((key: string) => {
            if (key === 'user') return userId ? { id: userId, tenantId } : null;
            if (key === 'tenantId') return tenantId;
            if (key === 'userAbility') return ability ?? undefined;
            return undefined;
        }),
    };
}

function createMockPolicyEngine(canResult = false, cannotResult = true) {
    return {
        can: vi.fn().mockReturnValue(canResult),
        cannot: vi.fn().mockReturnValue(cannotResult),
        buildAbility: vi.fn(),
        getAccessibleBy: vi.fn(),
        getPermittedFields: vi.fn(),
    };
}

function createMockGlobalSettingRepo(sharingEnabled = true) {
    return {
        findAll: vi.fn().mockResolvedValue(
            sharingEnabled
                ? [{ value: 'true', key: 'enable-consultation-sharing' }]
                : [{ value: 'false', key: 'enable-consultation-sharing' }],
        ),
    };
}

function buildController(overrides: {
    userId?: string | null;
    tenantId?: string | null;
    ability?: unknown;
    sharingEnabled?: boolean;
    policyCanRead?: boolean;
    policyCanManage?: boolean;
} = {}) {
    const {
        userId = DOCTOR_A,
        tenantId = TENANT_ID,
        ability = { can: vi.fn() },
        sharingEnabled = true,
        policyCanRead = false,
        policyCanManage = false,
    } = overrides;

    const consultationService = createMockConsultationService();
    const contextService = createMockContextService();
    const summaryService = createMockSummaryService();
    const chainSummaryService = createMockChainSummaryService();
    const jobService = createMockJobService();
    const timelineService = createMockTimelineService();
    const cls = createMockCls(userId, tenantId, ability);
    const policyEngine = createMockPolicyEngine();
    policyEngine.can.mockImplementation((_ability: unknown, action: string) => {
        if (action === 'read') return policyCanRead;
        if (action === 'manage') return policyCanManage;
        return false;
    });
    const globalSettingRepo = createMockGlobalSettingRepo(sharingEnabled);

    const controller = new ConsultationController(
        consultationService as any,
        contextService as any,
        summaryService as any,
        chainSummaryService as any,
        jobService as any,
        timelineService as any,
        cls as any,
        policyEngine as any,
        globalSettingRepo as any,
    );

    return {
        controller,
        consultationService,
        contextService,
        summaryService,
        chainSummaryService,
        jobService,
        timelineService,
        cls,
        policyEngine,
        globalSettingRepo,
    };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('ConsultationController', () => {

    // ═══════════════════════════════════════════════════════════════════════
    // getDoctorId — user context extraction
    // ═══════════════════════════════════════════════════════════════════════

    describe('getDoctorId (user context)', () => {
        it('should throw UnauthorizedException when user context is null', async () => {
            const { controller, consultationService } = buildController({ userId: null });
            consultationService.getOrCreate.mockResolvedValue(makeConsultation());

            await expect(
                controller.open({ patientId: PATIENT_SHARED } as any),
            ).rejects.toThrow(UnauthorizedException);
        });

        it('should extract doctorId from CLS user context', async () => {
            const { controller, consultationService } = buildController({ userId: DOCTOR_A });
            consultationService.getOrCreate.mockResolvedValue(makeConsultation());

            await controller.open({ patientId: PATIENT_SHARED } as any);

            expect(consultationService.getOrCreate).toHaveBeenCalledWith(
                expect.anything(),
                DOCTOR_A,
            );
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // verifyConsultationAccess — two-layer READ access
    // ═══════════════════════════════════════════════════════════════════════

    describe('verifyConsultationAccess (READ)', () => {

        it('should throw NotFoundException when consultation does not exist', async () => {
            const { controller, consultationService } = buildController();
            consultationService.getById.mockResolvedValue(null);

            await expect(controller.getById(CONSULTATION_MISSING)).rejects.toThrow(
                NotFoundException,
            );
        });

        describe('Layer 1: owner check', () => {
            it('should allow access when caller is the assigned doctor', async () => {
                const { controller, consultationService } = buildController();
                const consultation = makeConsultation({ doctorId: DOCTOR_A });
                consultationService.getById.mockResolvedValue(consultation);
                consultationService.getByIdWithRelations.mockResolvedValue(consultation);

                const result = await controller.getById(CONSULTATION_OWN);

                expect(result).toEqual(consultation);
            });
        });

        describe('Layer 1b: CASL ability bypass', () => {
            it('should allow access when CASL grants read permission (e.g., tenant-admin)', async () => {
                const { controller, consultationService, policyEngine } = buildController({
                    userId: DOCTOR_B,
                    policyCanRead: true,
                });
                const consultation = makeConsultation({ doctorId: DOCTOR_A });
                consultationService.getById.mockResolvedValue(consultation);
                consultationService.getByIdWithRelations.mockResolvedValue(consultation);

                const result = await controller.getById(CONSULTATION_OWN);

                expect(result).toEqual(consultation);
                expect(policyEngine.can).toHaveBeenCalledWith(
                    expect.anything(),
                    'read',
                    'Consultation',
                    expect.objectContaining({ tenantId: TENANT_ID }),
                );
            });
        });

        describe('Layer 2: shared-patient fallback', () => {
            it('should allow access when sharing is enabled and doctor has shared patient', async () => {
                const { controller, consultationService } = buildController({
                    userId: DOCTOR_B,
                    sharingEnabled: true,
                });
                const consultation = makeConsultation({ doctorId: DOCTOR_A, patientId: PATIENT_SHARED });
                consultationService.getById.mockResolvedValue(consultation);
                consultationService.getByIdWithRelations.mockResolvedValue(consultation);
                consultationService.doctorHasPatientRelationship.mockResolvedValue(true);

                const result = await controller.getById(CONSULTATION_OWN);

                expect(result).toEqual(consultation);
                expect(consultationService.doctorHasPatientRelationship).toHaveBeenCalledWith(
                    DOCTOR_B,
                    PATIENT_SHARED,
                    TENANT_ID,
                );
            });

            it('should deny access when sharing is enabled but doctor has no shared patient', async () => {
                const { controller, consultationService } = buildController({
                    userId: DOCTOR_B,
                    sharingEnabled: true,
                });
                const consultation = makeConsultation({ doctorId: DOCTOR_A, patientId: PATIENT_UNRELATED });
                consultationService.getById.mockResolvedValue(consultation);
                consultationService.doctorHasPatientRelationship.mockResolvedValue(false);

                await expect(controller.getById(CONSULTATION_OWN)).rejects.toThrow(
                    ForbiddenException,
                );
            });

            it('should deny access when sharing is disabled even if doctor has shared patient', async () => {
                const { controller, consultationService } = buildController({
                    userId: DOCTOR_B,
                    sharingEnabled: false,
                });
                const consultation = makeConsultation({ doctorId: DOCTOR_A });
                consultationService.getById.mockResolvedValue(consultation);

                await expect(controller.getById(CONSULTATION_OWN)).rejects.toThrow(
                    ForbiddenException,
                );
                expect(consultationService.doctorHasPatientRelationship).not.toHaveBeenCalled();
            });
        });

        describe('edge cases', () => {
            it('should deny access when no ability is set and sharing is disabled', async () => {
                const { controller, consultationService } = buildController({
                    userId: DOCTOR_B,
                    ability: undefined,
                    sharingEnabled: false,
                });
                const consultation = makeConsultation({ doctorId: DOCTOR_A });
                consultationService.getById.mockResolvedValue(consultation);

                await expect(controller.getById(CONSULTATION_OWN)).rejects.toThrow(
                    ForbiddenException,
                );
            });

            it('TASK-307 W5.4 — should default to sharing CLOSED when globalSettingRepo throws (fail-closed)', async () => {
                const { controller, consultationService, globalSettingRepo } = buildController({
                    userId: DOCTOR_B,
                });
                const consultation = makeConsultation({ doctorId: DOCTOR_A });
                consultationService.getById.mockResolvedValue(consultation);
                consultationService.getByIdWithRelations.mockResolvedValue(consultation);
                consultationService.doctorHasPatientRelationship.mockResolvedValue(true);
                globalSettingRepo.findAll.mockRejectedValue(new Error('DB error'));

                await expect(controller.getById(CONSULTATION_OWN)).rejects.toThrow(
                    ForbiddenException,
                );
                expect(consultationService.doctorHasPatientRelationship).not.toHaveBeenCalled();
            });

            it('should deny access when tenantId is null and sharing check runs', async () => {
                const { controller, consultationService } = buildController({
                    userId: DOCTOR_B,
                    tenantId: null,
                    sharingEnabled: true,
                });
                const consultation = makeConsultation({ doctorId: DOCTOR_A });
                consultationService.getById.mockResolvedValue(consultation);

                await expect(controller.getById(CONSULTATION_OWN)).rejects.toThrow(
                    ForbiddenException,
                );
            });
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // verifyConsultationOwnership — WRITE access
    // ═══════════════════════════════════════════════════════════════════════

    describe('verifyConsultationOwnership (WRITE)', () => {

        it('should throw NotFoundException when consultation does not exist', async () => {
            const { controller, consultationService } = buildController();
            consultationService.getById.mockResolvedValue(null);

            await expect(
                controller.addContext(CONSULTATION_MISSING, {} as any),
            ).rejects.toThrow(NotFoundException);
        });

        describe('Layer 1: owner check', () => {
            it('should allow mutation when caller is the assigned doctor', async () => {
                const { controller, consultationService, contextService } = buildController();
                const consultation = makeConsultation({ doctorId: DOCTOR_A });
                consultationService.getById.mockResolvedValue(consultation);
                contextService.addContext.mockResolvedValue({ id: 'ctx-1' });

                const result = await controller.addContext(CONSULTATION_OWN, {} as any);

                expect(result).toEqual({ id: 'ctx-1' });
            });

            it('addRecording threads raw/processed media ids to the context service (TASK-329 X8)', async () => {
                const { controller, consultationService, contextService } = buildController();
                consultationService.getById.mockResolvedValue(makeConsultation({ doctorId: DOCTOR_A }));
                contextService.addAudioRecording.mockResolvedValue({ id: 'ctx-audio-1' });

                const request = { mediaId: 'm-primary', rawMediaId: 'm-raw', processedMediaId: 'm-processed' } as any;
                const result = await controller.addRecording(CONSULTATION_OWN, request);

                expect(result).toEqual({ id: 'ctx-audio-1' });
                expect(contextService.addAudioRecording).toHaveBeenCalledWith(CONSULTATION_OWN, request);
            });

            it('getRecordings returns the recordings list for an authorized reader', async () => {
                const { controller, consultationService, contextService } = buildController();
                consultationService.getById.mockResolvedValue(makeConsultation({ doctorId: DOCTOR_A }));
                contextService.getAudioRecordings.mockResolvedValue([{ id: 'ar-1' }, { id: 'ar-2' }]);

                const result = await controller.getRecordings(CONSULTATION_OWN);

                expect(result).toEqual([{ id: 'ar-1' }, { id: 'ar-2' }]);
                expect(contextService.getAudioRecordings).toHaveBeenCalledWith(CONSULTATION_OWN);
            });
        });

        describe('Layer 1b: CASL manage bypass', () => {
            it('should allow mutation when CASL grants manage permission (e.g., tenant-admin)', async () => {
                const { controller, consultationService, contextService, policyEngine } = buildController({
                    userId: DOCTOR_B,
                    policyCanManage: true,
                });
                const consultation = makeConsultation({ doctorId: DOCTOR_A });
                consultationService.getById.mockResolvedValue(consultation);
                contextService.addContext.mockResolvedValue({ id: 'ctx-1' });

                const result = await controller.addContext(CONSULTATION_OWN, {} as any);

                expect(result).toEqual({ id: 'ctx-1' });
                expect(policyEngine.can).toHaveBeenCalledWith(
                    expect.anything(),
                    'manage',
                    'Consultation',
                    expect.objectContaining({ tenantId: TENANT_ID }),
                );
            });
        });

        describe('shared-patient doctors NEVER get write access', () => {
            it('should deny mutation even when doctor has shared patient and sharing is enabled', async () => {
                const { controller, consultationService } = buildController({
                    userId: DOCTOR_B,
                    sharingEnabled: true,
                    policyCanManage: false,
                });
                const consultation = makeConsultation({ doctorId: DOCTOR_A });
                consultationService.getById.mockResolvedValue(consultation);
                consultationService.doctorHasPatientRelationship.mockResolvedValue(true);

                await expect(
                    controller.addContext(CONSULTATION_OWN, {} as any),
                ).rejects.toThrow(ForbiddenException);
                await expect(
                    controller.addContext(CONSULTATION_OWN, {} as any),
                ).rejects.toThrow('Only the assigned doctor can modify this consultation');
            });

            it('should deny mutation when non-owner has no CASL manage permission', async () => {
                const { controller, consultationService } = buildController({
                    userId: DOCTOR_B,
                    policyCanManage: false,
                });
                const consultation = makeConsultation({ doctorId: DOCTOR_A });
                consultationService.getById.mockResolvedValue(consultation);

                await expect(
                    controller.updateContext(CONSULTATION_OWN, 'ctx-1', {} as any),
                ).rejects.toThrow(ForbiddenException);
            });
        });

        describe('edge cases', () => {
            it('should deny mutation when no ability is set and caller is not owner', async () => {
                const { controller, consultationService } = buildController({
                    userId: DOCTOR_B,
                    ability: undefined,
                });
                const consultation = makeConsultation({ doctorId: DOCTOR_A });
                consultationService.getById.mockResolvedValue(consultation);

                await expect(
                    controller.addContext(CONSULTATION_OWN, {} as any),
                ).rejects.toThrow(ForbiddenException);
            });
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // verifyPatientAccess — patient-level data
    // ═══════════════════════════════════════════════════════════════════════

    describe('verifyPatientAccess', () => {
        it('should allow access when doctor has relationship with patient', async () => {
            const { controller, consultationService } = buildController();
            consultationService.doctorHasPatientRelationship.mockResolvedValue(true);
            consultationService.getPatientHistoryPaginated.mockResolvedValue({
                data: [],
                count: 0,
                page: 1,
                limit: 10,
            });

            const result = await controller.getPatientHistory(PATIENT_SHARED, { page: 1, limit: 10 } as any);

            expect(result.data).toEqual([]);
            expect(consultationService.doctorHasPatientRelationship).toHaveBeenCalledWith(
                DOCTOR_A,
                PATIENT_SHARED,
                TENANT_ID,
            );
        });

        it('should deny access when doctor has no relationship with patient', async () => {
            const { controller, consultationService } = buildController();
            consultationService.doctorHasPatientRelationship.mockResolvedValue(false);

            await expect(
                controller.getPatientHistory(PATIENT_UNRELATED, {} as any),
            ).rejects.toThrow(ForbiddenException);
        });

        it('should deny access when tenantId is empty', async () => {
            const { controller, consultationService } = buildController({ tenantId: null });
            consultationService.doctorHasPatientRelationship.mockResolvedValue(false);

            await expect(
                controller.getPatientHistory(PATIENT_SHARED, {} as any),
            ).rejects.toThrow(ForbiddenException);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // isSharingEnabled — feature flag
    // ═══════════════════════════════════════════════════════════════════════

    describe('isSharingEnabled (feature flag)', () => {
        it('should return false when tenantId is null', async () => {
            const { controller, consultationService } = buildController({
                userId: DOCTOR_B,
                tenantId: null,
            });
            const consultation = makeConsultation({ doctorId: DOCTOR_A });
            consultationService.getById.mockResolvedValue(consultation);

            await expect(controller.getById(CONSULTATION_OWN)).rejects.toThrow(
                ForbiddenException,
            );
        });

        it('should return true when setting value is "true"', async () => {
            const { controller, consultationService } = buildController({
                userId: DOCTOR_B,
                sharingEnabled: true,
            });
            const consultation = makeConsultation({ doctorId: DOCTOR_A });
            consultationService.getById.mockResolvedValue(consultation);
            consultationService.getByIdWithRelations.mockResolvedValue(consultation);
            consultationService.doctorHasPatientRelationship.mockResolvedValue(true);

            await controller.getById(CONSULTATION_OWN);

            expect(consultationService.doctorHasPatientRelationship).toHaveBeenCalled();
        });

        it('should return false when setting value is "false"', async () => {
            const { controller, consultationService } = buildController({
                userId: DOCTOR_B,
                sharingEnabled: false,
            });
            const consultation = makeConsultation({ doctorId: DOCTOR_A });
            consultationService.getById.mockResolvedValue(consultation);

            await expect(controller.getById(CONSULTATION_OWN)).rejects.toThrow(
                ForbiddenException,
            );
            expect(consultationService.doctorHasPatientRelationship).not.toHaveBeenCalled();
        });

        // TASK-307 W5.4 — flag must be default-CLOSED (AC-18, audit D-2).
        // Previously the missing-setting path returned `true` (default-OPEN)
        // which silently enabled shared-patient reads for tenants that had
        // never made a sharing decision.
        it('TASK-307 W5.4 — defaults FALSE when globalSettingRepo returns empty array (default-CLOSED)', async () => {
            const { controller, consultationService, globalSettingRepo } = buildController({
                userId: DOCTOR_B,
            });
            const consultation = makeConsultation({ doctorId: DOCTOR_A });
            consultationService.getById.mockResolvedValue(consultation);
            globalSettingRepo.findAll.mockResolvedValue([]);

            await expect(controller.getById(CONSULTATION_OWN)).rejects.toThrow(
                ForbiddenException,
            );
            // Sharing is off → fallback short-circuits BEFORE the
            // relationship lookup runs.
            expect(consultationService.doctorHasPatientRelationship).not.toHaveBeenCalled();
        });

        it('TASK-307 W5.4 — defaults FALSE when the GlobalSetting repository throws (fail-closed)', async () => {
            const { controller, consultationService, globalSettingRepo } = buildController({
                userId: DOCTOR_B,
            });
            const consultation = makeConsultation({ doctorId: DOCTOR_A });
            consultationService.getById.mockResolvedValue(consultation);
            globalSettingRepo.findAll.mockRejectedValue(new Error('DB unavailable'));

            await expect(controller.getById(CONSULTATION_OWN)).rejects.toThrow(
                ForbiddenException,
            );
            expect(consultationService.doctorHasPatientRelationship).not.toHaveBeenCalled();
        });

        it('TASK-307 W5.4 — returns FALSE for non-"true" truthy strings (strict equality)', async () => {
            const cases = ['TRUE', '1', 'yes', 'on', ' true', ''];
            for (const value of cases) {
                const { controller, consultationService, globalSettingRepo } = buildController({
                    userId: DOCTOR_B,
                });
                const consultation = makeConsultation({ doctorId: DOCTOR_A });
                consultationService.getById.mockResolvedValue(consultation);
                globalSettingRepo.findAll.mockResolvedValue([
                    { value, key: 'enable-consultation-sharing' },
                ]);

                await expect(controller.getById(CONSULTATION_OWN)).rejects.toThrow(
                    ForbiddenException,
                );
                expect(consultationService.doctorHasPatientRelationship).not.toHaveBeenCalled();
            }
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Endpoint wiring — read endpoints use verifyConsultationAccess
    // ═══════════════════════════════════════════════════════════════════════

    describe('read endpoints use verifyConsultationAccess', () => {
        let controller: ConsultationController;
        let consultationService: ReturnType<typeof createMockConsultationService>;
        let contextService: ReturnType<typeof createMockContextService>;
        let summaryService: ReturnType<typeof createMockSummaryService>;
        let timelineService: ReturnType<typeof createMockTimelineService>;

        beforeEach(() => {
            const built = buildController({ userId: DOCTOR_B, sharingEnabled: false });
            controller = built.controller;
            consultationService = built.consultationService;
            contextService = built.contextService;
            summaryService = built.summaryService;
            timelineService = built.timelineService;

            const otherDoctorConsultation = makeConsultation({ doctorId: DOCTOR_A });
            consultationService.getById.mockResolvedValue(otherDoctorConsultation);
        });

        it('getById should enforce read access', async () => {
            await expect(controller.getById(CONSULTATION_OWN)).rejects.toThrow(ForbiddenException);
        });

        it('getChain should enforce read access', async () => {
            await expect(controller.getChain(CONSULTATION_OWN)).rejects.toThrow(ForbiddenException);
        });

        it('getTimeline should enforce read access', async () => {
            await expect(controller.getTimeline(CONSULTATION_OWN)).rejects.toThrow(ForbiddenException);
        });

        it('getContextItems should enforce read access', async () => {
            await expect(controller.getContextItems(CONSULTATION_OWN)).rejects.toThrow(ForbiddenException);
        });

        it('getSharedContext should enforce read access', async () => {
            await expect(controller.getSharedContext(CONSULTATION_OWN)).rejects.toThrow(ForbiddenException);
        });

        it('getTranscriptions should enforce read access', async () => {
            await expect(controller.getTranscriptions(CONSULTATION_OWN)).rejects.toThrow(ForbiddenException);
        });

        it('getCaseNotes should enforce read access', async () => {
            await expect(controller.getCaseNotes(CONSULTATION_OWN)).rejects.toThrow(ForbiddenException);
        });

        it('getRecordings should enforce read access', async () => {
            await expect(controller.getRecordings(CONSULTATION_OWN)).rejects.toThrow(ForbiddenException);
        });

        it('getContextVersions should enforce read access', async () => {
            await expect(controller.getContextVersions(CONSULTATION_OWN, 'ctx-1')).rejects.toThrow(ForbiddenException);
        });

        it('getContextVersion should enforce read access', async () => {
            await expect(controller.getContextVersion(CONSULTATION_OWN, 'ctx-1', '1')).rejects.toThrow(ForbiddenException);
        });

        it('getSummaries should enforce read access', async () => {
            await expect(controller.getSummaries(CONSULTATION_OWN)).rejects.toThrow(ForbiddenException);
        });

        it('getLatestSummary should enforce read access', async () => {
            await expect(controller.getLatestSummary(CONSULTATION_OWN)).rejects.toThrow(ForbiddenException);
        });

        it('getLatestPreSummary should enforce read access', async () => {
            await expect(controller.getLatestPreSummary(CONSULTATION_OWN)).rejects.toThrow(ForbiddenException);
        });

        it('getSummaryVersions should enforce read access', async () => {
            await expect(controller.getSummaryVersions(CONSULTATION_OWN, 'ctx-1')).rejects.toThrow(ForbiddenException);
        });

        it('getSummaryProvenance should enforce read access', async () => {
            await expect(controller.getSummaryProvenance(CONSULTATION_OWN, 'ctx-1')).rejects.toThrow(ForbiddenException);
        });

        it('getNamedEntities should enforce read access', async () => {
            await expect(controller.getNamedEntities(CONSULTATION_OWN)).rejects.toThrow(ForbiddenException);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Endpoint wiring — write endpoints use verifyConsultationOwnership
    // ═══════════════════════════════════════════════════════════════════════

    describe('write endpoints use verifyConsultationOwnership', () => {
        let controller: ConsultationController;
        let consultationService: ReturnType<typeof createMockConsultationService>;

        beforeEach(() => {
            const built = buildController({ userId: DOCTOR_B, policyCanManage: false });
            controller = built.controller;
            consultationService = built.consultationService;

            const otherDoctorConsultation = makeConsultation({ doctorId: DOCTOR_A });
            consultationService.getById.mockResolvedValue(otherDoctorConsultation);
        });

        it('addContext should enforce ownership', async () => {
            await expect(controller.addContext(CONSULTATION_OWN, {} as any)).rejects.toThrow(ForbiddenException);
        });

        it('addRecording should enforce ownership', async () => {
            await expect(controller.addRecording(CONSULTATION_OWN, {} as any)).rejects.toThrow(ForbiddenException);
        });

        it('updateContext should enforce ownership', async () => {
            await expect(controller.updateContext(CONSULTATION_OWN, 'ctx-1', {} as any)).rejects.toThrow(ForbiddenException);
        });

        it('generateSummary should enforce ownership', async () => {
            await expect(controller.generateSummary(CONSULTATION_OWN, {} as any)).rejects.toThrow(ForbiddenException);
        });

        it('generatePreSummary should enforce ownership', async () => {
            await expect(controller.generatePreSummary(CONSULTATION_OWN, {} as any)).rejects.toThrow(ForbiddenException);
        });

        it('updateSummary should enforce ownership', async () => {
            await expect(controller.updateSummary(CONSULTATION_OWN, 'sum-1', {} as any)).rejects.toThrow(ForbiddenException);
        });

        it('extractEntities should enforce ownership', async () => {
            await expect(controller.extractEntities(CONSULTATION_OWN, 'ctx-1')).rejects.toThrow(ForbiddenException);
        });

        it('generateSummaryAsync should enforce ownership', async () => {
            await expect(controller.generateSummaryAsync(CONSULTATION_OWN, {} as any)).rejects.toThrow(ForbiddenException);
        });

        it('generatePreSummaryAsync should enforce ownership', async () => {
            await expect(controller.generatePreSummaryAsync(CONSULTATION_OWN, {} as any)).rejects.toThrow(ForbiddenException);
        });

        it('generateComprehensiveSummary should enforce ownership', async () => {
            await expect(controller.generateComprehensiveSummary(CONSULTATION_OWN, {} as any)).rejects.toThrow(ForbiddenException);
        });

        it('generateComprehensiveSummaryAsync should enforce ownership', async () => {
            await expect(controller.generateComprehensiveSummaryAsync(CONSULTATION_OWN, {} as any)).rejects.toThrow(ForbiddenException);
        });

        it('approveSummary should enforce ownership', async () => {
            await expect(controller.approveSummary(CONSULTATION_OWN, 'ctx-1')).rejects.toThrow(ForbiddenException);
        });

        // TASK-322 — lifecycle write endpoints
        it('close should enforce ownership', async () => {
            await expect(controller.close(CONSULTATION_OWN)).rejects.toThrow(ForbiddenException);
        });

        it('reopen should enforce ownership', async () => {
            await expect(controller.reopen(CONSULTATION_OWN)).rejects.toThrow(ForbiddenException);
        });

        it('update should enforce ownership', async () => {
            await expect(controller.update(CONSULTATION_OWN, {} as any)).rejects.toThrow(ForbiddenException);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // TASK-322 — lifecycle endpoints (close / reopen / update) wiring
    // ═══════════════════════════════════════════════════════════════════════

    describe('TASK-322 lifecycle endpoints', () => {
        it('close delegates to service and returns the updated consultation (owner)', async () => {
            const { controller, consultationService } = buildController();
            consultationService.getById.mockResolvedValue(makeConsultation({ doctorId: DOCTOR_A }));
            const closed = makeConsultation({ status: 'CLOSED' });
            consultationService.closeConsultation.mockResolvedValue(closed);

            const result = await controller.close(CONSULTATION_OWN);

            expect(consultationService.closeConsultation).toHaveBeenCalledWith(CONSULTATION_OWN);
            expect(result).toEqual(closed);
        });

        it('reopen delegates to service and returns the updated consultation (owner)', async () => {
            const { controller, consultationService } = buildController();
            consultationService.getById.mockResolvedValue(makeConsultation({ doctorId: DOCTOR_A }));
            const reopened = makeConsultation({ status: 'OPEN' });
            consultationService.reopenConsultation.mockResolvedValue(reopened);

            const result = await controller.reopen(CONSULTATION_OWN);

            expect(consultationService.reopenConsultation).toHaveBeenCalledWith(CONSULTATION_OWN);
            expect(result).toEqual(reopened);
        });

        it('update delegates to service with the request body and returns the result (owner)', async () => {
            const { controller, consultationService } = buildController();
            consultationService.getById.mockResolvedValue(makeConsultation({ doctorId: DOCTOR_A }));
            const updated = makeConsultation({ departmentId: 'dept-1' });
            consultationService.updateConsultation.mockResolvedValue(updated);

            const body = { departmentId: 'dept-1', metadata: { note: 'x' } };
            const result = await controller.update(CONSULTATION_OWN, body as any);

            expect(consultationService.updateConsultation).toHaveBeenCalledWith(CONSULTATION_OWN, body);
            expect(result).toEqual(updated);
        });

        it('admin/dept-head with CASL manage can close a consultation they do not own', async () => {
            const { controller, consultationService } = buildController({
                userId: DOCTOR_B,
                policyCanManage: true,
            });
            consultationService.getById.mockResolvedValue(makeConsultation({ doctorId: DOCTOR_A }));
            const closed = makeConsultation({ status: 'CLOSED' });
            consultationService.closeConsultation.mockResolvedValue(closed);

            const result = await controller.close(CONSULTATION_OWN);

            expect(result).toEqual(closed);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Patient-scoped endpoints use verifyPatientAccess
    // ═══════════════════════════════════════════════════════════════════════

    describe('patient-scoped endpoints use verifyPatientAccess', () => {
        it('getPatientHistory should enforce patient access', async () => {
            const { controller, consultationService } = buildController();
            consultationService.doctorHasPatientRelationship.mockResolvedValue(false);

            await expect(
                controller.getPatientHistory(PATIENT_UNRELATED, {} as any),
            ).rejects.toThrow(ForbiddenException);
        });

        it('getByPatientAndDate should enforce patient access', async () => {
            const { controller, consultationService } = buildController();
            consultationService.doctorHasPatientRelationship.mockResolvedValue(false);

            await expect(
                controller.getByPatientAndDate(PATIENT_UNRELATED, '2026-03-01'),
            ).rejects.toThrow(ForbiddenException);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Security: shared-patient read-only invariant
    // ═══════════════════════════════════════════════════════════════════════

    describe('SECURITY: shared-patient access is strictly read-only', () => {
        it('shared-patient doctor can READ but NOT WRITE the same consultation', async () => {
            const consultation = makeConsultation({ doctorId: DOCTOR_A, patientId: PATIENT_SHARED });

            const readCtx = buildController({ userId: DOCTOR_B, sharingEnabled: true });
            readCtx.consultationService.getById.mockResolvedValue(consultation);
            readCtx.consultationService.getByIdWithRelations.mockResolvedValue(consultation);
            readCtx.consultationService.doctorHasPatientRelationship.mockResolvedValue(true);

            const readResult = await readCtx.controller.getById(CONSULTATION_OWN);
            expect(readResult).toEqual(consultation);

            const writeCtx = buildController({ userId: DOCTOR_B, sharingEnabled: true, policyCanManage: false });
            writeCtx.consultationService.getById.mockResolvedValue(consultation);
            writeCtx.consultationService.doctorHasPatientRelationship.mockResolvedValue(true);

            await expect(
                writeCtx.controller.addContext(CONSULTATION_OWN, {} as any),
            ).rejects.toThrow(ForbiddenException);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // list endpoint — passes doctorId from context
    // ═══════════════════════════════════════════════════════════════════════

    describe('list endpoint', () => {
        it('should pass current doctorId to listConsultations', async () => {
            const { controller, consultationService } = buildController();
            consultationService.listConsultations.mockResolvedValue({
                data: [],
                count: 0,
                page: 1,
                limit: 10,
            });

            await controller.list({ page: '1', limit: '10' } as any);

            expect(consultationService.listConsultations).toHaveBeenCalledWith({
                page: 1,
                pageSize: 10,
                doctorId: DOCTOR_A,
                patientId: undefined,
            });
        });

        it('should pass patientId filter when provided', async () => {
            const { controller, consultationService } = buildController();
            consultationService.listConsultations.mockResolvedValue({
                data: [],
                count: 0,
                page: 1,
                limit: 10,
            });

            await controller.list({ page: '1', limit: '5', patientId: PATIENT_SHARED } as any);

            expect(consultationService.listConsultations).toHaveBeenCalledWith(
                expect.objectContaining({ patientId: PATIENT_SHARED, pageSize: 5 }),
            );
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // TASK-330 — summary provenance read route (citationsMap + sensor scores)
    // ═══════════════════════════════════════════════════════════════════════

    describe('getSummaryProvenance (TASK-330 provenance read)', () => {
        it('delegates to summaryService with the contextItemId for an authorized reader', async () => {
            const { controller, consultationService, summaryService } = buildController();
            consultationService.getById.mockResolvedValue(makeConsultation({ doctorId: DOCTOR_A }));
            const provenance = {
                contextItemId: 'ctx-1',
                modelName: 'gpt-x',
                coverageScore: 0.9,
                entityFaithfulnessScore: 0.95,
                ragTriadScore: 0.92,
                sensorScores: { coverage: 0.9 },
                citationsMap: { claims: [{ id: 'claim-1', text: 'lisinopril', status: 'verified' }] },
                generatedAt: '2026-06-06T00:00:00.000Z',
            };
            summaryService.getSummaryProvenance.mockResolvedValue(provenance);

            const result = await controller.getSummaryProvenance(CONSULTATION_OWN, 'ctx-1');

            expect(result).toEqual(provenance);
            expect(summaryService.getSummaryProvenance).toHaveBeenCalledWith('ctx-1');
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // EU-06: POST /consultations/open must be gated to create:Consultation
    // ═══════════════════════════════════════════════════════════════════════

    describe('open endpoint role gate (EU-06)', () => {
        it('requires @Authorize(["create","Consultation"]) so read-only roles cannot open consultations', () => {
            const meta = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, ConsultationController.prototype.open) as
                | Array<{ action: string; subject: string }>
                | undefined;
            expect(meta).toEqual([{ action: 'create', subject: 'Consultation' }]);
        });
    });
});
