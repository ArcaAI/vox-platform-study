/**
 * The LIVE capability chain.
 *
 * Tier 1a  agent `livePromptTemplateId` (APPROVED + pinned PromptVersion snapshot)
 * Tier 2   `SYSTEM_DEFAULTS.livePromptId` — the seeded SYSTEM live-default row
 * Tier 3   in-code constants, reported as `'code-default'` — the DOCUMENTED
 *          FAIL-OPEN: a live consultation must never be failed by a
 *          prompt-resolution error. Safe only because tier-3 bytes are proven
 *          identical to tier-2's (paired sha256 guards), so "fail-open"
 *          degrades to IDENTICAL behavior rather than different behavior.
 *
 * The finalize (summary) and pre-summary chains keep their existing posture and
 * are NOT touched here — a regression lock for that lives at the bottom.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PromptResolutionService, SYSTEM_DEFAULTS } from '../prompt-resolution.service';

const mockDepartmentRepository = { findById: vi.fn() };
const mockPromptTemplateRepository = { findById: vi.fn(), findAll: vi.fn() };
const mockDepartmentAgentRepository = { findDefaultForDepartment: vi.fn() };
const mockPromptVersionRepository = { findByVersionNumber: vi.fn(), findLatestVersion: vi.fn() };

const TENANT = 'tenant-live-001';
const DEPT = 'dept-live-001';
const AGENT_TEMPLATE = '71000000-0000-0000-0009-000000000001';

function buildService(): PromptResolutionService {
  return new PromptResolutionService(
    mockDepartmentRepository as never,
    mockPromptTemplateRepository as never,
    mockDepartmentAgentRepository as never,
    mockPromptVersionRepository as never,
  );
}

/** An APPROVED template row pinned at `approvedVersionNumber`. */
function approvedTemplate(id: string, approvedVersionNumber: number | null = 1) {
  return { id, status: 'APPROVED', approvedVersionNumber, currentVersionNumber: approvedVersionNumber, content: `mutable-content-of-${id}` };
}

