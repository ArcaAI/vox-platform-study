/**
 * TASK-876 — `core.agent.overrides.generation` is CAPABILITY-CLAMPED at publish.
 *
 * The gap: `readGenerationBinding` read only the legacy `{ generation, providerConfigRef }` shape,
 * so `hyperparameterCapabilityFindings` never saw a `core.agent` node — the schema's promise that
 * overrides are "bounded by the agent's own declared ranges at publish" was unimplemented, and a
 * workflow author could publish a node tuned with a parameter the BOUND AGENT's provider drops on
 * the wire, and find out during a consultation.
 *
 * The clamp resolves the bound agent (ACTIVE published version, `[tenant, SYSTEM]`) to its model
 * row and reads the same `_metadata.capabilities.supportedGenerationParams` set
 * `AgentService.capabilitiesOf` reads when the AGENT is published, so the two gates cannot
 * disagree. The severity split is the contract's: DECLARED-and-absent → ERROR (refused),
 * ABSENT set → WARNING (unknown ≠ unsupported). The routing-policy plane is never consulted for
 * an agent-bound node — an agent, not a routing row, serves it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { WorkflowDefinitionStatus } from '@arcaai/domains';
import { readGenerationBinding } from '../node-generation-binding';
import { WorkflowDefinitionService } from '../workflow-definition.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockRoutingPolicyService = { resolveGenerationCapabilities: vi.fn() };
const agentRepository = { findPublishedActiveBySlug: vi.fn() };
const aiModelRepository = { findById: vi.fn() };

const node = (config: Record<string, unknown>) => ({ id: 'n_agent', type: 'core.agent', config });
const graph = (config: Record<string, unknown>) => ({ version: 1, nodes: [node(config)], edges: [] });

/** A `core.agent` tuned with `presencePenalty` — the parameter the seeded generation rows do not support. */
const TUNED = { agentRef: { slug: 'clinic-summarizer' }, overrides: { generation: { temperature: 0.2, presencePenalty: 0.5 } } };

const publishedAgent = { id: 'agent-1', slug: 'clinic-summarizer', versionNumber: 3, compiledConfig: { model: { id: 'm1', slug: 'lms-gemma-4-e2b-it-qat' } } };
const modelRow = (supported: string[] | undefined) => ({
  id: 'm1',
  slug: 'lms-gemma-4-e2b-it-qat',
  provider: 'lm-studio',
  metaData: supported ? { capabilities: { supportedGenerationParams: supported } } : {},
});

const mockWorkflowDefinitionRepository = {
  findById: vi.fn(),
  findAll: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateWithVersion: vi.fn(),
  softDelete: vi.fn(),
  findMaxVersionNumber: vi.fn(),
  findPublishedBySlug: vi.fn(),
  findAllVersionsBySlug: vi.fn(),
};
const mockDatabaseService = { baseClient: { $transaction: vi.fn((callback: (tx: unknown) => unknown) => callback({})) } };

const entity = (overrides: Record<string, unknown> = {}) => ({
  id: 'def-1',
  tenantId: 'tenant-1',
  slug: 'agent_note',
  name: 'Agent Note',
  description: null,
  paletteKey: 'core',
  versionNumber: 1,
  parentVersionId: null,
  status: WorkflowDefinitionStatus.DRAFT,
  graph: graph(TUNED),
  graphChecksum: 'c1',
  compiledConfig: null,
  compiledConfigChecksum: null,
  registryChecksum: null,
  validationReport: null,
  needsReview: false,
  validatedAt: null,
  publishedAt: null,
  deprecatedAt: null,
  isActive: false,
  resourceStatus: 'ENABLED',
  createdAt: new Date('2026-09-05T00:00:00Z'),
  updatedAt: new Date('2026-09-05T00:00:00Z'),
  version: 1,
  tags: [],
  hasChanges: false,
  changes: {},
  ...overrides,
});

function makeService(): WorkflowDefinitionService {
  return new WorkflowDefinitionService(
    mockWorkflowDefinitionRepository as never,
    mockEventEmitter as never,
    mockClsService as never,
    mockDatabaseService as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    mockRoutingPolicyService as never,
    agentRepository as never,
    aiModelRepository as never,
  );
}

const findingsOf = async (service: WorkflowDefinitionService) => {
  const error = await service.publish('def-1', {}).catch((e: BadRequestException) => e);
  return ((error as BadRequestException).getResponse() as { findings: { nodeId: string; path: string; message: string; severity: string }[] }).findings;
};

