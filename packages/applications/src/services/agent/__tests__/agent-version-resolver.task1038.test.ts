/**
 * TASK-1038 — resolve ONE pinned agent version (D-A, the gateway half).
 *
 * A published workflow pins `agentRef.versionNumber`; the harness used to resolve the ACTIVE
 * version and only REFUSE on drift, so republishing an agent broke (or silently changed) every
 * workflow that pinned it. This resolves exactly the pinned version — PUBLISHED, or DEPRECATED
 * (owner decision OD-21: a pinned version keeps running after it is deprecated) — through the
 * SAME materialisation `AgentResolverService` performs, so the harness gets the identical shape.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { AgentTask, SYSTEM_TENANT_ID, WorkflowDefinitionStatus } from '@arcaai/domains';
import { AgentResolverService } from '../agent-resolver.service';
import { AgentVersionResolverService } from '../agent-version-resolver.service';

const TENANT = '50000000-0000-0000-0000-000000000000';
const OTHER = '60000000-0000-0000-0000-000000000000';

const compiled = (modelSlug: string) => ({
  task: 'TEXT_GENERATION',
  service: 'llm',
  model: { id: `model-${modelSlug}`, slug: modelSlug, provider: 'lm-studio', taskType: 'TEXT_GENERATION' },
  fallbacks: [],
  instruction: { systemPrompt: `prompt of ${modelSlug}` },
  resolvedPrompt: null,
  parameters: {},
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  tools: [],
});

const version = (versionNumber: number, status: WorkflowDefinitionStatus, over: Record<string, unknown> = {}) => ({
  id: `agent-v${versionNumber}`,
  tenantId: TENANT,
  slug: 'clinic-summarizer',
  versionNumber,
  status,
  task: AgentTask.TEXT_GENERATION,
  compiledConfig: compiled(`model-v${versionNumber}`),
  ...over,
});

const agentRepository = { findPublishedActiveBySlug: vi.fn(), findAllVersionsBySlug: vi.fn() };
const aiModelRepository = {
  findById: vi.fn(async (id: string) => ({ id, tenantId: SYSTEM_TENANT_ID, slug: id.replace('model-', ''), sourceUri: 'hf:x', format: 'GGUF', provider: 'lm-studio' })),
  findBySlug: vi.fn(),
};

function make() {
  const resolver = new AgentResolverService(
    agentRepository as never,
    { findByAgentId: vi.fn(async () => []) } as never,
    aiModelRepository as never,
    { resolve: vi.fn() } as never,
    { resolveTenantCloudOverrides: vi.fn(async () => ({ overrides: {} })) } as never,
  );
  return { resolver, service: new AgentVersionResolverService(agentRepository as never, resolver) };
}

beforeEach(() => {
  vi.clearAllMocks();
  // v4 is the ACTIVE version; v3 is what the workflow pinned.
  agentRepository.findPublishedActiveBySlug.mockResolvedValue(version(4, WorkflowDefinitionStatus.PUBLISHED));
  agentRepository.findAllVersionsBySlug.mockImplementation(async (tenantId: string) =>
    tenantId === TENANT
      ? [
          version(5, WorkflowDefinitionStatus.DRAFT),
          version(4, WorkflowDefinitionStatus.PUBLISHED),
          version(3, WorkflowDefinitionStatus.PUBLISHED),
          version(2, WorkflowDefinitionStatus.DEPRECATED),
        ]
      : [],
  );
});

describe('AgentVersionResolverService.resolveVersion', () => {
  it('serves the PINNED version, not the active one, in the resolver`s own shape', async () => {
    const { service, resolver } = make();
    const pinned = await service.resolveVersion({ tenantId: TENANT, slug: 'clinic-summarizer', versionNumber: 3 });
    const active = await resolver.resolve({ tenantId: TENANT, agentSlug: 'clinic-summarizer' });

    expect(pinned).toMatchObject({ agentVersionId: 'agent-v3', versionNumber: 3, slug: 'clinic-summarizer', source: 'explicit', tenantId: TENANT });
    expect(pinned.compiledConfig).toEqual(compiled('model-v3'));
    expect(pinned.models[0]).toMatchObject({ role: 'primary', slug: 'model-v3' });
    expect(Object.keys(pinned).sort()).toEqual(Object.keys(active).sort());
    expect(active.versionNumber).toBe(4);
  });

  it('serves a DEPRECATED pinned version (OD-21)', async () => {
    const { service } = make();
    await expect(service.resolveVersion({ tenantId: TENANT, slug: 'clinic-summarizer', versionNumber: 2 })).resolves.toMatchObject({ versionNumber: 2 });
  });

  it.each([
    ['a draft version', 5],
    ['an unknown version', 9],
  ])('404s %s', async (_label, versionNumber) => {
    const { service } = make();
    await expect(service.resolveVersion({ tenantId: TENANT, slug: 'clinic-summarizer', versionNumber })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s another tenant`s agent — the lookup is the caller`s own lineage only (404-over-403)', async () => {
    const { service } = make();
    await expect(service.resolveVersion({ tenantId: OTHER, slug: 'clinic-summarizer', versionNumber: 3 })).rejects.toBeInstanceOf(NotFoundException);
    expect(agentRepository.findAllVersionsBySlug).toHaveBeenCalledWith(OTHER, 'clinic-summarizer');
  });

  it('keeps the resolver`s platform-hidden rule: a hidden slug is a 404 like an unknown one', async () => {
    agentRepository.findAllVersionsBySlug.mockResolvedValue([version(1, WorkflowDefinitionStatus.PUBLISHED, { slug: 'dna-writing-style-analyst' })]);
    const { service } = make();
    await expect(service.resolveVersion({ tenantId: TENANT, slug: 'dna-writing-style-analyst', versionNumber: 1 })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('never touches the shared resolver`s own lookup (the active version is not consulted)', async () => {
    const { service } = make();
    await service.resolveVersion({ tenantId: TENANT, slug: 'clinic-summarizer', versionNumber: 3 });
    expect(agentRepository.findPublishedActiveBySlug).not.toHaveBeenCalled();
  });
});
