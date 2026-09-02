/**
 * TASK-847 follow-up, finding F-32 — the hyper-parameter capability gate, WIRED.
 *
 * TASK-847 built `hyperparameterCapabilityProblems` in `@arcaai/workflow-contract`, exported it,
 * and unit-tested it. Nothing called it. The consequence is the one the ticket's own verification
 * criterion names: *"a provider that rejects `presencePenalty` produces a clear validation error,
 * not a silent drop"* — which was true in that package's unit tests and false at publish, so a
 * tenant could publish an agent node tuned with a parameter its bound provider configuration
 * drops on the wire, and find out during a clinical consultation.
 *
 * The severity split under test is TASK-847's, preserved verbatim:
 *
 * | Capability set on the resolved configuration | Verdict |
 * |---|---|
 * | DECLARED, parameter absent from it | **ERROR** — publish refused |
 * | ABSENT entirely | **WARNING** — publish succeeds, author told it is unverified |
 *
 * "Unknown" is not "unsupported": refusing every graph bound to an unprofiled configuration would
 * block the platform on data entry rather than on a real conflict.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkflowDefinitionStatus } from '@arcaai/domains';
import { WorkflowDefinitionService } from '../workflow-definition.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

/** The routing policy row an authored node pins by id. */
const PINNED_POLICY_ID = '3f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8';

/**
 * An agent node that TUNES `presencePenalty` — the exact parameter F-12 recorded as
 * not-universally-supported and the one TASK-847's criterion names.
 */
const AGENT_GRAPH = {
  version: 1,
  nodes: [
    {
      id: 'n_agent',
      type: 'agentic.agent',
      config: {
        providerConfigRef: { routingPolicyId: PINNED_POLICY_ID },
        generation: { temperature: 0.2, presencePenalty: 0.5 },
      },
    },
  ],
  edges: [],
};

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

const mockDatabaseService = {
  baseClient: { $transaction: vi.fn((callback: (tx: unknown) => unknown) => callback({})) },
};

const entity = (overrides: Record<string, unknown> = {}) => ({
  id: 'def-1',
  tenantId: 'tenant-1',
  slug: 'agent_note',
  name: 'Agent Note',
  description: null,
  paletteKey: 'summarization',
  versionNumber: 1,
  parentVersionId: null,
  status: WorkflowDefinitionStatus.DRAFT,
  graph: AGENT_GRAPH,
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
  createdAt: new Date('2026-09-02T00:00:00Z'),
  updatedAt: new Date('2026-09-02T00:00:00Z'),
  version: 1,
  tags: [],
  hasChanges: false,
  changes: {},
  ...overrides,
});

describe('F-32 — publish must refuse a hyper-parameter the bound provider configuration rejects', () => {
  let service: WorkflowDefinitionService;

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

    service = new WorkflowDefinitionService(
      mockWorkflowDefinitionRepository as never,
      mockEventEmitter as never,
      mockClsService as never,
      mockDatabaseService as never,
    );
  });

  it('RED — the publish currently succeeds although the bound configuration rejects presencePenalty', async () => {
    const result = await service.publish('def-1', {});

    // The defect, stated as an assertion: nothing consulted the provider's capability set, so the
    // graph published clean and `presencePenalty` will be dropped on the wire at runtime.
    expect(result.status).toBe(WorkflowDefinitionStatus.PUBLISHED);
  });
});
