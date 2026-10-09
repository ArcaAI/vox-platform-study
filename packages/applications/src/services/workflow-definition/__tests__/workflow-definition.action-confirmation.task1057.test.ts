/** TASK-1057 — `workflowDefinition.sync` / `.promoteToSystem` consult the platform reason policy before writing. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { SYSTEM_TENANT_ID, WorkflowDefinitionStatus } from '@arcaai/domains';
import { WorkflowDefinitionService } from '../workflow-definition.service';
import { ActionConfirmationService } from '../../settings-registry/action-confirmation.service';

const GLOBAL = '50000000-0000-0000-0000-000000000000';

const mockClsService = {
  get: vi.fn(),
  set: vi.fn(),
  // TASK-889 — a sync runs each cross-tenant step under its OWN CLS store
  // (`runInTenantContext`). This fixture pins one tenant through `get`, so `run` only has to
  // invoke the step; that the step's tenant is the right one is proven against the REAL
  // tenant-scope extension in `agentPromotion/__tests__/membership-bounded-sync.task889.test.ts`.
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
const mockPromptTemplateRepository = { findById: vi.fn(), findByName: vi.fn() };
/** TASK-930 §6.2 — promotion refuses a graph whose `core.agent` slugs are not published in
 *  SYSTEM, so the fixture's own core graph needs a repository that says they are. */
const mockAgentRepository = { findPublishedActiveBySlug: vi.fn(async (_tenantId: string, slug: string) => ({ id: `agent-${slug}`, slug })) };
const mockAgentPromotion = { promote: vi.fn() };
const mockEvalGate = { evaluateWorkflowPromotion: vi.fn() };
const mockPolicyEngine = { buildAbility: vi.fn() };

/** TASK-893 — the only vocabulary left is `core`; `noop` and the `summarization` palette are gone. */
const PLAIN_GRAPH = {
  version: 1,
  nodes: [
    { id: 't1', type: 'core.trigger', config: { kinds: ['api'] }, position: { x: 0, y: 0 } },
    { id: 'a1', type: 'core.agent', config: { agentRef: { slug: 'summarizer' } }, position: { x: 1, y: 0 } },
    { id: 'o1', type: 'core.output', config: { protocols: ['http'] }, position: { x: 2, y: 0 } },
  ],
  edges: [
    { id: 'e1', from: 't1', to: 'a1', fromPort: 'out', toPort: 'context' },
    { id: 'e2', from: 'a1', to: 'o1', fromPort: 'out', toPort: 'in' },
  ],
};

const entity = (overrides: Record<string, unknown> = {}) => ({
  id: 'def-1',
  tenantId: 'tenant-a',
  slug: 'soap',
  name: 'SOAP',
  description: null,
  paletteKey: 'core',
  versionNumber: 2,
  parentVersionId: null,
  status: WorkflowDefinitionStatus.PUBLISHED,
  graph: PLAIN_GRAPH,
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

function confirmations(mode?: string) {
  return new ActionConfirmationService({ resolve: vi.fn(() => ({ value: mode })) } as never, {} as never, {} as never, {} as never);
}

const construct = (policy: ActionConfirmationService) =>
  new WorkflowDefinitionService(
    mockRepository as never,
    mockEventEmitter as never,
    mockClsService as never,
    mockDatabaseService as never,
    mockEntitlements as never,
    undefined,
    mockPromptTemplateRepository as never,
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
    ...Array.from({ length: 3 }, () => undefined),
    policy,
  );

/** A tenant-less SUPER_ADMIN — the elevated context both verbs require. */
function elevated() {
  mockClsService.get.mockImplementation((key: string) => {
    if (key === 'tenantId') return undefined;
    if (key === 'user') return { id: 'root-1', roles: ['SUPER_ADMIN'] };
    return undefined;
  });
}


const spyBroadcast = (service: WorkflowDefinitionService) => vi.spyOn(service as never, 'broadcastSysEvent') as unknown as ReturnType<typeof vi.fn>;

describe('workflowDefinition.sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEntitlements.isEnforcementEnabled.mockReturnValue(false);
    mockDatabaseService.baseClient.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb({}));
    mockRepository.findMaxVersionNumber.mockResolvedValue(0);
    mockRepository.create.mockImplementation((created: unknown) => Promise.resolve(created));
    mockRepository.findPublishedBySlug.mockResolvedValue(entity());
    mockPolicyEngine.buildAbility.mockResolvedValue({ can: () => true });
    elevated();
  });
  const dto = { sourceTenantId: 'tenant-a', targetTenantIds: ['tenant-b'] };

  it('passes without a reason under the default policy and stamps "not required"', async () => {
    const service = construct(confirmations());
    const broadcast = spyBroadcast(service);
    await service.syncToTenants('soap', dto);
    expect(broadcast.mock.calls[0][1].data.confirmation).toMatchObject({ actionId: 'workflowDefinition.sync', required: false, note: 'reason not required' });
  });

  it('refuses 400 CONFIRMATION_REQUIRED before any write when required and missing', async () => {
    const service = construct(confirmations('required'));
    const error = await service.syncToTenants('soap', dto).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'CONFIRMATION_REQUIRED', actionId: 'workflowDefinition.sync' });
    expect(mockRepository.create).not.toHaveBeenCalled();
    expect(mockDatabaseService.baseClient.$transaction).not.toHaveBeenCalled();
  });
});

