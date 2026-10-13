/**
 * `maxWorkflowDefinitions` counts LINEAGES (distinct slugs), never version rows, and a new
 * version of an existing slug consumes no quota.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowDefinitionStatus } from '@arcaai/domains';
import { WorkflowDefinitionService } from '../workflow-definition.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockRepository = {
  findById: vi.fn(),
  count: vi.fn(),
  countDistinctSlugs: vi.fn(),
  create: vi.fn(),
  findMaxVersionNumber: vi.fn(),
  findAllVersionsBySlug: vi.fn(),
  findPublishedBySlug: vi.fn(),
};
const TX = { __tx: true };
const mockDatabaseService = {
  baseClient: { $transaction: vi.fn((callback: (tx: unknown) => unknown) => callback(TX)) },
};
const mockEntitlements = {
  isEnforcementEnabled: vi.fn(() => true),
  assertQuantityQuota: vi.fn(),
  isFeatureEnabled: vi.fn(() => Promise.resolve(true)),
};

const GRAPH = {
  version: 1,
  nodes: [
    { id: 't1', type: 'core.trigger', config: { kinds: ['api'] }, position: { x: 0, y: 0 } },
    { id: 'a1', type: 'core.agent', config: { agentRef: { slug: 'summarizer' } }, position: { x: 1, y: 0 } },
    { id: 'o1', type: 'core.output', config: { protocols: ['http'] }, position: { x: 2, y: 0 } },
  ],
  edges: [
    { id: 'e1', from: 't1', fromPort: 'out', to: 'a1', toPort: 'context' },
    { id: 'e2', from: 'a1', fromPort: 'out', to: 'o1', toPort: 'in' },
  ],
};

const published = {
  id: 'pub-1',
  tenantId: 'tenant-1',
  slug: 'discharge_summary',
  name: 'Discharge Summary',
  description: null,
  paletteKey: 'core',
  versionNumber: 2,
  status: WorkflowDefinitionStatus.PUBLISHED,
  graph: GRAPH,
  resourceStatus: 'ENABLED',
  version: 1,
  tags: [],
};

describe('WorkflowDefinitionService — quota counts lineages', () => {
  let service: WorkflowDefinitionService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEntitlements.isEnforcementEnabled.mockReturnValue(true);
    mockRepository.count.mockResolvedValue(20);
    mockRepository.countDistinctSlugs.mockResolvedValue(3);
    mockRepository.findMaxVersionNumber.mockResolvedValue(0);
    mockRepository.findAllVersionsBySlug.mockResolvedValue([published]);
    mockRepository.findById.mockResolvedValue(published);
    mockRepository.create.mockImplementation((entity: unknown) => Promise.resolve(entity));
    mockClsService.get.mockImplementation((key: string) => {
      if (key === 'tenantId') return 'tenant-1';
      if (key === 'user') return { id: 'admin-1', roles: ['TENANT_ADMIN'] };
      return undefined;
    });
    service = new WorkflowDefinitionService(
      mockRepository as never,
      mockEventEmitter as never,
      mockClsService as never,
      mockDatabaseService as never,
      mockEntitlements as never,
    );
  });

  it('create prechecks against the distinct-slug count, not the version-row count', async () => {
    await service.create({ slug: 'fresh', name: 'x', paletteKey: 'core', graph: GRAPH });
    expect(mockEntitlements.assertQuantityQuota).toHaveBeenCalledWith('tenant-1', 'maxWorkflowDefinitions', 3);
  });

  it('createDraft (a new version of an existing slug) consumes no quota', async () => {
    await service.createDraft('pub-1');
    expect(mockEntitlements.assertQuantityQuota).not.toHaveBeenCalled();
    expect(mockRepository.create).toHaveBeenCalled();
  });

  it('create with parentVersionId (a new version of an existing slug) consumes no quota', async () => {
    mockRepository.findMaxVersionNumber.mockResolvedValue(2);
    await service.create({ slug: 'discharge_summary', name: 'x', paletteKey: 'core', graph: GRAPH, parentVersionId: 'pub-1' });
    expect(mockEntitlements.assertQuantityQuota).not.toHaveBeenCalled();
  });
});
