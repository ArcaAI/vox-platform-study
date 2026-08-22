/**
 * TASK-790 W1 (second half) — `paletteKey` is validated server-side on create.
 *
 * TASK-789 C-5/D-5: `CreateWorkflowDefinitionRequest.paletteKey` is `@IsString() @MaxLength(80)`
 * and nothing more, while Workflow Studio's palette field is a free-text `<Input>`. A typo
 * ('summarisation', 'Consultation', 'stt ') silently produces a definition that no palette rule
 * set will ever match and that the Assignment Matrix can never offer — an orphaned row that
 * looks published and is permanently unassignable.
 *
 * The valid set is DERIVED from `WORKFLOW_NODE_REGISTRY`, never re-typed, so a palette added to
 * the registry needs no edit in the service.
 *
 * `paletteKey` is create-only — `UpdateWorkflowDefinitionRequest` carries no such field, so a
 * published definition's palette is immutable and there is no update path to guard.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { WorkflowDefinitionStatus } from '@arcaai/domains';
import { WorkflowDefinitionService } from '../workflow-definition.service';
import { KNOWN_PALETTE_KEYS } from '../../workflow-exposure/exposure-palette-policy';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockWorkflowDefinitionRepository = {
  findById: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  findMaxVersionNumber: vi.fn(),
};
const mockDatabaseService = { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } };
const mockEntitlements = { isEnforcementEnabled: vi.fn(() => false), assertQuantityQuota: vi.fn(), isFeatureEnabled: vi.fn(() => Promise.resolve(true)) };
const mockSttPipelineCompiler = { compileAndPublish: vi.fn() };

const VALID_GRAPH = { version: 1, nodes: [{ id: 'n1', type: 'noop', config: {} }], edges: [] };

const savedEntity = {
  id: 'def-1',
  tenantId: 'tenant-1',
  slug: 'discharge_summary',
  name: 'Discharge Summary',
  description: null,
  paletteKey: 'summarization',
  versionNumber: 1,
  parentVersionId: null,
  status: WorkflowDefinitionStatus.DRAFT,
  graph: VALID_GRAPH,
  graphChecksum: 'c',
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
  createdAt: new Date('2026-08-22T00:00:00Z'),
  updatedAt: new Date('2026-08-22T00:00:00Z'),
  version: 1,
  tags: [],
  hasChanges: false,
  changes: {},
};

describe('TASK-790 W1 — server-side paletteKey validation (C-5/D-5)', () => {
  let service: WorkflowDefinitionService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEntitlements.isEnforcementEnabled.mockReturnValue(false);
    mockDatabaseService.baseClient.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb({}));
    mockClsService.get.mockImplementation((key: string) => {
      if (key === 'tenantId') return 'tenant-1';
      if (key === 'user') return { id: 'admin-1', roles: ['TENANT_ADMIN'] };
      return undefined;
    });
    mockWorkflowDefinitionRepository.findMaxVersionNumber.mockResolvedValue(0);
    mockWorkflowDefinitionRepository.create.mockResolvedValue(savedEntity);
    service = new WorkflowDefinitionService(
      mockWorkflowDefinitionRepository as any,
      mockEventEmitter as any,
      mockClsService as any,
      mockDatabaseService as any,
      mockEntitlements as any,
      mockSttPipelineCompiler as any,
    );
  });

  it('the known set is derived from the registry and carries the three real palettes', () => {
    expect([...KNOWN_PALETTE_KEYS].sort()).toEqual(['consultation', 'stt', 'summarization']);
  });

  it.each(['summarisation', 'Summarization', 'stt ', 'clinical', ''])(
    'rejects an unknown paletteKey %j with 400 and writes nothing',
    async (paletteKey) => {
      await expect(
        service.create({ slug: 'discharge_summary', name: 'Discharge Summary', paletteKey, graph: VALID_GRAPH }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mockWorkflowDefinitionRepository.create).not.toHaveBeenCalled();
    },
  );

  it.each(['summarization', 'stt', 'consultation'])('accepts the registry-declared palette %j', async (paletteKey) => {
    await expect(
      service.create({ slug: 'discharge_summary', name: 'Discharge Summary', paletteKey, graph: VALID_GRAPH }),
    ).resolves.toBeDefined();

    expect(mockWorkflowDefinitionRepository.create).toHaveBeenCalledTimes(1);
  });
});