describe('Live prompt chain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDepartmentRepository.findById.mockResolvedValue({ id: DEPT, tenantId: TENANT, defaultSummaryTemplate: null, promptConfig: null });
    mockDepartmentAgentRepository.findDefaultForDepartment.mockResolvedValue(null);
    mockPromptTemplateRepository.findById.mockResolvedValue(null);
    mockPromptVersionRepository.findByVersionNumber.mockResolvedValue(null);
    mockPromptVersionRepository.findLatestVersion.mockResolvedValue(null);
  });

  describe('tier 1a — agent livePromptTemplateId', () => {
    it('serves the agent binding’s immutable PromptVersion snapshot', async () => {
      mockDepartmentAgentRepository.findDefaultForDepartment.mockResolvedValue({
        id: 'agent-1',
        livePromptTemplateId: AGENT_TEMPLATE,
        promptTemplateId: 'base-note-template',
        pinnedVersionNumber: null,
      });
      mockPromptTemplateRepository.findById.mockResolvedValue(approvedTemplate(AGENT_TEMPLATE, 3));
      mockPromptVersionRepository.findByVersionNumber.mockResolvedValue({ versionNumber: 3, content: 'AGENT LIVE PROMPT v3' });

      const result = await buildService().resolve({ tenantId: TENANT, departmentId: DEPT, promptType: 'live' });

      expect(result.resolvedFrom).toBe('agent');
      expect(result.promptId).toBe(AGENT_TEMPLATE);
      expect(result.content).toBe('AGENT LIVE PROMPT v3');
      expect(result.resolvedVersionNumber).toBe(3);
      expect(result.resolvedAgentId).toBe('agent-1');
      expect(result.resolvedCapability).toBe('live');
    });

    it('NEVER falls back to the agent’s base promptTemplateId — a null live binding skips the tier', async () => {
      // The base binding is a clinical NOTE prompt; serving it as the live
      // running-note prompt is the same wrong-prompt class the pre-summary chain
      // exists to prevent.
      mockDepartmentAgentRepository.findDefaultForDepartment.mockResolvedValue({
        id: 'agent-1',
        livePromptTemplateId: null,
        promptTemplateId: 'base-note-template',
        pinnedVersionNumber: null,
      });
      mockPromptTemplateRepository.findById.mockImplementation(async (id: string) =>
        id === SYSTEM_DEFAULTS.livePromptId ? approvedTemplate(SYSTEM_DEFAULTS.livePromptId) : null,
      );
      mockPromptVersionRepository.findByVersionNumber.mockResolvedValue({ versionNumber: 1, content: 'SYSTEM LIVE DEFAULT' });

      const result = await buildService().resolve({ tenantId: TENANT, departmentId: DEPT, promptType: 'live' });

      expect(result.promptId).toBe(SYSTEM_DEFAULTS.livePromptId);
      expect(result.resolvedFrom).toBe('default');
      expect(mockPromptTemplateRepository.findById).not.toHaveBeenCalledWith('base-note-template');
    });

    it('falls through to the SYSTEM default when the bound live template is not APPROVED', async () => {
      mockDepartmentAgentRepository.findDefaultForDepartment.mockResolvedValue({
        id: 'agent-1',
        livePromptTemplateId: AGENT_TEMPLATE,
        promptTemplateId: 'base-note-template',
        pinnedVersionNumber: null,
      });
      mockPromptTemplateRepository.findById.mockImplementation(async (id: string) =>
        id === AGENT_TEMPLATE ? { id, status: 'DRAFT', approvedVersionNumber: null } : approvedTemplate(SYSTEM_DEFAULTS.livePromptId),
      );
      mockPromptVersionRepository.findByVersionNumber.mockResolvedValue({ versionNumber: 1, content: 'SYSTEM LIVE DEFAULT' });

      const result = await buildService().resolve({ tenantId: TENANT, departmentId: DEPT, promptType: 'live' });
      expect(result.resolvedFrom).toBe('default');
      expect(result.promptId).toBe(SYSTEM_DEFAULTS.livePromptId);
    });

    it('skips the agent tier entirely when the consultation has no department', async () => {
      mockPromptTemplateRepository.findById.mockResolvedValue(approvedTemplate(SYSTEM_DEFAULTS.livePromptId));
      mockPromptVersionRepository.findByVersionNumber.mockResolvedValue({ versionNumber: 1, content: 'SYSTEM LIVE DEFAULT' });

      const result = await buildService().resolve({ tenantId: TENANT, promptType: 'live' });

      expect(result.resolvedFrom).toBe('default');
      expect(mockDepartmentAgentRepository.findDefaultForDepartment).not.toHaveBeenCalled();
    });
  });

  describe('tier 3 — code-default fail-open (the documented exception)', () => {
    it('reports `code-default` with no promptId content when the SYSTEM default is unreadable', async () => {
      mockPromptTemplateRepository.findById.mockResolvedValue(null);

      const result = await buildService().resolve({ tenantId: TENANT, departmentId: DEPT, promptType: 'live' });

      expect(result.resolvedFrom).toBe('code-default');
      expect(result.content ?? null).toBeNull();
    });

    it('NEVER throws even when every repository read blows up (a live consultation must not be failed)', async () => {
      mockDepartmentRepository.findById.mockRejectedValue(new Error('db down'));
      mockDepartmentAgentRepository.findDefaultForDepartment.mockRejectedValue(new Error('db down'));
      mockPromptTemplateRepository.findById.mockRejectedValue(new Error('db down'));

      const result = await buildService().resolve({ tenantId: TENANT, departmentId: DEPT, promptType: 'live' });
      expect(result.resolvedFrom).toBe('code-default');
    });

    it('the SYSTEM default being unapproved degrades to code-default rather than a 503', async () => {
      // Contrast with pre-summary, which fails CLOSED on exactly this input.
      mockPromptTemplateRepository.findById.mockResolvedValue({ id: SYSTEM_DEFAULTS.livePromptId, status: 'DRAFT', approvedVersionNumber: null });

      const result = await buildService().resolve({ tenantId: TENANT, departmentId: DEPT, promptType: 'live' });
      expect(result.resolvedFrom).toBe('code-default');
    });
  });

  describe('regression lock — the other chains are untouched by the live chain', () => {
    it('pre-summary still fails CLOSED when nothing resolves (fail-open is live-only)', async () => {
      mockPromptTemplateRepository.findAll.mockResolvedValue([]);
      mockPromptTemplateRepository.findById.mockResolvedValue(null);

      await expect(buildService().resolve({ tenantId: TENANT, promptType: 'pre-summary' })).rejects.toThrow(/pre-summary/i);
    });

    it('the summary chain still lands on CATCHALL_SOAP and never on the live default', async () => {
      mockPromptTemplateRepository.findById.mockResolvedValue(approvedTemplate(SYSTEM_DEFAULTS.promptId));
      mockPromptVersionRepository.findByVersionNumber.mockResolvedValue({ versionNumber: 1, content: 'CATCHALL' });

      const result = await buildService().resolve({ tenantId: TENANT, departmentId: DEPT, promptType: 'new-patient' });
      expect(result.promptId).toBe(SYSTEM_DEFAULTS.promptId);
      expect(result.resolvedCapability).toBe('summary');
    });
  });
});
