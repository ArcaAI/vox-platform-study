/**
 * TASK-930 §6.2 — workflow promotion checks its agents FIRST.
 *
 * A `core.agent` node references an agent BY SLUG, and `AgentAssignmentService.resolve` /
 * `findPublishedActiveBySlug` no longer widen a by-slug agent read to SYSTEM (TASK-890 OD-M: a
 * tenant reads its own provisioned CLONE). So a SYSTEM workflow whose graph names an agent SYSTEM
 * does not carry is not "degraded" — it is unrunnable for every tenant provisioned from it, and
 * the failure surfaces at some clinician's consultation rather than at the promotion that caused
 * it. This gate moves that discovery to the promotion.
 *
 * The refusal is a **409**, not a 404 or a 403: the request is well-formed and the caller is
 * entitled; the platform's state is not yet ready for it. The response names EVERY missing slug,
 * because a promoter fixing them one 409 at a time is the same work spread over five requests.
 *
 * Written RED-first: both branches failed against `f4832baa5`, where `promoteToSystem` copied a
 * graph without ever reading its `agentRef`s.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { SYSTEM_TENANT_ID, WorkflowDefinitionStatus } from '@arcaai/domains';
import { WorkflowDefinitionService } from '../workflow-definition.service';

const GLOBAL = '50000000-0000-0000-0000-000000000000';

const mockClsService = {
  get: vi.fn(),
  set: vi.fn(),
  run: vi.fn((optionsOrCallback: unknown, maybeCallback?: unknown) =>
    (typeof optionsOrCallback === 'function' ? optionsOrCallback : (maybeCallback as () => unknown))(),
  ),
};
const mockEventEmitter = { emit: vi.fn() };
const mockRepository = {
  findById: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  findMaxVersionNumber: vi.fn(),
  findPublishedBySlug: vi.fn(),
  findAllVersionsBySlug: vi.fn(),
};
const mockDatabaseService = { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } };
const mockEntitlements = {
  isEnforcementEnabled: vi.fn(() => false),
  assertQuantityQuota: vi.fn(),
  isFeatureEnabled: vi.fn(() => Promise.resolve(true)),
};
const mockAgentRepository = { findPublishedActiveBySlug: vi.fn() };
const mockAgentPromotion = { promote: vi.fn() };
const mockEvalGate = { evaluateWorkflowPromotion: vi.fn() };
const mockPolicyEngine = { buildAbility: vi.fn() };

/** Two `core.agent` nodes, one `core.output` — the §8.4 shape, trimmed to what this gate reads. */
const AGENT_GRAPH = {
  version: 1,
  nodes: [
    { id: 'n1', type: 'core.agent', config: { agentRef: { slug: 'realtime-transcription' } } },
    { id: 'n2', type: 'core.agent', config: { agentRef: { slug: 'medical-ner' } } },
    { id: 'n3', type: 'core.output', config: {} },
  ],
  edges: [],
};

const entity = (overrides: Record<string, unknown> = {}) => ({
  id: 'def-1',
  tenantId: GLOBAL,
  slug: 'general-medicine-consultation',
  name: 'General medicine consultation',
  description: null,
  paletteKey: 'core',
  versionNumber: 2,
  parentVersionId: null,
  status: WorkflowDefinitionStatus.PUBLISHED,
  graph: AGENT_GRAPH,
  graphChecksum: 'c1',
  compiledConfig: null,
  compiledConfigChecksum: null,
  registryChecksum: null,
  validationReport: null,
  needsReview: false,
  validatedAt: null,
  publishedAt: new Date('2026-09-01T00:00:00Z'),
  deprecatedAt: null,
  isActive: true,
  resourceStatus: 'ENABLED',
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  version: 1,
  tags: [],
  hasChanges: false,
  changes: {},
  ...overrides,
});

const construct = () =>
  new WorkflowDefinitionService(
    mockRepository as never,
    mockEventEmitter as never,
    mockClsService as never,
    mockDatabaseService as never,
    mockEntitlements as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    mockAgentRepository as never,
    undefined,
    undefined,
    undefined,
    mockAgentPromotion as never,
    mockEvalGate as never,
    mockPolicyEngine as never,
  );

