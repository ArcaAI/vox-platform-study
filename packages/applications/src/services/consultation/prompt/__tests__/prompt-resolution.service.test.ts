/**
 * PromptResolutionService Unit Tests
 *
 * Tests BOTH capability chains (DNA resolution removed):
 *  - summary  (`new-patient` / `revisit`): preferred → agent → department
 *    column → SYSTEM default;
 *  - pre-summary: tenant TENANT_DEFAULT → SYSTEM pre-summary default → fail
 *    closed. It consults neither the preferred tier, nor the department default
 *    agent, nor the department visit-type columns.
 *
 * Coverage areas:
 * - System defaults when no department
 * - Department template and prompt resolution
 * - promptType: pre-summary, new-patient, revisit
 * - explicitTemplate override
 * - contextVariables from promptConfig
 * - `resolvedFrom` names the tier that produced the promptId
 * - No dnaStyleId in resolved config
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { PromptResolutionService, SYSTEM_DEFAULTS } from '../prompt-resolution.service';
import type { DepartmentEntity } from '@arcaai/domains';

// ============================================================================
// Mocks
// ============================================================================

const mockDepartmentRepository = {
  findById: vi.fn(),
};

const mockPromptTemplateRepository = {
  findById: vi.fn(),
  // The tenant pre-summary tier queries by (tenant, scope, status,
  // departmentId, tag). Default: the tenant has no pre-summary template.
  findAll: vi.fn(),
};

// Tier-1a. Default: no department default agent → the agent tier is
// skipped and resolution is byte-identical to the pre-change behaviour (this is
// the regression lock; tests that exercise the agent tier override these).
const mockDepartmentAgentRepository = {
  findDefaultForDepartment: vi.fn(),
};

const mockPromptVersionRepository = {
  findByVersionNumber: vi.fn(),
  findLatestVersion: vi.fn(),
};

/**
 * Helper: create a mock DepartmentEntity with prompt config fields.
 */