describe('workflowDefinition.promoteToSystem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEntitlements.isEnforcementEnabled.mockReturnValue(false);
    mockEntitlements.isFeatureEnabled.mockResolvedValue(true);
    mockDatabaseService.baseClient.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb({}));
    mockRepository.findPublishedBySlug.mockImplementation((tenantId: string) =>
      Promise.resolve(
        tenantId === GLOBAL ? entity({ tenantId: GLOBAL }) : entity({ id: 'sys-v1', tenantId: SYSTEM_TENANT_ID, versionNumber: 1, isActive: true }),
      ),
    );
    mockRepository.findById.mockResolvedValue(
      entity({ id: 'sys-draft-1', tenantId: SYSTEM_TENANT_ID, status: WorkflowDefinitionStatus.DRAFT, isActive: false }),
    );
    mockRepository.update.mockImplementation((_id: string, updated: unknown) => Promise.resolve(updated));
    mockRepository.findAllVersionsBySlug.mockResolvedValue([]);
    mockAgentPromotion.promote.mockImplementation(async (_dto: unknown, options?: { afterWrite?: (d: unknown) => Promise<void> }) => {
      await options?.afterWrite?.(entity({ id: 'sys-draft-1', tenantId: SYSTEM_TENANT_ID, status: WorkflowDefinitionStatus.DRAFT, isActive: false }));
      return { id: 'promo-1', targetDefinitionVersionId: 'sys-draft-1', targetDefinitionSlug: 'soap', warnings: [] };
    });
    mockEvalGate.evaluateWorkflowPromotion.mockResolvedValue({ mode: 'warn', evaluated: true, passed: true, blocked: false, failures: [], runIds: [], aggregates: {} });
    elevated();
  });

  it('passes without a reason under the default policy and stamps "not required" on the promotion event', async () => {
    const service = construct(confirmations());
    const broadcast = spyBroadcast(service);
    await service.promoteToSystem({ sourceDefinitionSlug: 'soap' });
    const event = broadcast.mock.calls.find((call) => call[1].data?.action === 'promoteToSystem');
    expect(event![1].data.confirmation).toMatchObject({ actionId: 'workflowDefinition.promoteToSystem', required: false, note: 'reason not required' });
  });

  it('refuses 400 CONFIRMATION_REQUIRED before the promotion when required and missing', async () => {
    const service = construct(confirmations('required'));
    const error = await service.promoteToSystem({ sourceDefinitionSlug: 'soap' }).catch((caught: unknown) => caught);
    expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'CONFIRMATION_REQUIRED', actionId: 'workflowDefinition.promoteToSystem' });
    expect(mockAgentPromotion.promote).not.toHaveBeenCalled();
  });
});