describe('WorkflowDefinitionService.promoteToSystem — the graph’s agents must be in SYSTEM (TASK-930 §6.2)', () => {
  let service: WorkflowDefinitionService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEntitlements.isEnforcementEnabled.mockReturnValue(false);
    mockEntitlements.isFeatureEnabled.mockResolvedValue(true);
    mockDatabaseService.baseClient.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb({}));
    mockRepository.findPublishedBySlug.mockImplementation((tenantId: string) =>
      Promise.resolve(
        tenantId === GLOBAL ? entity() : entity({ id: 'sys-v1', tenantId: SYSTEM_TENANT_ID, versionNumber: 1, isActive: true }),
      ),
    );
    mockRepository.findById.mockResolvedValue(
      entity({ id: 'sys-draft-1', tenantId: SYSTEM_TENANT_ID, status: WorkflowDefinitionStatus.DRAFT, isActive: false }),
    );
    mockRepository.update.mockImplementation((_id: string, updated: unknown) => Promise.resolve(updated));
    mockRepository.findAllVersionsBySlug.mockResolvedValue([]);
    // TASK-930 D-4 — the publish now runs INSIDE the promotion's transaction, through `afterWrite`.
    mockAgentPromotion.promote.mockImplementation(async (_dto: unknown, options?: { afterWrite?: (d: unknown) => Promise<void> }) => {
      await options?.afterWrite?.(
        entity({ id: 'sys-draft-1', tenantId: SYSTEM_TENANT_ID, status: WorkflowDefinitionStatus.DRAFT, isActive: false }),
      );
      return { id: 'promo-1', targetDefinitionVersionId: 'sys-draft-1', warnings: [] };
    });
    mockEvalGate.evaluateWorkflowPromotion.mockResolvedValue({
      mode: 'warn',
      evaluated: true,
      passed: true,
      blocked: false,
      failures: [],
      runIds: [],
      aggregates: {},
    });
    mockClsService.get.mockImplementation((key: string) => {
      if (key === 'tenantId') return undefined;
      if (key === 'user') return { id: 'root-1', roles: ['SUPER_ADMIN'] };
      return undefined;
    });
    service = construct();
  });

  it('refuses with a 409 AGENTS_NOT_IN_SYSTEM naming EVERY agent slug SYSTEM does not carry', async () => {
    mockAgentRepository.findPublishedActiveBySlug.mockResolvedValue(null);

    const error = await service
      .promoteToSystem({ sourceDefinitionSlug: 'general-medicine-consultation' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    const body = (error as ConflictException).getResponse() as { code: string; missing: string[]; message: string };
    expect(body.code).toBe('AGENTS_NOT_IN_SYSTEM');
    // Both, not just the first — one 409 per missing agent is the same work five times over.
    expect(body.missing.sort()).toEqual(['medical-ner', 'realtime-transcription']);
    // The hint names the route that fixes it (§6.1).
    expect(body.message).toContain('promote-to-system');
    // Nothing was written: the gate runs BEFORE the copy, exactly like the eval gate.
    expect(mockAgentPromotion.promote).not.toHaveBeenCalled();
  });

  it('names only the MISSING agent when SYSTEM already carries the others', async () => {
    mockAgentRepository.findPublishedActiveBySlug.mockImplementation((tenantId: string, slug: string) =>
      Promise.resolve(slug === 'medical-ner' ? null : { id: 'sys-agent-1', tenantId, slug }),
    );

    const error = await service
      .promoteToSystem({ sourceDefinitionSlug: 'general-medicine-consultation' })
      .catch((caught: unknown) => caught);

    expect(((error as ConflictException).getResponse() as { missing: string[] }).missing).toEqual(['medical-ner']);
  });

  it('checks SYSTEM, not the Global source — a Global-only agent does not make a SYSTEM workflow runnable', async () => {
    mockAgentRepository.findPublishedActiveBySlug.mockResolvedValue({ id: 'a', slug: 's' });

    await service.promoteToSystem({ sourceDefinitionSlug: 'general-medicine-consultation' });

    for (const call of mockAgentRepository.findPublishedActiveBySlug.mock.calls) {
      expect(call[0]).toBe(SYSTEM_TENANT_ID);
    }
  });

  it('promotes normally when every referenced agent resolves to a PUBLISHED SYSTEM agent', async () => {
    mockAgentRepository.findPublishedActiveBySlug.mockResolvedValue({ id: 'sys-agent-1', slug: 'x' });

    const result = await service.promoteToSystem({ sourceDefinitionSlug: 'general-medicine-consultation' });

    expect(mockAgentPromotion.promote).toHaveBeenCalledWith(
      expect.objectContaining({ fromTenantId: GLOBAL, toTenantId: SYSTEM_TENANT_ID }),
      // D-4 — the publish travels as the promotion's in-transaction step.
      expect.objectContaining({ afterWrite: expect.any(Function) }),
    );
    expect(result.published).toBe(true);
  });

  it('leaves a graph with no core.agent node exactly as it was — the gate reads nothing to check', async () => {
    mockRepository.findPublishedBySlug.mockImplementation((tenantId: string) =>
      Promise.resolve(
        tenantId === GLOBAL
          ? entity({ graph: { version: 1, nodes: [{ id: 'n1', type: 'core.output', config: {} }], edges: [] } })
          : entity({ id: 'sys-v1', tenantId: SYSTEM_TENANT_ID, versionNumber: 1, isActive: true }),
      ),
    );

    await service.promoteToSystem({ sourceDefinitionSlug: 'general-medicine-consultation' });

    expect(mockAgentRepository.findPublishedActiveBySlug).not.toHaveBeenCalled();
    expect(mockAgentPromotion.promote).toHaveBeenCalled();
  });
});
