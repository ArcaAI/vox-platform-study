/**
 * PromptResolutionService Unit Tests
 *
 * Tests the Department → System Default fallback chain (DNA resolution removed).
 *
 * Coverage areas:
 * - System defaults when no department
 * - Department template and prompt resolution
 * - promptType: pre-summary, new-patient, revisit
 * - explicitTemplate override
 * - contextVariables from promptConfig
 * - No dnaStyleId in resolved config
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    PromptResolutionService,
    SYSTEM_DEFAULTS,
} from '../prompt-resolution.service';
import type { DepartmentEntity } from '@arcaai/domains';

// ============================================================================
// Mocks
// ============================================================================

const mockDepartmentRepository = {
    findById: vi.fn(),
};

const mockPromptTemplateRepository = {
    findById: vi.fn(),
};

/**
 * Helper: create a mock DepartmentEntity with prompt config fields.
 */
function createMockDepartment(overrides: Partial<{
    id: string;
    code: string;
    name: string;
    tenantId: string;
    defaultSummaryTemplate: string | null;
    preSummaryPromptId: string | null;
    newPatientPromptId: string | null;
    revisitPromptId: string | null;
    promptConfig: Record<string, unknown> | null;
}> = {}): DepartmentEntity {
    return {
        id: overrides.id ?? 'dept-001',
        code: overrides.code ?? 'CARD',
        name: overrides.name ?? 'Cardiology',
        tenantId: overrides.tenantId ?? 'tenant-001',
        defaultSummaryTemplate: overrides.defaultSummaryTemplate ?? null,
        preSummaryPromptId: overrides.preSummaryPromptId ?? null,
        newPatientPromptId: overrides.newPatientPromptId ?? null,
        revisitPromptId: overrides.revisitPromptId ?? null,
        promptConfig: overrides.promptConfig ?? null,
    } as unknown as DepartmentEntity;
}

// ============================================================================
// Test Suite
// ============================================================================

