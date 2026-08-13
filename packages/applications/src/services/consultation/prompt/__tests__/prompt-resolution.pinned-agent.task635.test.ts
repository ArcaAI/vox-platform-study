/**
 * `pinnedAgentId` in the summary chain.
 *
 * The finalize prompt must be decided by the agent that actually RAN the live
 * session, not by whatever the department default happens to be at finalize
 * time. These tests lock the four behaviours of pinned-agent resolution:
 *
 *   1. a pinned agent BEATS a re-pointed department default;
 *   2. a pinned agent that no longer exists / belongs to another tenant or
 *      department / is not ENABLED falls through WITHOUT error (never a 500);
 *   3. tier-0 doctor-preferred still outranks the pinned agent;
 *   4. NO `pinnedAgentId` ⇒ byte-identical to pre-C5 (`findDefaultForDepartment`
 *      only, `findById` never consulted).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { PromptResolutionService } from '../prompt-resolution.service';
import type { DepartmentEntity } from '@arcaai/domains';

const TENANT = 'tenant-1';
const DEPT = 'dept-1';

const mockDepartmentRepository = { findById: vi.fn() };
const mockPromptTemplateRepository = { findById: vi.fn(), findAll: vi.fn() };
const mockDepartmentAgentRepository = { findDefaultForDepartment: vi.fn(), findById: vi.fn() };
const mockPromptVersionRepository = { findByVersionNumber: vi.fn(), findLatestVersion: vi.fn() };

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

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-session',
    tenantId: TENANT,
    departmentId: DEPT,
    resourceStatus: 'ENABLED',
    promptTemplateId: 'tpl-session',
    pinnedVersionNumber: null,
    newPatientTemplateId: null,
    revisitTemplateId: null,
    preSummaryTemplateId: null,
    livePromptTemplateId: null,
    ...overrides,
  };
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
    // The department default has been RE-POINTED since the session started.
    mockDepartmentAgentRepository.findDefaultForDepartment.mockResolvedValue(agent({ id: 'agent-new-default', promptTemplateId: 'tpl-new-default' }));
    mockDepartmentAgentRepository.findById.mockResolvedValue(agent());

    service = new PromptResolutionService(
      mockDepartmentRepository as never,
      mockPromptTemplateRepository as never,
      mockDepartmentAgentRepository as never,
      mockPromptVersionRepository as never,
    );
  });

  it('serves the PINNED agent, not the re-pointed department default', async () => {
    const result = await service.resolve({ departmentId: DEPT, promptType: 'new-patient', pinnedAgentId: 'agent-session' });

    expect(result.promptId).toBe('tpl-session');
    expect(result.resolvedFrom).toBe('agent');
    expect(result.resolvedAgentId).toBe('agent-session');
    expect(mockDepartmentAgentRepository.findById).toHaveBeenCalledWith('agent-session');
    expect(mockDepartmentAgentRepository.findDefaultForDepartment).not.toHaveBeenCalled();
  });

  it('honours the pinned agent VISIT-TYPE binding', async () => {
    mockDepartmentAgentRepository.findById.mockResolvedValue(agent({ revisitTemplateId: 'tpl-session-revisit' }));

    const result = await service.resolve({ departmentId: DEPT, promptType: 'revisit', pinnedAgentId: 'agent-session' });

    expect(result.promptId).toBe('tpl-session-revisit');
  });

  it.each([
    ['the agent row is gone', null],
    ['the agent belongs to another tenant', agent({ tenantId: 'tenant-other' })],
    ['the agent moved to another department', agent({ departmentId: 'dept-other' })],
    ['the agent is not ENABLED', agent({ resourceStatus: 'ARCHIVED' })],
  ])('falls through to the department default (no error) when %s', async (_label, row) => {
    mockDepartmentAgentRepository.findById.mockResolvedValue(row);

    const result = await service.resolve({ departmentId: DEPT, promptType: 'new-patient', pinnedAgentId: 'agent-session' });

    expect(result.promptId).toBe('tpl-new-default');
    expect(result.resolvedFrom).toBe('agent');
    expect(mockDepartmentAgentRepository.findDefaultForDepartment).toHaveBeenCalled();
  });

  it('never throws when the pinned lookup itself fails', async () => {
    mockDepartmentAgentRepository.findById.mockRejectedValue(new Error('db-down'));

    const result = await service.resolve({ departmentId: DEPT, promptType: 'new-patient', pinnedAgentId: 'agent-session' });

    expect(result.promptId).toBe('tpl-new-default');
  });

  it('tier-0 doctor-preferred still outranks the pinned agent', async () => {
    const result = await service.resolve({
      departmentId: DEPT,
      promptType: 'new-patient',
      pinnedAgentId: 'agent-session',
      preferredPromptTemplateId: 'tpl-doctor',
    });

    expect(result.promptId).toBe('tpl-doctor');
    expect(result.resolvedFrom).toBe('preferred');
  });

  it('REGRESSION LOCK — without pinnedAgentId the agent lookup is unchanged', async () => {
    const result = await service.resolve({ departmentId: DEPT, promptType: 'new-patient' });

    expect(result.promptId).toBe('tpl-new-default');
    expect(mockDepartmentAgentRepository.findById).not.toHaveBeenCalled();
    expect(mockDepartmentAgentRepository.findDefaultForDepartment).toHaveBeenCalledWith(TENANT, DEPT);
  });
});
