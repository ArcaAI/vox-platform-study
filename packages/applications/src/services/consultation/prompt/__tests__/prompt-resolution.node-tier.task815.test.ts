/**
 * Tier-1a moves off `DepartmentAgent` onto WORKFLOW NODE CONFIG.
 *
 * ## The contract this suite exists to protect
 *
 * `PromptResolutionService.resolve()` is reached by a FROZEN v1-compat wire
 * route (`TextCompatController` → `TextCompatTemplateService.resolveGovernedInstruction()`),
 * so the retirement's hard acceptance criterion is that the method keeps its
 * public signature and `ResolvedPromptConfig` keeps its field set —
 * `resolvedFrom`, `resolvedAgentId`, `content`, `resolvedVersionNumber` — while
 * the INTERNAL source of the agent tier changes. Every assertion below is
 * written against those four fields for exactly that reason.
 *
 * ## What replaced what
 *
 * | Before | After |
 * |---|---|
 * | `DepartmentAgentRepository.findDefaultForDepartment(tenant, dept)` | `IWorkflowAssignmentService.resolve(tenant, 'consultation', dept)` → the ACTIVE PUBLISHED definition |
 * | the agent's capability column (`livePromptTemplateId` / `newPatientTemplateId` / …) | the node's `config.promptTemplateId`, selected by the node's effective `taskKey` |
 * | `DepartmentAgent.pinnedVersionNumber` | the node's own `config.promptVersionNumber` pin |
 * | `resolvedAgentId` = the agent row id | `resolvedAgentId` = the workflow NODE id |
 *
 * The department AXIS survives unchanged: `WorkflowAssignmentService.resolve`
 * walks `department → tenant → platform default`, which is the same scoping the
 * department default agent gave the tier.
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
const mockPromptVersionRepository = { findByVersionNumber: vi.fn(), findLatestVersion: vi.fn() };
const mockWorkflowAssignments = { resolve: vi.fn() };
const mockWorkflowDefinitionRepository = { findPublishedBySlug: vi.fn() };

const TENANT = 'tenant-node-001';
const DEPT = 'dept-node-001';
const LIVE_TEMPLATE = '71000000-0000-0000-0009-000000000001';
const FINALIZE_TEMPLATE = '71000000-0000-0000-0009-000000000002';

function buildService(): PromptResolutionService {
  return new PromptResolutionService(
    mockDepartmentRepository as never,
    mockPromptTemplateRepository as never,
    mockPromptVersionRepository as never,
    mockWorkflowAssignments as never,
    mockWorkflowDefinitionRepository as never,
  );
}

function approvedTemplate(id: string, approvedVersionNumber: number | null = 1) {
  return { id, status: 'APPROVED', approvedVersionNumber, currentVersionNumber: approvedVersionNumber, content: `mutable-content-of-${id}` };
}

/** A published definition whose graph carries `nodes`. */
function definitionWithNodes(nodes: unknown[]) {
  return { id: 'wfdef-row-1', slug: 'consultation-default', paletteKey: 'consultation', graph: { version: 1, nodes, edges: [] } };
}