describe('PromptResolutionService', () => {
    let service: PromptResolutionService;

    beforeEach(() => {
        vi.clearAllMocks();

        // TASK-511 (Phase 3A) — prompt-resolution now gates clinical-flow templates
        // to status=APPROVED. Default: any looked-up template resolves APPROVED, so
        // the pre-existing preferred/department resolution behaviour is preserved.
        // Tests that exercise the gate override this with a DRAFT/PUBLISHED status.
        mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => ({ id, status: 'APPROVED' }));

        service = new PromptResolutionService(
            mockDepartmentRepository as never,
            mockPromptTemplateRepository as never,
        );
    });

    // =========================================================================
    // System Defaults
    // =========================================================================

    describe('resolve — system defaults', () => {
        it('should resolve with system defaults when no department provided', async () => {
            const result = await service.resolve({});

            expect(result.template).toBe(SYSTEM_DEFAULTS.template);
            expect(result.promptId).toBe(SYSTEM_DEFAULTS.promptId);
            expect(result.contextVariables).toEqual({});
            expect(result.resolvedFrom).toBe('default');
            expect(result.resolutionTrace.usedDefaults).toContain('template');
            expect(result.resolutionTrace.usedDefaults).toContain('promptId');
            expect(result.resolutionTrace.usedDefaults).toContain('contextVariables');
            expect(mockDepartmentRepository.findById).not.toHaveBeenCalled();
        });

        it('should NOT have dnaStyleId in resolved config', async () => {
            const result = await service.resolve({});

            expect(result).not.toHaveProperty('dnaStyleId');
        });
    });

    // =========================================================================
    // Department Tier
    // =========================================================================

    describe('resolve — department tier', () => {
        it('should resolve template from department when departmentId provided', async () => {
            mockDepartmentRepository.findById.mockResolvedValue(
                createMockDepartment({
                    defaultSummaryTemplate: 'SOAP',
                    newPatientPromptId: 'prompt_card_new',
                }),
            );

            const result = await service.resolve({
                departmentId: 'dept-001',
            });

            expect(result.template).toBe('SOAP');
            expect(result.promptId).toBe('prompt_card_new');
            expect(result.resolvedFrom).toBe('department');
            expect(result.resolutionTrace.departmentTemplate).toBe('SOAP');
            expect(result.resolutionTrace.departmentPromptId).toBe('prompt_card_new');
        });

        it('should resolve preSummaryPromptId when promptType is pre-summary', async () => {
            mockDepartmentRepository.findById.mockResolvedValue(
                createMockDepartment({
                    preSummaryPromptId: 'prompt_pre_summary',
                    newPatientPromptId: 'prompt_new',
                    revisitPromptId: 'prompt_revisit',
                }),
            );

            const result = await service.resolve({
                departmentId: 'dept-001',
                promptType: 'pre-summary',
            });

            expect(result.promptId).toBe('prompt_pre_summary');
        });

        it('should resolve newPatientPromptId when promptType is new-patient', async () => {
            mockDepartmentRepository.findById.mockResolvedValue(
                createMockDepartment({
                    preSummaryPromptId: 'prompt_pre_summary',
                    newPatientPromptId: 'prompt_new',
                    revisitPromptId: 'prompt_revisit',
                }),
            );

            const result = await service.resolve({
                departmentId: 'dept-001',
                promptType: 'new-patient',
            });

            expect(result.promptId).toBe('prompt_new');
        });

        it('should resolve revisitPromptId when promptType is revisit', async () => {
            mockDepartmentRepository.findById.mockResolvedValue(
                createMockDepartment({
                    preSummaryPromptId: 'prompt_pre_summary',
                    newPatientPromptId: 'prompt_new',
                    revisitPromptId: 'prompt_revisit',
                }),
            );

            const result = await service.resolve({
                departmentId: 'dept-001',
                promptType: 'revisit',
            });

            expect(result.promptId).toBe('prompt_revisit');
        });

        it('should default to new-patient when promptType not specified', async () => {
            mockDepartmentRepository.findById.mockResolvedValue(
                createMockDepartment({
                    newPatientPromptId: 'prompt_new_default',
                }),
            );

            const result = await service.resolve({
                departmentId: 'dept-001',
            });

            expect(result.promptId).toBe('prompt_new_default');
        });

        it('should use explicitTemplate when provided', async () => {
            mockDepartmentRepository.findById.mockResolvedValue(
                createMockDepartment({
                    defaultSummaryTemplate: 'SOAP',
                }),
            );

            const result = await service.resolve({
                departmentId: 'dept-001',
                explicitTemplate: 'Custom-Template',
            });

            expect(result.template).toBe('Custom-Template');
        });

        it('should extract contextVariables from department promptConfig', async () => {
            mockDepartmentRepository.findById.mockResolvedValue(
                createMockDepartment({
                    defaultSummaryTemplate: 'SOAP',
                    newPatientPromptId: 'prompt_card_new',
                    promptConfig: {
                        contextVariables: {
                            ecgResults: true,
                            bloodPressureHistory: true,
                        },
                        abbreviationDensity: 'medium',
                    },
                }),
            );

            const result = await service.resolve({
                departmentId: 'dept-001',
            });

            expect(result.contextVariables).toEqual({
                ecgResults: true,
                bloodPressureHistory: true,
            });
            expect(result.resolutionTrace.usedDefaults).not.toContain('contextVariables');
        });

        it('should return empty contextVariables when department has no promptConfig', async () => {
            mockDepartmentRepository.findById.mockResolvedValue(
                createMockDepartment({
                    defaultSummaryTemplate: 'SOAP',
                    newPatientPromptId: 'prompt_card_new',
                    promptConfig: null,
                }),
            );

            const result = await service.resolve({
                departmentId: 'dept-001',
            });

            expect(result.contextVariables).toEqual({});
        });

        it('should use explicitTemplate and skip department lookup for template', async () => {
            mockDepartmentRepository.findById.mockResolvedValue(
                createMockDepartment({
                    defaultSummaryTemplate: 'SOAP',
                    newPatientPromptId: 'prompt_card_new',
                }),
            );

            const result = await service.resolve({
                departmentId: 'dept-001',
                explicitTemplate: 'Explicit-Template',
            });

            expect(result.template).toBe('Explicit-Template');
            expect(result.promptId).toBe('prompt_card_new');
        });

        it('should gracefully handle department lookup failure', async () => {
            mockDepartmentRepository.findById.mockRejectedValue(
                new Error('Database connection failed'),
            );

            const result = await service.resolve({
                departmentId: 'dept-001',
            });

            expect(result.template).toBe(SYSTEM_DEFAULTS.template);
            expect(result.promptId).toBe(SYSTEM_DEFAULTS.promptId);
            expect(result.resolvedFrom).toBe('default');
        });
    });

    // =========================================================================
    // Resolution Trace
    // =========================================================================

    describe('resolution trace', () => {
        it('should have trace without doctorDnaStyleId or departmentDnaStyleId', async () => {
            mockDepartmentRepository.findById.mockResolvedValue(
                createMockDepartment({
                    defaultSummaryTemplate: 'SOAP',
                    newPatientPromptId: 'prompt_new',
                }),
            );

            const result = await service.resolve({
                departmentId: 'dept-001',
            });

            expect(result.resolutionTrace).not.toHaveProperty('doctorDnaStyleId');
            expect(result.resolutionTrace).not.toHaveProperty('departmentDnaStyleId');
            expect(result.resolutionTrace.departmentTemplate).toBe('SOAP');
            expect(result.resolutionTrace.departmentPromptId).toBe('prompt_new');
        });
    });

    // =========================================================================
    // Tier-0 — Preferred Prompt Template (TASK-329 P2)
    // =========================================================================

    describe('resolve — preferred prompt template (Tier-0)', () => {
        it('uses the preferred template id over the department/default promptId', async () => {
            mockDepartmentRepository.findById.mockResolvedValue(
                createMockDepartment({ defaultSummaryTemplate: 'SOAP', newPatientPromptId: 'dept-prompt' }),
            );
            mockPromptTemplateRepository.findById.mockResolvedValue({ id: 'preferred-tpl', name: 'My SOAP', status: 'APPROVED' });

            const result = await service.resolve({
                departmentId: 'dept-001',
                promptType: 'new-patient',
                preferredPromptTemplateId: 'preferred-tpl',
            });

            expect(result.promptId).toBe('preferred-tpl');
            expect(result.resolvedFrom).toBe('preferred');
            expect(result.resolutionTrace.preferredPromptId).toBe('preferred-tpl');
            expect(mockPromptTemplateRepository.findById).toHaveBeenCalledWith('preferred-tpl');
        });

        it('falls back to the department/default tiers when the preferred template does not exist', async () => {
            mockDepartmentRepository.findById.mockResolvedValue(
                createMockDepartment({ defaultSummaryTemplate: 'SOAP', newPatientPromptId: 'dept-prompt' }),
            );
            // The preferred id is missing; the (APPROVED) department template resolves.
            mockPromptTemplateRepository.findById.mockImplementation(async (id: string) =>
                id === 'missing-tpl' ? null : { id, status: 'APPROVED' },
            );

            const result = await service.resolve({
                departmentId: 'dept-001',
                promptType: 'new-patient',
                preferredPromptTemplateId: 'missing-tpl',
            });

            expect(result.promptId).toBe('dept-prompt');
            expect(result.resolvedFrom).toBe('department');
            expect(result.resolutionTrace.preferredPromptId).toBeNull();
        });

        it('does not query the template repo when no preferred id is supplied', async () => {
            const result = await service.resolve({});

            expect(mockPromptTemplateRepository.findById).not.toHaveBeenCalled();
            expect(result.resolvedFrom).toBe('default');
            expect(result.resolutionTrace.preferredPromptId).toBeNull();
        });

        it('falls through to default when the preferred lookup throws', async () => {
            mockPromptTemplateRepository.findById.mockRejectedValue(new Error('db-down'));

            const result = await service.resolve({ preferredPromptTemplateId: 'preferred-tpl' });

            expect(result.promptId).toBe(SYSTEM_DEFAULTS.promptId);
            expect(result.resolvedFrom).toBe('default');
        });
    });

    // =========================================================================
    // 3-tier resolvedFrom regression (TASK-331 doc-06 F9)
    //
    // The header JSDoc previously claimed a "two-tier" chain; the code resolves
    // three tiers. This guards that `resolvedFrom` keeps returning the correct
    // tier label for each of preferred / department / default.
    // =========================================================================
    describe('resolve — 3-tier resolvedFrom regression', () => {
        it('reports "preferred" when the doctor preferred template resolves (Tier-0)', async () => {
            mockDepartmentRepository.findById.mockResolvedValue(
                createMockDepartment({ defaultSummaryTemplate: 'SOAP', newPatientPromptId: 'dept-prompt' }),
            );
            mockPromptTemplateRepository.findById.mockResolvedValue({ id: 'preferred-tpl', status: 'APPROVED' });

            const result = await service.resolve({
                departmentId: 'dept-001',
                promptType: 'new-patient',
                preferredPromptTemplateId: 'preferred-tpl',
            });

            expect(result.resolvedFrom).toBe('preferred');
        });

        it('reports "department" when only the department tier resolves (Tier-1)', async () => {
            mockDepartmentRepository.findById.mockResolvedValue(
                createMockDepartment({ defaultSummaryTemplate: 'SOAP', newPatientPromptId: 'dept-prompt' }),
            );

            const result = await service.resolve({ departmentId: 'dept-001', promptType: 'new-patient' });

            expect(result.resolvedFrom).toBe('department');
        });

        it('reports "default" when neither preferred nor department resolve (Tier-2)', async () => {
            const result = await service.resolve({});

            expect(result.resolvedFrom).toBe('default');
        });
    });

    // =========================================================================
    // TASK-511 (Phase 3A) — prompt governance: APPROVED gating at resolution time
    // =========================================================================
    describe('resolve — APPROVED gating (TASK-511)', () => {
        it('skips a DRAFT department template and falls through to the APPROVED default', async () => {
            mockDepartmentRepository.findById.mockResolvedValue(
                createMockDepartment({ newPatientPromptId: 'draft-dept-tpl' }),
            );
            // The department template is DRAFT (not yet approved) → must be skipped.
            mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => ({ id, status: 'DRAFT' }));

            const result = await service.resolve({ departmentId: 'dept-001', promptType: 'new-patient' });

            expect(result.promptId).toBe(SYSTEM_DEFAULTS.promptId);
            expect(result.resolutionTrace.usedDefaults).toContain('promptId');
        });

        it('skips a PUBLISHED-but-not-APPROVED department template and falls through to default', async () => {
            mockDepartmentRepository.findById.mockResolvedValue(
                createMockDepartment({ newPatientPromptId: 'published-dept-tpl' }),
            );
            mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => ({ id, status: 'PUBLISHED' }));

            const result = await service.resolve({ departmentId: 'dept-001', promptType: 'new-patient' });

            expect(result.promptId).toBe(SYSTEM_DEFAULTS.promptId);
        });

        it('uses an APPROVED department template', async () => {
            mockDepartmentRepository.findById.mockResolvedValue(
                createMockDepartment({ newPatientPromptId: 'approved-dept-tpl' }),
            );
            mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => ({ id, status: 'APPROVED' }));

            const result = await service.resolve({ departmentId: 'dept-001', promptType: 'new-patient' });

            expect(result.promptId).toBe('approved-dept-tpl');
        });

        it('skips a DRAFT preferred template and falls through to the (APPROVED) department tier', async () => {
            mockDepartmentRepository.findById.mockResolvedValue(
                createMockDepartment({ newPatientPromptId: 'dept-prompt' }),
            );
            mockPromptTemplateRepository.findById.mockImplementation(async (id: string) =>
                id === 'draft-preferred' ? { id, status: 'DRAFT' } : { id, status: 'APPROVED' },
            );

            const result = await service.resolve({
                departmentId: 'dept-001',
                promptType: 'new-patient',
                preferredPromptTemplateId: 'draft-preferred',
            });

            expect(result.promptId).toBe('dept-prompt');
            expect(result.resolvedFrom).toBe('department');
            expect(result.resolutionTrace.preferredPromptId).toBeNull();
        });
    });
});
