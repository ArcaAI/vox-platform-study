/**
 * `pinnedAgentId` in the summary chain.
 *
 * The finalize prompt must be decided by whatever actually RAN the live
 * session, not by whatever the tenant's configuration happens to say at
 * finalize time. That is contract R-N2, and it survives unchanged
 * only its SUBJECT moved. The pin used to name a `DepartmentAgent` row; it now
 * names a NODE in the governing workflow definition's graph. The PARAMETER
 * keeps its name because `resolve()`'s signature is a frozen v1-compat
 * contract.
 *
 * The four behaviours locked here are the same four as before:
 *
 *   1. a pinned node BEATS the graph's own first finalize node;
 *   2. a pin that no longer names a node serving this task falls through
 *      WITHOUT error (never a 500) — a graph re-authored mid-visit must not
 *      fail the finalize;
 *   3. tier-0 doctor-preferred still outranks the pin;
 *   4. NO `pinnedAgentId` ⇒ the graph's first finalize node, as before.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { PromptResolutionService } from '../prompt-resolution.service';
import type { DepartmentEntity } from '@arcaai/domains';

const TENANT = 'tenant-1';
const DEPT = 'dept-1';

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

function department(overrides: Record<string, unknown> = {}): DepartmentEntity {
  return {
    id: DEPT,
    code: 'GEN',
    name: 'General',
    tenantId: TENANT,
    defaultSummaryTemplate: null,
    preSummaryPromptId: null,
    newPatientPromptId: null,
    revisitPromptId: null,
    promptConfig: null,
    ...overrides,
  } as unknown as DepartmentEntity;
}

/** A finalize generation node bound to `promptTemplateId`. */
function finalizeNode(id: string, promptTemplateId: string, extraConfig: Record<string, unknown> = {}) {
  return { id, type: 'generate.text', config: { taskKey: 'text.finalize', promptTemplateId, ...extraConfig } };
}

function publishDefinition(nodes: unknown[]) {
  mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue({
    id: 'wfdef-1',
    slug: 'consultation-default',
    paletteKey: 'consultation',
    graph: { version: 1, nodes, edges: [] },
  });
}

describe('PromptResolutionService — pinnedAgentId', () => {
  let service: PromptResolutionService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => ({ id, status: 'APPROVED', approvedVersionNumber: 1 }));
    mockPromptTemplateRepository.findAll.mockResolvedValue([]);
    mockPromptVersionRepository.findByVersionNumber.mockImplementation(async (templateId: string, versionNumber: number) => ({
      content: `content-of-${templateId}-v${versionNumber}`,
      versionNumber,
    }));
    mockDepartmentRepository.findById.mockResolvedValue(department());
    mockWorkflowAssignments.resolve.mockResolvedValue({ workflowDefinitionSlug: 'consultation-default', source: 'department' });
    // The graph has been RE-AUTHORED since the session started: a new finalize
    // node was added FIRST, so the unpinned selection would now pick it.
    publishDefinition([finalizeNode('note_new_default', 'tpl-new-default'), finalizeNode('note_session', 'tpl-session')]);

    service = new PromptResolutionService(
      mockDepartmentRepository as never,
      mockPromptTemplateRepository as never,
      mockPromptVersionRepository as never,
      mockWorkflowAssignments as never,
      mockWorkflowDefinitionRepository as never,
    );
  });

  it('serves the PINNED node, not the graph’s new first finalize node', async () => {
    const result = await service.resolve({ departmentId: DEPT, promptType: 'new-patient', pinnedAgentId: 'note_session' });

    expect(result.promptId).toBe('tpl-session');
    expect(result.resolvedFrom).toBe('agent');
    expect(result.resolvedAgentId).toBe('note_session');
  });

  it('honours the pinned node’s OWN version pin', async () => {
    publishDefinition([finalizeNode('note_new_default', 'tpl-new-default'), finalizeNode('note_session', 'tpl-session', { promptVersionNumber: 4 })]);

    const result = await service.resolve({ departmentId: DEPT, promptType: 'revisit', pinnedAgentId: 'note_session' });

    expect(result.promptId).toBe('tpl-session');
    expect(result.resolvedVersionNumber).toBe(4);
  });

  it.each([
    ['the node was removed from the graph', [finalizeNode('note_new_default', 'tpl-new-default')]],
    [
      'the node still exists but no longer serves finalize',
      [
        finalizeNode('note_new_default', 'tpl-new-default'),
        { id: 'note_session', type: 'consultation.realtimeSummary', config: { promptTemplateId: 'tpl-session' } },
      ],
    ],
    [
      'the node lost its prompt binding entirely',
      [finalizeNode('note_new_default', 'tpl-new-default'), { id: 'note_session', type: 'generate.text', config: { taskKey: 'text.finalize' } }],
    ],
  ])('falls through to the graph’s first finalize node (no error) when %s', async (_label, nodes) => {
    publishDefinition(nodes);

    const result = await service.resolve({ departmentId: DEPT, promptType: 'new-patient', pinnedAgentId: 'note_session' });

    expect(result.promptId).toBe('tpl-new-default');
    expect(result.resolvedFrom).toBe('agent');
    expect(result.resolvedAgentId).toBe('note_new_default');
  });

  it('never throws when the definition lookup itself fails — the tier is skipped', async () => {
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockRejectedValue(new Error('db-down'));
    mockDepartmentRepository.findById.mockResolvedValue(department({ newPatientPromptId: 'tpl-dept' }));

    const result = await service.resolve({ departmentId: DEPT, promptType: 'new-patient', pinnedAgentId: 'note_session' });

    expect(result.promptId).toBe('tpl-dept');
    expect(result.resolvedFrom).toBe('department');
  });

  it('tier-0 doctor-preferred still outranks the pinned node', async () => {
    const result = await service.resolve({
      departmentId: DEPT,
      promptType: 'new-patient',
      pinnedAgentId: 'note_session',
      preferredPromptTemplateId: 'tpl-doctor',
    });

    expect(result.promptId).toBe('tpl-doctor');
    expect(result.resolvedFrom).toBe('preferred');
  });

  it('REGRESSION LOCK — without pinnedAgentId the graph’s first finalize node answers', async () => {
    const result = await service.resolve({ departmentId: DEPT, promptType: 'new-patient' });

    expect(result.promptId).toBe('tpl-new-default');
    expect(result.resolvedAgentId).toBe('note_new_default');
    expect(mockWorkflowAssignments.resolve).toHaveBeenCalledWith(TENANT, 'consultation', DEPT);
  });
});
