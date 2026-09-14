/**
 * TASK-974 §5.1 item 5 — the PLATFORM HIDDEN read.
 *
 * The SECOND declared family of two-tenant reads, beside the reference library it is modelled on
 * (`AgentRepository.reference.task890.test.ts`). It differs from that family in exactly one way,
 * and the difference is the whole safety argument: the reference library will serve ANY SYSTEM
 * slug, because provisioning legitimately iterates all of them, while this read serves ONLY the
 * slugs of the compiled-in allow-list. That is what stops a platform-service read from becoming
 * a general-purpose cross-tenant one.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_TENANT_ID } from '@arcaai/database';
import { AgentRepository, PLATFORM_HIDDEN_AGENT_SLUGS } from '../AgentRepository';
import { AgentTask, ResourceStatusType, WorkflowDefinitionStatus } from '../../../../enums';

const row = {
  id: 'agent-hidden-1',
  tenantId: SYSTEM_TENANT_ID,
  slug: 'dna-writing-style-analyst',
  name: 'DNA writing-style analyst',
  description: null,
  task: AgentTask.TEXT_GENERATION,
  versionNumber: 1,
  parentVersionId: null,
  status: WorkflowDefinitionStatus.PUBLISHED,
  isActive: true,
  modelId: 'model-1',
  instruction: { systemPrompt: 'Analyze.' },
  parameters: { generation: { temperature: 0 } },
  inputSchema: null,
  outputSchema: { type: 'object' },
  tools: null,
  compiledConfig: { models: [] },
  compiledConfigChecksum: 'sha256:x',
  validationReport: null,
  validatedAt: null,
  publishedAt: new Date(),
  deprecatedAt: null,
  resourceStatus: ResourceStatusType.ENABLED,
  resourceStatusUpdatedAt: null,
  resourceStatusUpdatedBy: null,
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
  createdBy: null,
  updatedBy: null,
  metaData: null,
  tags: ['visibility:hidden'],
  contextSchemaId: null,
  contextSchemaVersionNumber: null,
  sourceAgentId: null,
  sourceTenantId: null,
  sourceSlug: null,
  sourceVersionNumber: null,
};

function makeRepo() {
  const scoped = { findFirst: vi.fn(), findMany: vi.fn(), aggregate: vi.fn() };
  const unitOfWork = { getDatabaseService: () => ({ agent: scoped }) };
  const base = { agent: { findFirst: vi.fn(), findMany: vi.fn() } };
  return { scoped, base, repo: new AgentRepository(unitOfWork as any) };
}

describe('AgentRepository.findPlatformHiddenBySlug (TASK-974)', () => {
  let scoped: ReturnType<typeof makeRepo>['scoped'];
  let base: ReturnType<typeof makeRepo>['base'];
  let repo: AgentRepository;
  beforeEach(() => ({ scoped, base, repo } = makeRepo()));

  it('reads the SUPPLIED unscoped client with an EXPLICIT SYSTEM pin and the live predicate', async () => {
    base.agent.findFirst.mockResolvedValue(row);

    const entity = await repo.findPlatformHiddenBySlug(base, 'dna-writing-style-analyst');

    expect(entity?.id).toBe('agent-hidden-1');
    expect(entity?.tenantId).toBe(SYSTEM_TENANT_ID);
    // The SCOPED delegate would merge the CALLER's tenant into the where and answer nothing.
    expect(scoped.findFirst).not.toHaveBeenCalled();
    expect(base.agent.findFirst.mock.calls[0][0].where).toEqual({
      slug: 'dna-writing-style-analyst',
      tenantId: SYSTEM_TENANT_ID,
      status: WorkflowDefinitionStatus.PUBLISHED,
      isActive: true,
      resourceStatus: ResourceStatusType.ENABLED,
    });
  });

  it('answers null — never a throw — when SYSTEM carries no live row for the slug', async () => {
    base.agent.findFirst.mockResolvedValue(null);
    expect(await repo.findPlatformHiddenBySlug(base, 'dna-writing-style-analyst')).toBeNull();
  });

  it('REFUSES a slug outside the allow-list without touching the database at all', async () => {
    await expect(repo.findPlatformHiddenBySlug(base, 'casenote-finalization')).rejects.toThrow(/not a platform hidden agent/i);
    await expect(repo.findPlatformHiddenBySlug(base, '')).rejects.toThrow(/not a platform hidden agent/i);
    expect(base.agent.findFirst).not.toHaveBeenCalled();
    expect(scoped.findFirst).not.toHaveBeenCalled();
  });

  it('declares the allow-list the applications-tier registry mirrors', () => {
    expect([...PLATFORM_HIDDEN_AGENT_SLUGS]).toEqual(['dna-writing-style-analyst']);
  });
});
