/**
 * TASK-884 — the tag-selected agent tier, in the slot the retired `(task, visitType) -> prompt`
 * binding used to occupy (TASK-882 removed that with `consultation.visitTypes`).
 *
 * The distinction this suite protects is the point of owner decision #6: that tier was a
 * tenant-managed CONDITION table mapping a request axis onto a prompt. This one is not. It
 * selects an AGENT through the ordinary `AgentAssignment` cascade and serves whatever
 * instruction that agent already binds — no condition table, no department axis of its own, no
 * visit type anywhere.
 *
 * The load-bearing property is what happens when nothing is tagged: EVERY existing caller
 * passes no `agentSelectorTags`, and for them resolution must be byte-identical to before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptResolutionService, SYSTEM_DEFAULTS } from '../prompt-resolution.service';

const mockDepartmentRepository = { findById: vi.fn() };
const mockPromptTemplateRepository = { findById: vi.fn(), findAll: vi.fn() };
const mockPromptVersionRepository = { findByVersionNumber: vi.fn(), findLatestVersion: vi.fn() };
const mockWorkflowAssignments = { resolve: vi.fn(async () => null) };
const mockWorkflowDefinitionRepository = { findPublishedBySlug: vi.fn(async () => null) };
const mockVisitTypes = undefined;
const mockAgentAssignments = { resolve: vi.fn() };
const mockAgentRepository = { findPublishedActiveBySlug: vi.fn() };

const TENANT = 'tenant-884-001';
const DEPT = 'dept-884-001';
const RHEUM_TEMPLATE = '71000000-0000-0000-0884-000000000001';

function buildService(): PromptResolutionService {
  return new PromptResolutionService(
    mockDepartmentRepository as never,
    mockPromptTemplateRepository as never,
    mockPromptVersionRepository as never,
    mockWorkflowAssignments as never,
    mockWorkflowDefinitionRepository as never,
    mockVisitTypes as never,
    mockAgentAssignments as never,
    mockAgentRepository as never,
  );
}

function approvedTemplate(id: string) {
  return { id, status: 'APPROVED', approvedVersionNumber: 1, currentVersionNumber: 1, content: `content-of-${id}` };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDepartmentRepository.findById.mockResolvedValue({ id: DEPT, tenantId: TENANT, defaultSummaryTemplate: null, promptConfig: null, newPatientPromptId: null, revisitPromptId: null });
  mockPromptTemplateRepository.findById.mockImplementation(async (id: string) => approvedTemplate(id));
  mockPromptVersionRepository.findByVersionNumber.mockImplementation(async (_t: string, _id: string, version: number) => ({ versionNumber: version, content: 'snapshot' }));
  mockWorkflowAssignments.resolve.mockResolvedValue(null);
  mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(null);
  mockAgentAssignments.resolve.mockResolvedValue({ agentSlug: null, source: 'platform-default', selector: [] });
  mockAgentRepository.findPublishedActiveBySlug.mockResolvedValue(null);
});

describe('the tag-selected agent tier', () => {
  it('serves the tag-selected agent’s bound template ahead of every chain', async () => {
    mockAgentAssignments.resolve.mockResolvedValue({ agentSlug: 'rheum-notes', source: 'tenant', selector: ['specialty:rheumatology'] });
    mockAgentRepository.findPublishedActiveBySlug.mockResolvedValue({
      id: 'agent-rheum',
      versionNumber: 4,
      instruction: { promptTemplateId: RHEUM_TEMPLATE },
    });

    const result = await buildService().resolve({
      tenantId: TENANT,
      departmentId: DEPT,
      promptType: 'new-patient',
      agentSelectorTags: ['specialty:rheumatology'],
    });

    expect(result.promptId).toBe(RHEUM_TEMPLATE);
    expect(result.resolvedFrom).toBe('agent');
    expect(result.resolvedAgentId).toBe('agent-rheum');
    expect(result.content).toBe('snapshot');
    // The cascade is consulted with the request's tags and the department — the tier order is
    // the assignment's, not this service's.
    expect(mockAgentAssignments.resolve).toHaveBeenCalledWith(TENANT, 'TEXT_GENERATION', DEPT, ['specialty:rheumatology']);
  });

  it('does NOT consult the cascade at all when the request carries no tags', async () => {
    const result = await buildService().resolve({ tenantId: TENANT, departmentId: DEPT, promptType: 'new-patient' });
    expect(mockAgentAssignments.resolve).not.toHaveBeenCalled();
    expect(result.promptId).toBe(SYSTEM_DEFAULTS.promptId);
    expect(result.resolvedFrom).toBe('default');
  });

  it('falls through when the tags matched only the tier’s UNQUALIFIED row — that is the ordinary default', async () => {
    mockAgentAssignments.resolve.mockResolvedValue({ agentSlug: 'general-notes', source: 'tenant', selector: [] });
    const result = await buildService().resolve({
      tenantId: TENANT,
      departmentId: DEPT,
      promptType: 'new-patient',
      agentSelectorTags: ['specialty:cardiology'],
    });
    expect(mockAgentRepository.findPublishedActiveBySlug).not.toHaveBeenCalled();
    expect(result.resolvedFrom).toBe('default');
  });

  it('falls through when the selected agent binds an inline system prompt rather than a template', async () => {
    mockAgentAssignments.resolve.mockResolvedValue({ agentSlug: 'rheum-notes', source: 'tenant', selector: ['specialty:rheumatology'] });
    mockAgentRepository.findPublishedActiveBySlug.mockResolvedValue({ id: 'a1', versionNumber: 1, instruction: { systemPrompt: 'inline' } });

    const result = await buildService().resolve({ tenantId: TENANT, departmentId: DEPT, promptType: 'new-patient', agentSelectorTags: ['specialty:rheumatology'] });
    expect(result.resolvedFrom).toBe('default');
  });

  // The same governance every other tier answers to: an unapproved template is skipped so
  // resolution falls through to the approved default, never served because an agent named it.
  it('skips a template that is not APPROVED', async () => {
    mockAgentAssignments.resolve.mockResolvedValue({ agentSlug: 'rheum-notes', source: 'tenant', selector: ['specialty:rheumatology'] });
    mockAgentRepository.findPublishedActiveBySlug.mockResolvedValue({ id: 'a1', versionNumber: 1, instruction: { promptTemplateId: RHEUM_TEMPLATE } });
    mockPromptTemplateRepository.findById.mockImplementation(async (id: string) =>
      id === RHEUM_TEMPLATE ? { id, status: 'DRAFT', approvedVersionNumber: null, currentVersionNumber: 1, content: 'x' } : approvedTemplate(id),
    );

    const result = await buildService().resolve({ tenantId: TENANT, departmentId: DEPT, promptType: 'new-patient', agentSelectorTags: ['specialty:rheumatology'] });
    expect(result.promptId).toBe(SYSTEM_DEFAULTS.promptId);
    expect(result.resolvedFrom).toBe('default');
  });

  it('degrades to the ordinary chain when the cascade THROWS — a selector never takes out a generation call', async () => {
    mockAgentAssignments.resolve.mockRejectedValue(new Error('database is on fire'));
    const result = await buildService().resolve({ tenantId: TENANT, departmentId: DEPT, promptType: 'new-patient', agentSelectorTags: ['specialty:rheumatology'] });
    expect(result.resolvedFrom).toBe('default');
  });

  it('is simply absent when the cascade is unwired (a positionally-constructed background worker)', async () => {
    const unwired = new PromptResolutionService(
      mockDepartmentRepository as never,
      mockPromptTemplateRepository as never,
      mockPromptVersionRepository as never,
    );
    const result = await unwired.resolve({ tenantId: TENANT, departmentId: DEPT, promptType: 'new-patient', agentSelectorTags: ['specialty:rheumatology'] });
    expect(result.resolvedFrom).toBe('default');
  });

  it('applies to the LIVE and PRE-SUMMARY chains too — the tier sits above all three', async () => {
    mockAgentAssignments.resolve.mockResolvedValue({ agentSlug: 'rheum-notes', source: 'tenant', selector: ['specialty:rheumatology'] });
    mockAgentRepository.findPublishedActiveBySlug.mockResolvedValue({ id: 'agent-rheum', versionNumber: 1, instruction: { promptTemplateId: RHEUM_TEMPLATE } });

    for (const promptType of ['live', 'pre-summary'] as const) {
      const result = await buildService().resolve({ tenantId: TENANT, departmentId: DEPT, promptType, agentSelectorTags: ['specialty:rheumatology'] });
      expect(result.promptId, promptType).toBe(RHEUM_TEMPLATE);
      expect(result.resolvedFrom, promptType).toBe('agent');
    }
  });
});
