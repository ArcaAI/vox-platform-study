/**
 * The LIVE capability chain.
 *
 * Tier 1a the governing workflow definition's LIVE generation node — the node
 *          whose effective `taskKey` is `text.live` (APPROVED template + the
 * node's own pinned PromptVersion snapshot). moved this tier
 *          off `DepartmentAgent.livePromptTemplateId`; the tier's REPORTED name
 *          (`resolvedFrom: 'agent'`) is a frozen v1-compat contract and stays.
 * Tier 2 `SYSTEM_DEFAULTS.livePromptId` — the seeded SYSTEM live-default row
 * Tier 3 in-code constants, reported as `'code-default'` — the DOCUMENTED
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
// TASK-890 §3.4 (OD-M) — a `SYSTEM_DEFAULTS.*` pointer resolves the TENANT's clone of that
// platform template, matched on `sourceTemplateId`. These fixtures model a PROVISIONED tenant,
// where the clone stands in for the pointer, so the chain assertions below are unchanged; the
// unprovisioned case (`PROMPT_DEFAULT_NOT_PROVISIONED`) is pinned in
// `prompt-resolution.reference-set.task890.test.ts`.
const provisionedClone = async (_tenantId: string, sourceTemplateId: string) => ({ id: sourceTemplateId });
const mockPromptTemplateRepository = { findById: vi.fn(), findAll: vi.fn(), findByTenantAndSourceTemplateId: vi.fn(provisionedClone) };
const mockWorkflowAssignments = { resolve: vi.fn() };
const mockWorkflowDefinitionRepository = { findPublishedBySlug: vi.fn() };
const mockPromptVersionRepository = { findByVersionNumber: vi.fn(), findLatestVersion: vi.fn() };

const TENANT = 'tenant-live-001';
const DEPT = 'dept-live-001';
const AGENT_TEMPLATE = '71000000-0000-0000-0009-000000000001';

/** A published `consultation` definition whose graph carries `nodes`. */
function definitionWithNodes(nodes: unknown[]) {
  return { id: 'wfdef-1', slug: 'consultation-default', paletteKey: 'core', graph: { version: 1, nodes, edges: [] } };
}

/** The graph shape that used to be "a department default agent with a live binding". */
function graphWithLiveNode(promptTemplateId: string | null, promptVersionNumber?: number) {
  mockWorkflowAssignments.resolve.mockResolvedValue({ workflowDefinitionSlug: 'consultation-default', source: 'department' });
  mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(
    definitionWithNodes([
      // The finalize node is always present, and never eligible for the live
      // chain — the regression lock for "a note prompt must not be served live".
      { id: 'note_writer', type: 'core.agent', config: { taskKey: 'text.finalize', promptTemplateId: 'base-note-template' } },
      ...(promptTemplateId
        ? [
            {
              id: 'running_note',
              // TASK-893 — the tier selects on `promptTemplateId` + the EFFECTIVE task key, never
              // on node type (see `promptBearingNodesForTask`). The retired node types were the
              // only ones whose schema DECLARED a default `taskKey`, so the fixture states it.
              type: 'core.agent',
              config: { taskKey: 'text.live', promptTemplateId, ...(promptVersionNumber ? { promptVersionNumber } : {}) },
            },
          ]
        : []),
    ]),
  );
}

function buildService(): PromptResolutionService {
  return new PromptResolutionService(
    mockDepartmentRepository as never,
    mockPromptTemplateRepository as never,
    mockPromptVersionRepository as never,
    mockWorkflowAssignments as never,
    mockWorkflowDefinitionRepository as never,
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
    mockWorkflowAssignments.resolve.mockResolvedValue({ workflowDefinitionSlug: null, source: 'platform-default' });
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(null);
    mockPromptTemplateRepository.findById.mockResolvedValue(null);
    mockPromptVersionRepository.findByVersionNumber.mockResolvedValue(null);
    mockPromptVersionRepository.findLatestVersion.mockResolvedValue(null);
  });

  describe('tier 1a — the graph’s live generation node', () => {
    it('serves the node binding’s immutable PromptVersion snapshot', async () => {
      graphWithLiveNode(AGENT_TEMPLATE);
      mockPromptTemplateRepository.findById.mockResolvedValue(approvedTemplate(AGENT_TEMPLATE, 3));
      mockPromptVersionRepository.findByVersionNumber.mockResolvedValue({ versionNumber: 3, content: 'AGENT LIVE PROMPT v3' });

      const result = await buildService().resolve({ tenantId: TENANT, departmentId: DEPT, promptType: 'live' });

      expect(result.resolvedFrom).toBe('agent');
      expect(result.promptId).toBe(AGENT_TEMPLATE);
      expect(result.content).toBe('AGENT LIVE PROMPT v3');
      expect(result.resolvedVersionNumber).toBe(3);
      expect(result.resolvedAgentId).toBe('running_note');
      expect(result.resolvedCapability).toBe('live');
    });

    it('NEVER falls back to a finalize node’s prompt — a graph with no live node skips the tier', async () => {
      // A finalize binding is a clinical NOTE prompt; serving it as the live
      // running-note prompt is the same wrong-prompt class the pre-summary chain
      // exists to prevent.
      graphWithLiveNode(null);
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
      graphWithLiveNode(AGENT_TEMPLATE);
      mockPromptTemplateRepository.findById.mockImplementation(async (id: string) =>
        id === AGENT_TEMPLATE ? { id, status: 'DRAFT', approvedVersionNumber: null } : approvedTemplate(SYSTEM_DEFAULTS.livePromptId),
      );
      mockPromptVersionRepository.findByVersionNumber.mockResolvedValue({ versionNumber: 1, content: 'SYSTEM LIVE DEFAULT' });

      const result = await buildService().resolve({ tenantId: TENANT, departmentId: DEPT, promptType: 'live' });
      expect(result.resolvedFrom).toBe('default');
      expect(result.promptId).toBe(SYSTEM_DEFAULTS.livePromptId);
    });

    it('skips the node tier entirely when the consultation has no department', async () => {
      mockPromptTemplateRepository.findById.mockResolvedValue(approvedTemplate(SYSTEM_DEFAULTS.livePromptId));
      mockPromptVersionRepository.findByVersionNumber.mockResolvedValue({ versionNumber: 1, content: 'SYSTEM LIVE DEFAULT' });

      const result = await buildService().resolve({ tenantId: TENANT, promptType: 'live' });

      expect(result.resolvedFrom).toBe('default');
      expect(mockWorkflowAssignments.resolve).not.toHaveBeenCalled();
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
      mockWorkflowAssignments.resolve.mockRejectedValue(new Error('db down'));
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