describe('readGenerationBinding — the core.agent shape', () => {
  it('reads `overrides.generation` + `agentRef` off a core.agent node', () => {
    expect(readGenerationBinding(node(TUNED) as never)).toEqual({
      nodeId: 'n_agent',
      nodeType: 'core.agent',
      generation: { temperature: 0.2, presencePenalty: 0.5 },
      agentRef: { slug: 'clinic-summarizer' },
      path: '/config/overrides/generation',
    });
    expect(readGenerationBinding(node({ agentRef: { slug: 'x', versionNumber: 2 }, overrides: { generation: { topP: 0.9 } } }) as never)).toMatchObject({
      agentRef: { slug: 'x', versionNumber: 2 },
    });
  });

  it('a core.agent that tunes nothing, or names no agent, is not a binding', () => {
    expect(readGenerationBinding(node({ agentRef: { slug: 'x' } }) as never)).toBeNull();
    expect(readGenerationBinding(node({ agentRef: { slug: 'x' }, overrides: { generation: {} } }) as never)).toBeNull();
    expect(readGenerationBinding(node({ overrides: { generation: { temperature: 0.1 } } }) as never)).toBeNull();
  });

  it('the legacy `{ generation, providerConfigRef }` shape still reads exactly as before', () => {
    const legacy = { id: 'n', type: 'agentic.agent', config: { providerConfigRef: { taskKey: 'text.finalize' }, generation: { topP: 0.9 } } };
    expect(readGenerationBinding(legacy as never)).toEqual({
      nodeId: 'n',
      nodeType: 'agentic.agent',
      generation: { topP: 0.9 },
      providerConfigRef: { routingPolicyId: null, taskKey: 'text.finalize' },
      path: '/config/generation',
    });
  });
});

describe('publish — a core.agent override the bound agent`s provider rejects is REFUSED', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => {
      if (key === 'tenantId') return 'tenant-1';
      if (key === 'user') return { id: 'admin-1', roles: ['TENANT_ADMIN'] };
      return undefined;
    });
    mockWorkflowDefinitionRepository.findById.mockResolvedValue(entity());
    mockWorkflowDefinitionRepository.update.mockImplementation(async (_id: string, e: unknown) => e);
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(null);
    agentRepository.findPublishedActiveBySlug.mockResolvedValue(publishedAgent);
    aiModelRepository.findById.mockResolvedValue(modelRow(['temperature', 'maxTokens', 'topP']));
  });

  it('refuses the publish, naming the parameter, the node path under `overrides`, and the bound agent`s model', async () => {
    const service = makeService();
    await expect(service.publish('def-1', {})).rejects.toBeInstanceOf(BadRequestException);
    expect(mockWorkflowDefinitionRepository.update).not.toHaveBeenCalled();

    const findings = await findingsOf(service);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'ERROR', nodeId: 'n_agent', path: '/config/overrides/generation/presencePenalty' });
    expect(findings[0].message).toContain('presencePenalty');
    expect(findings[0].message).toContain('lms-gemma-4-e2b-it-qat');
    expect(findings[0].message).toContain('clinic-summarizer');
  });

  it('resolves the agent for the CALLING tenant and reads the capability set off the agent`s OWN model row — never the routing plane', async () => {
    await makeService().publish('def-1', {}).catch(() => undefined);
    expect(agentRepository.findPublishedActiveBySlug).toHaveBeenCalledWith('tenant-1', 'clinic-summarizer');
    expect(aiModelRepository.findById).toHaveBeenCalledWith('m1');
    expect(mockRoutingPolicyService.resolveGenerationCapabilities).not.toHaveBeenCalled();
  });

  it('a CONFORMING override publishes clean', async () => {
    mockWorkflowDefinitionRepository.findById.mockResolvedValue(entity({ graph: graph({ agentRef: { slug: 'clinic-summarizer' }, overrides: { generation: { temperature: 0.3, topP: 0.9 } } }) }));
    const result = await makeService().publish('def-1', {});
    expect(result.status).toBe(WorkflowDefinitionStatus.PUBLISHED);
  });

  it('an agent whose model declares NO capability set publishes with a WARNING (unknown ≠ unsupported)', async () => {
    aiModelRepository.findById.mockResolvedValue(modelRow(undefined));
    const result = await makeService().publish('def-1', {});
    expect(result.status).toBe(WorkflowDefinitionStatus.PUBLISHED);
    const findings = (result.validationReport as unknown as { findings: { severity: string; path: string }[] }).findings;
    expect(findings.filter((f) => f.path?.startsWith('/config/overrides/generation/'))).toEqual([
      expect.objectContaining({ severity: 'WARNING', path: '/config/overrides/generation/temperature' }),
      expect.objectContaining({ severity: 'WARNING', path: '/config/overrides/generation/presencePenalty' }),
    ]);
  });

  it('an agent that does not resolve at publish is an UNKNOWN capability set (WARNING) — the runtime fails closed on it anyway', async () => {
    agentRepository.findPublishedActiveBySlug.mockResolvedValue(null);
    const result = await makeService().publish('def-1', {});
    expect(result.status).toBe(WorkflowDefinitionStatus.PUBLISHED);
    expect(aiModelRepository.findById).not.toHaveBeenCalled();
  });

  it('a node that tunes nothing is never looked up', async () => {
    mockWorkflowDefinitionRepository.findById.mockResolvedValue(entity({ graph: graph({ agentRef: { slug: 'clinic-summarizer' } }) }));
    await makeService().publish('def-1', {});
    expect(agentRepository.findPublishedActiveBySlug).not.toHaveBeenCalled();
  });
});