describe('Tier-1a — workflow node config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDepartmentRepository.findById.mockResolvedValue({ id: DEPT, tenantId: TENANT, defaultSummaryTemplate: null, promptConfig: null });
    mockPromptTemplateRepository.findById.mockResolvedValue(null);
    mockPromptVersionRepository.findByVersionNumber.mockResolvedValue(null);
    mockPromptVersionRepository.findLatestVersion.mockResolvedValue(null);
    mockWorkflowAssignments.resolve.mockResolvedValue({ workflowDefinitionSlug: null, source: 'platform-default' });
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(null);
  });

  describe('the LIVE chain', () => {
    it('serves the pinned PromptVersion of the node whose effective taskKey is text.live', async () => {
      mockWorkflowAssignments.resolve.mockResolvedValue({ workflowDefinitionSlug: 'consultation-default', source: 'department' });
      mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(
        definitionWithNodes([
          { id: 'note_writer', type: 'consultation.synthesize', config: { taskKey: 'text.finalize', promptTemplateId: FINALIZE_TEMPLATE } },
          { id: 'running_note', type: 'consultation.realtimeSummary', config: { promptTemplateId: LIVE_TEMPLATE, promptVersionNumber: 3 } },
        ]),
      );
      mockPromptTemplateRepository.findById.mockResolvedValue(approvedTemplate(LIVE_TEMPLATE, 7));
      mockPromptVersionRepository.findByVersionNumber.mockResolvedValue({ versionNumber: 3, content: 'NODE LIVE PROMPT v3' });

      const result = await buildService().resolve({ tenantId: TENANT, departmentId: DEPT, promptType: 'live' });

      expect(result.resolvedFrom).toBe('agent');
      expect(result.promptId).toBe(LIVE_TEMPLATE);
      expect(result.content).toBe('NODE LIVE PROMPT v3');
      // The NODE's own pin (3) wins over the template's approvedVersionNumber (7) — DD-11.
      expect(result.resolvedVersionNumber).toBe(3);
      expect(result.resolvedAgentId).toBe('running_note');
      expect(result.resolvedCapability).toBe('live');
    });

    it('falls back to the schema DEFAULT taskKey when the node does not state one', async () => {
      // `consultation.realtimeSummary` declares `taskKey` with `default: 'text.live'`,
      // so a node that omits the key is still a live node. Reading the default
      // from the registry is what keeps authored graphs and the resolver agreeing.
      mockWorkflowAssignments.resolve.mockResolvedValue({ workflowDefinitionSlug: 'consultation-default', source: 'tenant' });
      mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(
        definitionWithNodes([{ id: 'running_note', type: 'consultation.realtimeSummary', config: { promptTemplateId: LIVE_TEMPLATE } }]),
      );
      mockPromptTemplateRepository.findById.mockResolvedValue(approvedTemplate(LIVE_TEMPLATE, 2));
      mockPromptVersionRepository.findByVersionNumber.mockResolvedValue({ versionNumber: 2, content: 'NODE LIVE PROMPT v2' });

      const result = await buildService().resolve({ tenantId: TENANT, departmentId: DEPT, promptType: 'live' });

      expect(result.resolvedFrom).toBe('agent');
      expect(result.resolvedAgentId).toBe('running_note');
      expect(result.resolvedVersionNumber).toBe(2);
    });

    it('skips the tier when the graph has no live node — never serves a finalize prompt live', async () => {
      // Same wrong-prompt class the pre-summary split exists to kill: a note
      // prompt served as the running-note prompt.
      mockWorkflowAssignments.resolve.mockResolvedValue({ workflowDefinitionSlug: 'consultation-default', source: 'tenant' });
      mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(
        definitionWithNodes([
          { id: 'note_writer', type: 'consultation.synthesize', config: { taskKey: 'text.finalize', promptTemplateId: FINALIZE_TEMPLATE } },
        ]),
      );
      mockPromptTemplateRepository.findById.mockImplementation(async (id: string) =>
        id === SYSTEM_DEFAULTS.livePromptId ? approvedTemplate(SYSTEM_DEFAULTS.livePromptId) : null,
      );
      mockPromptVersionRepository.findByVersionNumber.mockResolvedValue({ versionNumber: 1, content: 'SYSTEM LIVE DEFAULT' });

      const result = await buildService().resolve({ tenantId: TENANT, departmentId: DEPT, promptType: 'live' });

      expect(result.promptId).toBe(SYSTEM_DEFAULTS.livePromptId);
      expect(result.resolvedFrom).toBe('default');
      expect(result.resolvedAgentId).toBeUndefined();
    });
  });

  describe('the SUMMARY chain', () => {
    it('serves the text.finalize node and reports its node id as resolvedAgentId', async () => {
      mockWorkflowAssignments.resolve.mockResolvedValue({ workflowDefinitionSlug: 'consultation-default', source: 'department' });
      mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(
        definitionWithNodes([
          { id: 'note_writer', type: 'generate.text', config: { taskKey: 'text.finalize', promptTemplateId: FINALIZE_TEMPLATE } },
        ]),
      );
      mockPromptTemplateRepository.findById.mockResolvedValue(approvedTemplate(FINALIZE_TEMPLATE, 5));
      mockPromptVersionRepository.findByVersionNumber.mockResolvedValue({ versionNumber: 5, content: 'NODE FINALIZE PROMPT v5' });

      const result = await buildService().resolve({ tenantId: TENANT, departmentId: DEPT, promptType: 'new-patient' });

      expect(result.resolvedFrom).toBe('agent');
      expect(result.promptId).toBe(FINALIZE_TEMPLATE);
      expect(result.resolvedAgentId).toBe('note_writer');
      expect(result.resolvedVersionNumber).toBe(5);
      expect(result.resolutionTrace.agentId).toBe('note_writer');
    });

    it('honours pinnedAgentId as a NODE pin, and falls through to the first node when it cannot be honoured', async () => {
      // R-N2: the node that ran the live session is the node that finalizes it.
      // A pin that no longer names a node in the governing graph degrades to the
      // normal first-node resolution — a finalize must never fail because the
      // graph was re-authored mid-visit.
      mockWorkflowAssignments.resolve.mockResolvedValue({ workflowDefinitionSlug: 'consultation-default', source: 'tenant' });
      mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(
        definitionWithNodes([
          { id: 'note_a', type: 'generate.text', config: { taskKey: 'text.finalize', promptTemplateId: FINALIZE_TEMPLATE } },
          { id: 'note_b', type: 'generate.text', config: { taskKey: 'text.finalize', promptTemplateId: LIVE_TEMPLATE } },
        ]),
      );
      mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => approvedTemplate(id, 1));
      mockPromptVersionRepository.findByVersionNumber.mockImplementation(async (id: string) => ({ versionNumber: 1, content: `content-${id}` }));

      const pinned = await buildService().resolve({ tenantId: TENANT, departmentId: DEPT, promptType: 'revisit', pinnedAgentId: 'note_b' });
      expect(pinned.resolvedAgentId).toBe('note_b');
      expect(pinned.promptId).toBe(LIVE_TEMPLATE);

      const stalePin = await buildService().resolve({ tenantId: TENANT, departmentId: DEPT, promptType: 'revisit', pinnedAgentId: 'deleted_node' });
      expect(stalePin.resolvedAgentId).toBe('note_a');
      expect(stalePin.promptId).toBe(FINALIZE_TEMPLATE);
    });

    it('falls through to the department column when the node template is NOT approved', async () => {
      mockWorkflowAssignments.resolve.mockResolvedValue({ workflowDefinitionSlug: 'consultation-default', source: 'tenant' });
      mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(
        definitionWithNodes([
          { id: 'note_writer', type: 'generate.text', config: { taskKey: 'text.finalize', promptTemplateId: FINALIZE_TEMPLATE } },
        ]),
      );
      mockDepartmentRepository.findById.mockResolvedValue({
        id: DEPT,
        tenantId: TENANT,
        defaultSummaryTemplate: null,
        promptConfig: null,
        newPatientPromptId: 'dept-template',
      });
      mockPromptTemplateRepository.findById.mockImplementation(async (id: string) =>
        id === FINALIZE_TEMPLATE ? { id, status: 'DRAFT', approvedVersionNumber: null } : approvedTemplate(id, 1),
      );
      mockPromptVersionRepository.findByVersionNumber.mockResolvedValue({ versionNumber: 1, content: 'DEPT CONTENT' });

      const result = await buildService().resolve({ tenantId: TENANT, departmentId: DEPT, promptType: 'new-patient' });

      expect(result.resolvedFrom).toBe('department');
      expect(result.promptId).toBe('dept-template');
    });
  });

  describe('totality', () => {
    it('never throws when the assignment lookup fails — the tier is skipped', async () => {
      mockWorkflowAssignments.resolve.mockRejectedValue(new Error('assignment backend down'));
      mockPromptTemplateRepository.findById.mockImplementation(async (id: string) =>
        id === SYSTEM_DEFAULTS.livePromptId ? approvedTemplate(SYSTEM_DEFAULTS.livePromptId) : null,
      );
      mockPromptVersionRepository.findByVersionNumber.mockResolvedValue({ versionNumber: 1, content: 'SYSTEM LIVE DEFAULT' });

      const result = await buildService().resolve({ tenantId: TENANT, departmentId: DEPT, promptType: 'live' });
      expect(result.resolvedFrom).toBe('default');
    });

    it('skips the tier entirely when the resolver is not wired (background workers)', async () => {
      const service = new PromptResolutionService(
        mockDepartmentRepository as never,
        mockPromptTemplateRepository as never,
        mockPromptVersionRepository as never,
      );
      mockPromptTemplateRepository.findById.mockImplementation(async (id: string) =>
        id === SYSTEM_DEFAULTS.promptId ? approvedTemplate(SYSTEM_DEFAULTS.promptId) : null,
      );
      mockPromptVersionRepository.findByVersionNumber.mockResolvedValue({ versionNumber: 1, content: 'CATCHALL' });

      const result = await service.resolve({ tenantId: TENANT, departmentId: DEPT, promptType: 'new-patient' });
      expect(result.resolvedFrom).toBe('default');
      expect(result.resolvedAgentId).toBeUndefined();
    });
  });
});
