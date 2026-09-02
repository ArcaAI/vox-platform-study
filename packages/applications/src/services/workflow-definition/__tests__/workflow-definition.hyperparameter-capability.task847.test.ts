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
import { BadRequestException } from '@nestjs/common';
import { WorkflowDefinitionStatus } from '@arcaai/domains';
import { WorkflowDefinitionService } from '../workflow-definition.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

/**
 * The provider plane, at the seam this ticket owns. Its OWN behaviour — that the two-tier cascade
 * resolves a node's `providerConfigRef` to an `AiModel` row and reads
 * `_metadata.supportedGenerationParams` off it — is covered by
 * `ai-routing-policy/__tests__/ai-routing-policy.generation-capabilities.task847.test.ts`
 * against mocked REPOSITORIES, so the cascade itself is exercised rather than assumed.
 */
const mockRoutingPolicyService = { resolveGenerationCapabilities: vi.fn() };

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

    // The platform's real answer for every seeded generation row: `apps/text` forwards exactly
    // these three to every adapter, so `presencePenalty` genuinely reaches nothing.
    mockRoutingPolicyService.resolveGenerationCapabilities.mockResolvedValue({
      label: 'text.finalize (revision 1) → lms-gemma-4-e2b-it-qat',
      supportedGenerationParams: ['temperature', 'maxTokens', 'topP'],
    });

    service = new WorkflowDefinitionService(
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
    );
  });

  it('REFUSES the publish, naming the parameter AND the provider configuration', async () => {
    await expect(service.publish('def-1', {})).rejects.toBeInstanceOf(BadRequestException);

    // Nothing was written: the gate runs before compile and before any entity mutation.
    expect(mockWorkflowDefinitionRepository.update).not.toHaveBeenCalled();
  });

  it('the refusal message is actionable — parameter, node and configuration', async () => {
    const error = await service.publish('def-1', {}).catch((e: BadRequestException) => e);
    const response = (error as BadRequestException).getResponse() as { message: string; findings: { nodeId: string; path: string; message: string; severity: string }[] };

    expect(response.findings).toHaveLength(1);
    const [finding] = response.findings;
    expect(finding.severity).toBe('ERROR');
    expect(finding.nodeId).toBe('n_agent');
    expect(finding.path).toBe('/config/generation/presencePenalty');
    // The parameter, and the configuration it would have been dropped by.
    expect(finding.message).toContain('presencePenalty');
    expect(finding.message).toContain('lms-gemma-4-e2b-it-qat');
  });

  it('refuses ONLY the unsupported parameter — temperature is declared, so it is not flagged', async () => {
    const error = await service.publish('def-1', {}).catch((e: BadRequestException) => e);
    const response = (error as BadRequestException).getResponse() as { findings: { path: string }[] };

    expect(response.findings.map((f) => f.path)).toEqual(['/config/generation/presencePenalty']);
  });

  it('resolves the capability set for the CALLING tenant, through the node`s own reference', async () => {
    await service.publish('def-1', {}).catch(() => undefined);

    expect(mockRoutingPolicyService.resolveGenerationCapabilities).toHaveBeenCalledWith('tenant-1', {
      routingPolicyId: PINNED_POLICY_ID,
      taskKey: null,
    });
  });

  it('a CONFORMING node publishes clean', async () => {
    mockWorkflowDefinitionRepository.findById.mockResolvedValue(
      entity({
        graph: {
          version: 1,
          nodes: [
            {
              id: 'n_agent',
              type: 'agentic.agent',
              config: { providerConfigRef: { routingPolicyId: PINNED_POLICY_ID }, generation: { temperature: 0.2, topP: 0.9 } },
            },
          ],
          edges: [],
        },
      }),
    );

    const result = await service.publish('def-1', {});
    expect(result.status).toBe(WorkflowDefinitionStatus.PUBLISHED);
  });

  it('a node that tunes NOTHING is never looked up at all', async () => {
    mockWorkflowDefinitionRepository.findById.mockResolvedValue(
      entity({
        graph: {
          version: 1,
          nodes: [{ id: 'n_agent', type: 'agentic.agent', config: { providerConfigRef: { routingPolicyId: PINNED_POLICY_ID } } }],
          edges: [],
        },
      }),
    );

    await service.publish('def-1', {});
    expect(mockRoutingPolicyService.resolveGenerationCapabilities).not.toHaveBeenCalled();
  });
});

describe('F-32 — ABSENT capability set is a WARNING, not an error (TASK-847`s considered split)', () => {
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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      mockRoutingPolicyService as never,
    );
  });

  it('publishes an unprofiled configuration, recording a WARNING rather than refusing', async () => {
    // No row has declared a set. "Nobody profiled this" is not evidence of non-support, and
    // refusing here would block the platform on data entry rather than on a real conflict.
    mockRoutingPolicyService.resolveGenerationCapabilities.mockResolvedValue({
      label: 'text.finalize (revision 1) → tenant-own-vllm',
      supportedGenerationParams: undefined,
    });

    const result = await service.publish('def-1', {});
    expect(result.status).toBe(WorkflowDefinitionStatus.PUBLISHED);

    const findings = (result.validationReport as unknown as { findings: { severity: string; message: string; path: string }[] }).findings;
    const capability = findings.filter((f) => f.path?.startsWith('/config/generation/'));
    expect(capability.map((f) => f.severity)).toEqual(['WARNING', 'WARNING']);
    expect(capability.map((f) => f.path).sort()).toEqual(['/config/generation/presencePenalty', '/config/generation/temperature']);
    expect(capability[0].message).toContain('cannot be verified');
  });

  it('an UNRESOLVABLE reference is UNKNOWN, not a failed publish', async () => {
    // A capability question must never be the thing that fails a publish. Selection still fails
    // closed at runtime; this gate is about tuning knobs.
    mockRoutingPolicyService.resolveGenerationCapabilities.mockRejectedValue(new Error('db down'));

    const result = await service.publish('def-1', {});
    expect(result.status).toBe(WorkflowDefinitionStatus.PUBLISHED);
  });

  it('with the provider plane absent entirely, publish still succeeds', async () => {
    const withoutPlane = new WorkflowDefinitionService(
      mockWorkflowDefinitionRepository as never,
      mockEventEmitter as never,
      mockClsService as never,
      mockDatabaseService as never,
    );

    const result = await withoutPlane.publish('def-1', {});
    expect(result.status).toBe(WorkflowDefinitionStatus.PUBLISHED);
  });
});
