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

        service = new PromptResolutionService(
            mockDepartmentRepository as never,
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
});
