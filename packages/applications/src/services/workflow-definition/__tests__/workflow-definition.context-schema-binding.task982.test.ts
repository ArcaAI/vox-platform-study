/**
 * Publish stamps the context-schema binding onto COLUMNS, not only into JSON.
 *
 * The binding has always been in the compiled artifact — that is what the interpreter validates
 * against. What it was not, was queryable: nothing could answer "which workflows depend on this
 * schema" before an admin published a new version of it, because the answer lived inside a JSONB
 * blob. These three columns are that index, and publish is the only writer.
 *
 * Two things they must get right, and each is a way the columns could silently lie:
 *
 *  1. the version they record is the RESOLVED one — the same number the compiler freezes — so a
 *     "follow latest" trigger records the version it actually shipped with;
 *  2. `followsLatest` comes from the AUTHORED graph, not from the resolution. The resolved
 *     version number is identical either way, so it cannot tell a pinned trigger from one that
 *     asked for "whatever is pinned" — and that distinction is exactly what decides whether a
 *     later publish of the schema breaks this workflow.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowDefinitionStatus } from '@arcaai/domains';
import { WorkflowDefinitionService } from '../workflow-definition.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockRepository = {
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
const mockDatabaseService = { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } };
const mockContextSchemaService = { getEffectiveBundle: vi.fn(), resolveReference: vi.fn() };

/** `core.trigger`'s own config schema requires a UUID here. */
const SCHEMA_ID = '79000000-0000-0000-0001-000000000010';
const VERSION_ID = '89000000-0000-0000-0001-000000000010';

const PAYLOAD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { intake: { type: 'object', properties: { severity: { type: 'string' } } } },
};

const graphWith = (triggerConfig: Record<string, unknown>) => ({
  version: 1,
  nodes: [
    { id: 't1', type: 'core.trigger', config: { kinds: ['api'], ...triggerConfig }, position: { x: 0, y: 0 } },
    { id: 'a1', type: 'core.agent', config: { agentRef: { slug: 'summarizer' } }, position: { x: 1, y: 0 } },
    { id: 'o1', type: 'core.output', config: { protocols: ['http'] }, position: { x: 2, y: 0 } },
  ],
  edges: [
    { id: 'e1', from: 't1', to: 'a1', fromPort: 'out', toPort: 'context' },
    { id: 'e2', from: 'a1', to: 'o1', fromPort: 'out', toPort: 'in' },
  ],
});

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
  graph: graphWith({ contextSchema: { contextSchemaId: SCHEMA_ID, versionNumber: 2 } }),
  graphChecksum: 'c1',
  compiledConfig: null,
  compiledConfigChecksum: null,
  registryChecksum: null,
  contextSchemaId: null,
  contextSchemaVersionNumber: null,
  contextSchemaFollowsLatest: false,
  validationReport: null,
  needsReview: false,
  validatedAt: null,
  publishedAt: null,
  deprecatedAt: null,
  isActive: false,
  resourceStatus: 'ENABLED',
  createdAt: new Date('2026-09-17T00:00:00Z'),
  updatedAt: new Date('2026-09-17T00:00:00Z'),
  version: 1,
  tags: [],
  hasChanges: true,
  changes: {},
  ...overrides,
});

function makeService(): WorkflowDefinitionService {
  return new WorkflowDefinitionService(
    mockRepository as never,
    mockEventEmitter as never,
    mockClsService as never,
    mockDatabaseService as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    mockContextSchemaService as never,
    undefined,
  );
}

/** What publish handed the repository — the row as it will be written. */
function stampedRow(): Record<string, unknown> {
  return mockRepository.update.mock.calls[0][1] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockClsService.get.mockImplementation((key: string) => {
    if (key === 'tenantId') return 'tenant-1';
    if (key === 'user') return { id: 'admin-1', roles: ['TENANT_ADMIN'] };
    return undefined;
  });
  mockRepository.update.mockImplementation(async (_id: string, e: unknown) => e);
  mockRepository.create.mockImplementation(async (e: unknown) => e);
  mockRepository.findPublishedBySlug.mockResolvedValue(null);
  mockRepository.findMaxVersionNumber.mockResolvedValue(0);
  mockContextSchemaService.getEffectiveBundle.mockResolvedValue({ contextSchemaVersionId: null });
  mockContextSchemaService.resolveReference.mockResolvedValue({
    outcome: 'resolved',
    schemaId: SCHEMA_ID,
    versionNumber: 2,
    versionId: VERSION_ID,
    payloadSchema: PAYLOAD_SCHEMA,
  });
});

describe('publish — the context-schema binding columns', () => {
  it('stamps schema id and the RESOLVED version from a PINNED trigger', async () => {
    mockRepository.findById.mockResolvedValue(entity());

    await makeService().publish('def-1', {});

    expect(stampedRow()).toMatchObject({
      contextSchemaId: SCHEMA_ID,
      contextSchemaVersionNumber: 2,
      contextSchemaFollowsLatest: false,
    });
  });

  it('marks followsLatest when the AUTHORED trigger names no version — the resolved number is the same either way', async () => {
    mockRepository.findById.mockResolvedValue(entity({ graph: graphWith({ contextSchema: { contextSchemaId: SCHEMA_ID } }) }));

    await makeService().publish('def-1', {});

    expect(stampedRow()).toMatchObject({
      contextSchemaId: SCHEMA_ID,
      contextSchemaVersionNumber: 2,
      contextSchemaFollowsLatest: true,
    });
  });

  it('leaves all three null/false for a graph that binds no schema by reference', async () => {
    mockRepository.findById.mockResolvedValue(entity({ graph: graphWith({}) }));

    await makeService().publish('def-1', {});

    expect(stampedRow()).toMatchObject({
      contextSchemaId: null,
      contextSchemaVersionNumber: null,
      contextSchemaFollowsLatest: false,
    });
  });

  it('clears a stale binding when a re-published draft no longer references a schema', async () => {
    mockRepository.findById.mockResolvedValue(
      entity({
        graph: graphWith({}),
        contextSchemaId: SCHEMA_ID,
        contextSchemaVersionNumber: 2,
        contextSchemaFollowsLatest: true,
      }),
    );

    await makeService().publish('def-1', {});

    expect(stampedRow()).toMatchObject({
      contextSchemaId: null,
      contextSchemaVersionNumber: null,
      contextSchemaFollowsLatest: false,
    });
  });
});
