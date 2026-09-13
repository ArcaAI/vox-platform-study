/**
 * (second half) — `paletteKey` is validated server-side on create.
 *
 * /D-5: `CreateWorkflowDefinitionRequest.paletteKey` is `@IsString() @MaxLength(80)`
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
import { EXPOSURE_ALLOWED_PALETTES, KNOWN_PALETTE_KEYS } from '../../workflow-exposure/exposure-palette-policy';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockWorkflowDefinitionRepository = {
  findById: vi.fn(),
  findAll: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  findMaxVersionNumber: vi.fn(),
};
const mockDatabaseService = { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } };
const mockEntitlements = {
  isEnforcementEnabled: vi.fn(() => false),
  assertQuantityQuota: vi.fn(),
  isFeatureEnabled: vi.fn(() => Promise.resolve(true)),
};
const mockSttPipelineCompiler = { compileAndPublish: vi.fn() };

/** TASK-893 — the only vocabulary left is `core`; `noop` and every legacy palette are gone. */
const VALID_GRAPH = {
  version: 1,
  nodes: [
    { id: 't1', type: 'core.trigger', config: { kinds: ['api'] }, position: { x: 0, y: 0 } },
    { id: 'o1', type: 'core.output', config: { protocols: ['http'] }, position: { x: 1, y: 0 } },
  ],
  edges: [{ id: 'e1', from: 't1', to: 'o1', fromPort: 'out', toPort: 'in' }],
};

const savedEntity = {
  id: 'def-1',
  tenantId: 'tenant-1',
  slug: 'discharge_summary',
  name: 'Discharge Summary',
  description: null,
  paletteKey: 'core',
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

describe(' W1 — server-side paletteKey validation (C-5/D-5)', () => {
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

  it('the known set is derived from the registry, which declares exactly one palette', () => {
    // The property this test is really about is unchanged: `KNOWN_PALETTE_KEYS` is DERIVED from
    // `WORKFLOW_NODE_REGISTRY.paletteKey`, so a palette needs no edit to the service to become
    // authorable — and `EXPOSURE_ALLOWED_PALETTES` is deliberately NOT derived alongside it, so a
    // palette becomes PUBLICLY INVOKABLE only by an affirmative decision. An allow-list that grows
    // by default is not an allow-list.
    //
    // TASK-893 retired the legacy vocabulary outright (D-6/D-9): `summarization`, `consultation`,
    // `stt` and `agentic` are not deprecated-but-authorable, they are GONE, so both sets collapse
    // onto `core`. The exposure boundary that matters now is the CLASS-based clinical-write rule,
    // not palette membership — see `exposure-palette-policy.ts`.
    expect([...KNOWN_PALETTE_KEYS].sort()).toEqual(['core']);
    expect([...EXPOSURE_ALLOWED_PALETTES].sort()).toEqual(['core']);
  });

  // The four RETIRED palettes are in this list on purpose: after TASK-893 a graph authored under
  // one of them is refused at the door rather than accepted and later found to reference node
  // types that no longer exist.
  it.each(['summarization', 'consultation', 'stt', 'agentic', 'Core', 'core ', 'clinical', ''])(
    'rejects an unknown paletteKey %j with 400 and writes nothing',
    async (paletteKey) => {
      await expect(service.create({ slug: 'discharge_summary', name: 'Discharge Summary', paletteKey, graph: VALID_GRAPH })).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(mockWorkflowDefinitionRepository.create).not.toHaveBeenCalled();
    },
  );

  it.each(['core'])('accepts the registry-declared palette %j', async (paletteKey) => {
    await expect(service.create({ slug: 'discharge_summary', name: 'Discharge Summary', paletteKey, graph: VALID_GRAPH })).resolves.toBeDefined();

    expect(mockWorkflowDefinitionRepository.create).toHaveBeenCalledTimes(1);
  });
});

/**
 * The same validated palette vocabulary, applied to the LIST filter.
 *
 * The register had no `paletteKey` param at all: `?paletteKey=core` was a 400 from the strict
 * global pipe ('property paletteKey should not exist'), and the generic `filters` grammar —
 * `field[op]:value`, ';'-separated — silently DROPS a token that omits `[op]`, so the natural
 * `filters=paletteKey:core` answered 200 with every palette. A caller asking for one palette
 * held all of them with nothing to distinguish the two.
 */
describe('list() — the typed paletteKey filter', () => {
  let service: WorkflowDefinitionService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => {
      if (key === 'tenantId') return 'tenant-1';
      if (key === 'user') return { id: 'admin-1', roles: ['TENANT_ADMIN'] };
      return undefined;
    });
    mockWorkflowDefinitionRepository.findAll.mockResolvedValue([]);
    mockWorkflowDefinitionRepository.count.mockResolvedValue(0);
    service = new WorkflowDefinitionService(
      mockWorkflowDefinitionRepository as any,
      mockEventEmitter as any,
      mockClsService as any,
      mockDatabaseService as any,
      mockEntitlements as any,
      mockSttPipelineCompiler as any,
    );
  });

  it('constrains BOTH the page and the count to the requested palette', async () => {
    await service.list({ page: 0, limit: 10, paletteKey: 'core' } as any);

    // Both halves, deliberately: constraining `findAll` alone yields a short page beside a total
    // counted across every palette — a pager that offers pages the filter can never fill.
    expect(mockWorkflowDefinitionRepository.findAll).toHaveBeenCalledWith(expect.objectContaining({ where: { paletteKey: 'core' } }));
    expect(mockWorkflowDefinitionRepository.count).toHaveBeenCalledWith(expect.objectContaining({ where: { paletteKey: 'core' } }));
  });

  it('applies no palette predicate when the filter is omitted', async () => {
    await service.list({ page: 0, limit: 10 } as any);

    const [findAllProps] = mockWorkflowDefinitionRepository.findAll.mock.calls[0];
    expect(findAllProps.where).toEqual({});
  });

  it.each(['consultation', 'summarization', 'Core', 'core ', 'nope'])(
    'refuses the unknown palette %p with a 400 rather than an empty page',
    async (paletteKey) => {
      // The distinction this pins: "no definitions in this palette" and "that palette has never
      // existed" must not look identical in a register an admin reads to find out what exists.
      // 'consultation' is the live example — TASK-893 retired it, and a spec querying it was
      // reading an empty result as fact.
      await expect(service.list({ page: 0, limit: 10, paletteKey } as any)).rejects.toThrow(BadRequestException);
      expect(mockWorkflowDefinitionRepository.findAll).not.toHaveBeenCalled();
    },
  );

  it('composes with the generic filters grammar instead of replacing it', async () => {
    await service.list({ page: 0, limit: 10, paletteKey: 'core', filters: 'status[equals]:PUBLISHED' } as any);

    const [findAllProps] = mockWorkflowDefinitionRepository.findAll.mock.calls[0];
    expect(findAllProps.where).toEqual({ paletteKey: 'core' });
    expect(findAllProps.filters).toEqual({ status: { equals: 'PUBLISHED' } });
  });
});
