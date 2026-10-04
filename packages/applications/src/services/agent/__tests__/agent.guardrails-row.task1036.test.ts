/**
 * TASK-1036 OD-1 — guardrails stay ALWAYS ON (TASK-1035 OD-1 stands). The agent detail carries a
 * read-only, informational `guardrails: 'always_on'` so the editor renders "Guardrails: always on"
 * from the server's word rather than a console literal. It is not a setting: no request DTO
 * accepts it and nothing reads it back.
 */
import { describe, expect, it } from 'vitest';
import { AgentTask, ResourceStatusType, WorkflowDefinitionStatus } from '@arcaai/domains';
import { AgentDtoMapper } from '../agent.dto.mapper';
import { CreateAgentRequest, UpdateAgentRequest } from '../dto';

const entity = {
  id: 'a1',
  tenantId: 't1',
  slug: 'note',
  name: 'Note',
  description: null,
  task: AgentTask.TEXT_GENERATION,
  versionNumber: 1,
  status: WorkflowDefinitionStatus.DRAFT,
  isActive: false,
  modelId: 'm1',
  resourceStatus: ResourceStatusType.ENABLED,
  tags: [],
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
} as never;

describe('agent detail — guardrails row (OD-1)', () => {
  it('reports guardrails: always_on', () => {
    expect(AgentDtoMapper.toResponse(entity).guardrails).toBe('always_on');
  });

  it('is not writable: neither request DTO declares it', () => {
    expect(Object.keys(new CreateAgentRequest())).not.toContain('guardrails');
    expect('guardrails' in UpdateAgentRequest.prototype).toBe(false);
  });
});