function createMockDepartment(
  overrides: Partial<{
    id: string;
    code: string;
    name: string;
    tenantId: string;
    defaultSummaryTemplate: string | null;
    preSummaryPromptId: string | null;
    newPatientPromptId: string | null;
    revisitPromptId: string | null;
    promptConfig: Record<string, unknown> | null;
  }> = {},
): DepartmentEntity {
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

    // prompt-resolution now gates clinical-flow templates
    // to status=APPROVED. Default: any looked-up template resolves APPROVED, so
    // the pre-existing preferred/department resolution behaviour is preserved.
    // Tests that exercise the gate override this with a DRAFT/PUBLISHED status.
    mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => ({ id, status: 'APPROVED' }));
    // Default: the tenant has no TENANT_DEFAULT pre-summary template.
    mockPromptTemplateRepository.findAll.mockResolvedValue([]);
    // Default: no default agent for any department (regression lock).
    mockDepartmentAgentRepository.findDefaultForDepartment.mockResolvedValue(null);

    service = new PromptResolutionService(
      mockDepartmentRepository as never,
      mockPromptTemplateRepository as never,
      mockDepartmentAgentRepository as never,
      mockPromptVersionRepository as never,
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
      mockDepartmentRepository.findById.mockRejectedValue(new Error('Database connection failed'));

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
  // Tier-0 — Preferred Prompt Template
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
      mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => (id === 'missing-tpl' ? null : { id, status: 'APPROVED' }));

      const result = await service.resolve({
        departmentId: 'dept-001',
        promptType: 'new-patient',
        preferredPromptTemplateId: 'missing-tpl',
      });

      expect(result.promptId).toBe('dept-prompt');
      expect(result.resolvedFrom).toBe('department');
      expect(result.resolutionTrace.preferredPromptId).toBeNull();
    });

    it('performs no preferred-tier lookup when no preferred id is supplied (default tier still resolves governed content)', async () => {
      const result = await service.resolve({});

      // No preferred id ⇒ the preferred-tier lookup never runs. The default
      // tier now resolves its governed CONTENT snapshot (F-01/F-02), so the
      // ONLY template lookup is for the SYSTEM default prompt id — never a
      // preferred id.
      expect(mockPromptTemplateRepository.findById).toHaveBeenCalledTimes(1);
      expect(mockPromptTemplateRepository.findById).toHaveBeenCalledWith(SYSTEM_DEFAULTS.promptId);
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
  // 3-tier resolvedFrom regression
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
  // prompt governance: APPROVED gating at resolution time
  // =========================================================================
  describe('resolve — APPROVED gating', () => {
    it('skips a DRAFT department template and falls through to the APPROVED default', async () => {
      mockDepartmentRepository.findById.mockResolvedValue(createMockDepartment({ newPatientPromptId: 'draft-dept-tpl' }));
      // The department template is DRAFT (not yet approved) → must be skipped.
      mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => ({ id, status: 'DRAFT' }));

      const result = await service.resolve({ departmentId: 'dept-001', promptType: 'new-patient' });

      expect(result.promptId).toBe(SYSTEM_DEFAULTS.promptId);
      expect(result.resolutionTrace.usedDefaults).toContain('promptId');
    });

    it('skips a PUBLISHED-but-not-APPROVED department template and falls through to default', async () => {
      mockDepartmentRepository.findById.mockResolvedValue(createMockDepartment({ newPatientPromptId: 'published-dept-tpl' }));
      mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => ({ id, status: 'PUBLISHED' }));

      const result = await service.resolve({ departmentId: 'dept-001', promptType: 'new-patient' });

      expect(result.promptId).toBe(SYSTEM_DEFAULTS.promptId);
    });

    it('uses an APPROVED department template', async () => {
      mockDepartmentRepository.findById.mockResolvedValue(createMockDepartment({ newPatientPromptId: 'approved-dept-tpl' }));
      mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => ({ id, status: 'APPROVED' }));

      const result = await service.resolve({ departmentId: 'dept-001', promptType: 'new-patient' });

      expect(result.promptId).toBe('approved-dept-tpl');
    });

    it('skips a DRAFT preferred template and falls through to the (APPROVED) department tier', async () => {
      mockDepartmentRepository.findById.mockResolvedValue(createMockDepartment({ newPatientPromptId: 'dept-prompt' }));
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

  // =========================================================================
  // Tier-1a: department default DepartmentAgent
  // =========================================================================
  describe('resolve — department default agent (tier-1a)', () => {
    const agent = (overrides: Record<string, unknown> = {}) => ({
      id: 'agent-1',
      promptTemplateId: 'agent-tpl',
      pinnedVersionNumber: null,
      ...overrides,
    });

    it('regression: with NO agent rows the output is byte-identical to the legacy chain', async () => {
      mockDepartmentRepository.findById.mockResolvedValue(createMockDepartment({ newPatientPromptId: 'dept-prompt' }));
      mockDepartmentAgentRepository.findDefaultForDepartment.mockResolvedValue(null);

      const result = await service.resolve({ departmentId: 'dept-001', promptType: 'new-patient' });

      expect(result.promptId).toBe('dept-prompt');
      expect(result.resolvedFrom).toBe('department');
      expect(result).not.toHaveProperty('content');
      expect(result.resolvedAgentId).toBeUndefined();
    });

    it('serves the PINNED PromptVersion.content when the agent pins a version', async () => {
      mockDepartmentRepository.findById.mockResolvedValue(createMockDepartment({ newPatientPromptId: 'dept-prompt' }));
      mockDepartmentAgentRepository.findDefaultForDepartment.mockResolvedValue(agent({ pinnedVersionNumber: 3 }));
      mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => ({ id, status: 'APPROVED' }));
      mockPromptVersionRepository.findByVersionNumber.mockResolvedValue({ versionNumber: 3, content: 'PINNED v3 body' });

      const result = await service.resolve({ departmentId: 'dept-001', promptType: 'new-patient' });

      expect(result.resolvedFrom).toBe('agent');
      expect(result.promptId).toBe('agent-tpl');
      expect(result.content).toBe('PINNED v3 body');
      expect(result.resolvedVersionNumber).toBe(3);
      expect(result.resolvedAgentId).toBe('agent-1');
      expect(mockPromptVersionRepository.findByVersionNumber).toHaveBeenCalledWith('agent-tpl', 3);
    });

    it('serves the LATEST version content when the agent is unpinned AND the template has no approval pin (legacy)', async () => {
      mockDepartmentRepository.findById.mockResolvedValue(createMockDepartment());
      mockDepartmentAgentRepository.findDefaultForDepartment.mockResolvedValue(agent({ pinnedVersionNumber: null }));
      // approvedVersionNumber absent (legacy) ⇒ falls through to latest.
      mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => ({ id, status: 'APPROVED' }));
      mockPromptVersionRepository.findLatestVersion.mockResolvedValue({ versionNumber: 7, content: 'LATEST approved body' });

      const result = await service.resolve({ departmentId: 'dept-001', promptType: 'new-patient' });

      expect(result.resolvedFrom).toBe('agent');
      expect(result.content).toBe('LATEST approved body');
      expect(result.resolvedVersionNumber).toBe(7);
      expect(mockPromptVersionRepository.findLatestVersion).toHaveBeenCalledWith('agent-tpl');
    });

    it('serves the approvedVersionNumber snapshot for an UNPINNED agent, NOT the newer unapproved latest (F-02)', async () => {
      mockDepartmentRepository.findById.mockResolvedValue(createMockDepartment());
      mockDepartmentAgentRepository.findDefaultForDepartment.mockResolvedValue(agent({ pinnedVersionNumber: null }));
      // Template approved at v4, then content-edited to v6 without re-approval.
      mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => ({ id, status: 'APPROVED', approvedVersionNumber: 4 }));
      mockPromptVersionRepository.findByVersionNumber.mockResolvedValue({ versionNumber: 4, content: 'APPROVED v4 body' });
      mockPromptVersionRepository.findLatestVersion.mockResolvedValue({ versionNumber: 6, content: 'UNAPPROVED latest v6' });

      const result = await service.resolve({ departmentId: 'dept-001', promptType: 'new-patient' });

      expect(result.resolvedFrom).toBe('agent');
      // The eval-gated approved snapshot wins over the newer unapproved edit.
      expect(result.content).toBe('APPROVED v4 body');
      expect(result.resolvedVersionNumber).toBe(4);
      expect(mockPromptVersionRepository.findByVersionNumber).toHaveBeenCalledWith('agent-tpl', 4);
      expect(mockPromptVersionRepository.findLatestVersion).not.toHaveBeenCalled();
    });

    it('falls through to the legacy chain when the agent template is NOT APPROVED', async () => {
      mockDepartmentRepository.findById.mockResolvedValue(createMockDepartment({ newPatientPromptId: 'dept-prompt' }));
      mockDepartmentAgentRepository.findDefaultForDepartment.mockResolvedValue(agent({ pinnedVersionNumber: 2 }));
      // Agent's bound template is DRAFT; legacy dept-prompt stays APPROVED.
      mockPromptTemplateRepository.findById.mockImplementation(async (id: string) =>
        id === 'agent-tpl' ? { id, status: 'DRAFT' } : { id, status: 'APPROVED' },
      );

      const result = await service.resolve({ departmentId: 'dept-001', promptType: 'new-patient' });

      expect(result.resolvedFrom).toBe('department');
      expect(result.promptId).toBe('dept-prompt');
      expect(result).not.toHaveProperty('content');
    });
  });

  // =========================================================================
  // Governed CONTENT snapshot for the NON-agent tiers (F-01/F-02)
  //
  // The resolver serves the APPROVED PromptVersion snapshot for the
  // preferred / legacy-department / default tiers too — never the mutable
  // PromptTemplate.content row — so a post-approval content edit is not served
  // until the next (eval-gated) re-approval.
  // =========================================================================
  describe('resolve — governed content snapshot (non-agent tiers)', () => {
    it('serves the department template APPROVED snapshot (approvedVersionNumber), not the mutable content column', async () => {
      mockDepartmentRepository.findById.mockResolvedValue(createMockDepartment({ newPatientPromptId: 'dept-tpl' }));
      mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => ({
        id,
        status: 'APPROVED',
        approvedVersionNumber: 4,
        content: 'MUTABLE latest edit v6',
        currentVersionNumber: 6,
      }));
      mockPromptVersionRepository.findByVersionNumber.mockResolvedValue({ versionNumber: 4, content: 'APPROVED v4 body' });

      const result = await service.resolve({ departmentId: 'dept-001', promptType: 'new-patient' });

      expect(result.resolvedFrom).toBe('department');
      expect(result.promptId).toBe('dept-tpl');
      expect(result.content).toBe('APPROVED v4 body');
      expect(result.content).not.toBe('MUTABLE latest edit v6');
      expect(result.resolvedVersionNumber).toBe(4);
      expect(mockPromptVersionRepository.findByVersionNumber).toHaveBeenCalledWith('dept-tpl', 4);
    });

    it('falls back to template.content for a legacy APPROVED template with no approval pin', async () => {
      mockDepartmentRepository.findById.mockResolvedValue(createMockDepartment({ newPatientPromptId: 'legacy-tpl' }));
      mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => ({
        id,
        status: 'APPROVED',
        approvedVersionNumber: null,
        content: 'LEGACY content column',
        currentVersionNumber: 2,
      }));

      const result = await service.resolve({ departmentId: 'dept-001', promptType: 'new-patient' });

      expect(result.content).toBe('LEGACY content column');
      expect(result.resolvedVersionNumber).toBe(2);
      // No pin ⇒ never dereferences a version snapshot.
      expect(mockPromptVersionRepository.findByVersionNumber).not.toHaveBeenCalled();
    });

    it('serves the preferred template APPROVED snapshot for the preferred tier', async () => {
      mockDepartmentRepository.findById.mockResolvedValue(createMockDepartment({ newPatientPromptId: 'dept-tpl' }));
      mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => ({
        id,
        status: 'APPROVED',
        approvedVersionNumber: 9,
        content: 'preferred mutable v12',
        currentVersionNumber: 12,
      }));
      mockPromptVersionRepository.findByVersionNumber.mockResolvedValue({ versionNumber: 9, content: 'preferred APPROVED v9' });

      const result = await service.resolve({
        departmentId: 'dept-001',
        promptType: 'new-patient',
        preferredPromptTemplateId: 'preferred-tpl',
      });

      expect(result.resolvedFrom).toBe('preferred');
      expect(result.promptId).toBe('preferred-tpl');
      expect(result.content).toBe('preferred APPROVED v9');
      expect(result.resolvedVersionNumber).toBe(9);
      expect(mockPromptVersionRepository.findByVersionNumber).toHaveBeenCalledWith('preferred-tpl', 9);
    });
  });

  // =========================================================================
  // The pre-summary capability chain
  //
  // Pre-summary has NO department axis and NO visit-type axis: there is exactly
  // ONE pre-summary prompt per tenant, and department/visit type are VARIABLES
  // INSIDE it. So the pre-summary chain skips the preferred tier, the department
  // default-agent tier (tier-1a) and the department visit-type columns, and it
  // FAILS CLOSED rather than serving a clinical NOTE prompt (CATCHALL_SOAP).
  // =========================================================================
  describe('resolve — pre-summary capability chain', () => {
    /** The tenant's TENANT_DEFAULT pre-summary template row (governed snapshot at v2). */
    const wireTenantPreSummary = (rows: Array<{ id: string }> = [{ id: 'tenant-presummary-tpl' }]) => {
      mockPromptTemplateRepository.findAll.mockResolvedValue(rows);
      mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => ({ id, status: 'APPROVED', approvedVersionNumber: 2 }));
      mockPromptVersionRepository.findByVersionNumber.mockResolvedValue({ versionNumber: 2, content: 'TENANT pre-summary body' });
    };

    it('D-01: resolves the TENANT pre-summary template for a department that HAS a default agent (agent tier skipped)', async () => {
      mockDepartmentRepository.findById.mockResolvedValue(
        createMockDepartment({ preSummaryPromptId: 'dept-presummary-col', newPatientPromptId: 'dept-note' }),
      );
      mockDepartmentAgentRepository.findDefaultForDepartment.mockResolvedValue({
        id: 'agent-1',
        promptTemplateId: 'agent-note-tpl',
        pinnedVersionNumber: 1,
      });
      wireTenantPreSummary();

      const result = await service.resolve({ departmentId: 'dept-001', promptType: 'pre-summary' });

      expect(result.promptId).toBe('tenant-presummary-tpl');
      expect(result.resolvedFrom).toBe('tenant');
      expect(result.content).toBe('TENANT pre-summary body');
      expect(result.resolvedAgentId).toBeUndefined();
      // DELIBERATE CHANGE. This used to assert
      // `findDefaultForDepartment` was NEVER called for pre-summary, because the
      // agent tier could only have served a clinical NOTE prompt. C2 gives the
      // agent a dedicated `preSummaryTemplateId` binding, so the tier IS now
      // consulted when a departmentId is supplied — but ONLY that binding is
      // read, with no base-`promptTemplateId` fallback. The agent here has none,
      // so the tier is skipped and the OUTCOME is unchanged: the tenant row still
      // wins and no note prompt can ever be substituted (the assertions above).
      expect(mockDepartmentAgentRepository.findDefaultForDepartment).toHaveBeenCalledTimes(1);
      // …and the department visit-type columns are not read.
      expect(result.promptId).not.toBe('dept-presummary-col');
      expect(result.resolutionTrace.departmentPromptId).toBeNull();
    });

    it('never resolves the doctor preferred (note) template for pre-summary', async () => {
      wireTenantPreSummary();

      const result = await service.resolve({
        tenantId: 'tenant-001',
        promptType: 'pre-summary',
        preferredPromptTemplateId: 'preferred-note-tpl',
      });

      expect(result.promptId).toBe('tenant-presummary-tpl');
      expect(result.resolvedFrom).toBe('tenant');
      expect(mockPromptTemplateRepository.findById).not.toHaveBeenCalledWith('preferred-note-tpl');
    });

    it('queries the tenant pre-summary pointer deterministically and tenant-scoped', async () => {
      mockDepartmentRepository.findById.mockResolvedValue(createMockDepartment({ tenantId: 'tenant-from-dept' }));
      wireTenantPreSummary();

      await service.resolve({ departmentId: 'dept-001', promptType: 'pre-summary' });

      const [props] = mockPromptTemplateRepository.findAll.mock.calls[0] as [Record<string, any>];
      expect(props.filters).toMatchObject({
        tenantId: 'tenant-from-dept',
        scope: 'TENANT_DEFAULT',
        status: 'APPROVED',
        departmentId: null,
      });
      // Stable total order — never left to Postgres to tie-break (the D-05 trap).
      expect(props.sort).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    });

    it('prefers the explicit tenantId param over the department when both are present', async () => {
      mockDepartmentRepository.findById.mockResolvedValue(createMockDepartment({ tenantId: 'tenant-from-dept' }));
      wireTenantPreSummary();

      await service.resolve({ departmentId: 'dept-001', tenantId: 'tenant-explicit', promptType: 'pre-summary' });

      const [props] = mockPromptTemplateRepository.findAll.mock.calls[0] as [Record<string, any>];
      expect(props.filters.tenantId).toBe('tenant-explicit');
    });

    it('picks the first candidate deterministically and warns when a tenant has more than one', async () => {
      wireTenantPreSummary([{ id: 'presummary-a' }, { id: 'presummary-b' }]);
      const warn = vi.spyOn((service as unknown as { logger: { warn: (v: unknown) => void } }).logger, 'warn');

      const result = await service.resolve({ tenantId: 'tenant-001', promptType: 'pre-summary' });

      expect(result.promptId).toBe('presummary-a');
      expect(warn).toHaveBeenCalled();
    });

    it('falls back to the SYSTEM pre-summary default when the tenant has no pre-summary template', async () => {
      mockPromptTemplateRepository.findAll.mockResolvedValue([]);
      mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => ({
        id,
        status: 'APPROVED',
        content: 'SYSTEM pre-summary body',
      }));

      const result = await service.resolve({ tenantId: 'tenant-001', promptType: 'pre-summary' });

      expect(result.promptId).toBe(SYSTEM_DEFAULTS.preSummaryPromptId);
      expect(result.promptId).not.toBe(SYSTEM_DEFAULTS.promptId);
      expect(result.resolvedFrom).toBe('default');
      expect(result.resolutionTrace.usedDefaults).toContain('promptId');
    });

    it('FAILS CLOSED when neither a tenant nor a SYSTEM pre-summary template resolves — never CATCHALL_SOAP', async () => {
      mockPromptTemplateRepository.findAll.mockResolvedValue([]);
      mockPromptTemplateRepository.findById.mockResolvedValue(null);

      await expect(service.resolve({ tenantId: 'tenant-001', promptType: 'pre-summary' })).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('FAILS CLOSED when the SYSTEM pre-summary default is not APPROVED', async () => {
      mockPromptTemplateRepository.findAll.mockResolvedValue([]);
      mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => ({ id, status: 'DRAFT' }));

      await expect(service.resolve({ tenantId: 'tenant-001', promptType: 'pre-summary' })).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('FAILS CLOSED when the tenant lookup itself errors — a backend error is never disguised as the SYSTEM default', async () => {
      mockPromptTemplateRepository.findAll.mockRejectedValue(new Error('db down'));
      mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => ({ id, status: 'APPROVED' }));

      await expect(service.resolve({ tenantId: 'tenant-001', promptType: 'pre-summary' })).rejects.toThrow('db down');
    });

    it('FAILS CLOSED when no tenant can be determined at all (no tenantId, no department)', async () => {
      mockPromptTemplateRepository.findById.mockResolvedValue(null);

      await expect(service.resolve({ promptType: 'pre-summary' })).rejects.toBeInstanceOf(ServiceUnavailableException);
      // No tenant ⇒ the tenant tier is not even queried.
      expect(mockPromptTemplateRepository.findAll).not.toHaveBeenCalled();
    });

    it('still carries the department template + contextVariables for pre-summary', async () => {
      mockDepartmentRepository.findById.mockResolvedValue(
        createMockDepartment({ defaultSummaryTemplate: 'SOAP', promptConfig: { contextVariables: { ecg: true } } }),
      );
      wireTenantPreSummary();

      const result = await service.resolve({ departmentId: 'dept-001', promptType: 'pre-summary' });

      expect(result.template).toBe('SOAP');
      expect(result.contextVariables).toEqual({ ecg: true });
    });
  });

  // =========================================================================
  // The summary chain is UNCHANGED (regression lock) + D-02
  // =========================================================================
  describe('resolve — summary chain regression lock (new-patient / revisit)', () => {
    it('new-patient with a department default agent resolves exactly as before the pre-summary split', async () => {
      mockDepartmentRepository.findById.mockResolvedValue(createMockDepartment({ newPatientPromptId: 'dept-prompt' }));
      mockDepartmentAgentRepository.findDefaultForDepartment.mockResolvedValue({
        id: 'agent-1',
        promptTemplateId: 'agent-tpl',
        pinnedVersionNumber: 3,
      });
      mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => ({ id, status: 'APPROVED' }));
      mockPromptVersionRepository.findByVersionNumber.mockResolvedValue({ versionNumber: 3, content: 'PINNED v3 body' });

      const result = await service.resolve({ departmentId: 'dept-001', promptType: 'new-patient' });

      expect(result).toEqual({
        template: SYSTEM_DEFAULTS.template,
        promptId: 'agent-tpl',
        contextVariables: {},
        resolvedFrom: 'agent',
        resolutionTrace: {
          preferredPromptId: null,
          agentId: 'agent-1',
          agentVersionNumber: 3,
          departmentTemplate: null,
          departmentPromptId: 'dept-prompt',
          usedDefaults: ['template', 'contextVariables'],
        },
        content: 'PINNED v3 body',
        resolvedVersionNumber: 3,
        resolvedAgentId: 'agent-1',
        // Additive trace/telemetry field naming which capability
        // chain ran. Nothing branches on it; it is asserted here only because
        // this is a whole-object deep-equal regression lock.
        resolvedCapability: 'summary',
      });
      // The tenant pre-summary tier never runs for a summary prompt type.
      expect(mockPromptTemplateRepository.findAll).not.toHaveBeenCalled();
    });

    it('revisit with a department default agent still resolves the agent', async () => {
      mockDepartmentRepository.findById.mockResolvedValue(createMockDepartment({ revisitPromptId: 'dept-revisit' }));
      mockDepartmentAgentRepository.findDefaultForDepartment.mockResolvedValue({
        id: 'agent-1',
        promptTemplateId: 'agent-tpl',
        pinnedVersionNumber: 3,
      });
      mockPromptVersionRepository.findByVersionNumber.mockResolvedValue({ versionNumber: 3, content: 'PINNED v3 body' });

      const result = await service.resolve({ departmentId: 'dept-001', promptType: 'revisit' });

      expect(result.resolvedFrom).toBe('agent');
      expect(result.promptId).toBe('agent-tpl');
      expect(result.resolutionTrace.departmentPromptId).toBe('dept-revisit');
    });

    it('D-02: reports "default" when the department supplied only a template and promptId fell to the SYSTEM default', async () => {
      // Department has a defaultSummaryTemplate but NO visit-type prompt id —
      // the pre-fix formula (usedDefaults.length < 3) mislabelled this
      // 'department' while actually serving CATCHALL_SOAP, which made the
      // compat guard dead code.
      mockDepartmentRepository.findById.mockResolvedValue(createMockDepartment({ defaultSummaryTemplate: 'SOAP' }));

      const result = await service.resolve({ departmentId: 'dept-001', promptType: 'new-patient' });

      expect(result.template).toBe('SOAP');
      expect(result.promptId).toBe(SYSTEM_DEFAULTS.promptId);
      expect(result.resolvedFrom).toBe('default');
    });

    it('D-02: reports "default" when the department template is UNAPPROVED and promptId fell to the SYSTEM default', async () => {
      mockDepartmentRepository.findById.mockResolvedValue(createMockDepartment({ defaultSummaryTemplate: 'SOAP', newPatientPromptId: 'draft-tpl' }));
      mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => ({ id, status: 'DRAFT' }));

      const result = await service.resolve({ departmentId: 'dept-001', promptType: 'new-patient' });

      expect(result.promptId).toBe(SYSTEM_DEFAULTS.promptId);
      expect(result.resolvedFrom).toBe('default');
    });
  });
});
