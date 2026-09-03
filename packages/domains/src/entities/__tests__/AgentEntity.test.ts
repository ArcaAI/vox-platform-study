/**
 * TASK-863 — AgentEntity structural invariants (rule 03: structural only; the
 * cross-aggregate rules — model task match, template approval, availability —
 * live in AgentService).
 */
import { describe, expect, it } from 'vitest';
import { AgentEntity, type IAgentEntity } from '../generated/core/AgentEntity';
import { AgentAssignmentEntity } from '../generated/core/AgentAssignmentEntity';
import { AgentModelFallbackEntity } from '../generated/core/AgentModelFallbackEntity';
import { AgentTask, PipelinePolicyScope, WorkflowDefinitionStatus } from '../../enums';

function valid(overrides: Partial<IAgentEntity> = {}): IAgentEntity {
  return {
    id: 'agent-1',
    tenantId: '50000000-0000-0000-0000-000000000000',
    slug: 'platform-summarization',
    name: 'Platform summarization',
    task: AgentTask.TEXT_GENERATION,
    versionNumber: 1,
    status: WorkflowDefinitionStatus.DRAFT,
    isActive: false,
    modelId: 'model-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as IAgentEntity;
}

describe('AgentEntity.validate()', () => {
  it('accepts a valid DRAFT', () => {
    expect(() => new AgentEntity(valid()).validate()).not.toThrow();
  });

  it.each(['', 'Bad Slug', '-lead', 'trail-', 'a'])('rejects slug %j', (slug) => {
    expect(() => new AgentEntity(valid({ slug })).validate()).toThrow(/slug/i);
  });

  it('requires a name, a task, a model and a positive integer versionNumber', () => {
    expect(() => new AgentEntity(valid({ name: ' ' })).validate()).toThrow(/name/i);
    expect(() => new AgentEntity(valid({ task: undefined as never })).validate()).toThrow(/task/i);
    expect(() => new AgentEntity(valid({ modelId: '' })).validate()).toThrow(/model/i);
    expect(() => new AgentEntity(valid({ versionNumber: 0 })).validate()).toThrow(/versionNumber/i);
  });

  it('requires a compiledConfig once PUBLISHED', () => {
    expect(() => new AgentEntity(valid({ status: WorkflowDefinitionStatus.PUBLISHED })).validate()).toThrow(/compiledConfig/i);
    expect(() => new AgentEntity(valid({ status: WorkflowDefinitionStatus.PUBLISHED, compiledConfig: { models: [] } })).validate()).not.toThrow();
  });

  it('refuses isActive on a row that is not PUBLISHED', () => {
    expect(() => new AgentEntity(valid({ isActive: true })).validate()).toThrow(/isActive/i);
  });

  it('refuses tools on a non-TEXT_GENERATION agent and non-object JSON columns', () => {
    expect(() => new AgentEntity(valid({ task: AgentTask.TEXT_TO_SPEECH, tools: [{ mcpServerId: 'x', toolName: 'y' }] })).validate()).toThrow(/tools/i);
    expect(() => new AgentEntity(valid({ parameters: [] as never })).validate()).toThrow(/parameters/i);
  });

  it('tracks changes through setters', () => {
    const entity = new AgentEntity(valid());
    entity.name = 'Renamed';
    expect(entity.hasChanges).toBe(true);
    expect(entity.changes).toMatchObject({ name: 'Renamed' });
  });
});

describe('AgentModelFallbackEntity.validate()', () => {
  it('requires a non-negative integer priority and both ids', () => {
    const base = { id: 'f1', tenantId: 't', agentId: 'a', modelId: 'm', priority: 0, enabled: true, createdAt: new Date(), updatedAt: new Date() };
    expect(() => new AgentModelFallbackEntity(base as never).validate()).not.toThrow();
    expect(() => new AgentModelFallbackEntity({ ...base, priority: -1 } as never).validate()).toThrow(/priority/i);
    expect(() => new AgentModelFallbackEntity({ ...base, modelId: '' } as never).validate()).toThrow(/model/i);
  });
});

describe('AgentAssignmentEntity.validate()', () => {
  const base = { id: 'as1', tenantId: 't', scope: PipelinePolicyScope.TENANT, scopeId: null, task: AgentTask.SPEECH_TO_TEXT, agentSlug: 'platform-transcription', createdAt: new Date(), updatedAt: new Date() };
  it('mirrors WorkflowAssignment: TENANT scope has no scopeId, DEPARTMENT scope requires one', () => {
    expect(() => new AgentAssignmentEntity(base as never).validate()).not.toThrow();
    expect(() => new AgentAssignmentEntity({ ...base, scopeId: 'dept' } as never).validate()).toThrow(/scopeId/i);
    expect(() => new AgentAssignmentEntity({ ...base, scope: PipelinePolicyScope.DEPARTMENT } as never).validate()).toThrow(/scopeId/i);
    expect(() => new AgentAssignmentEntity({ ...base, agentSlug: '' } as never).validate()).toThrow(/agentSlug/i);
  });
});
