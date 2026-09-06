/**
 * TASK-890 L2 §3.4 — the trigger's context-schema REFERENCE, resolved at the one place that
 * decides, and frozen into the artifact that runs.
 *
 * Three things are pinned here, and each of them is a way the previous shape could lie:
 *
 *  1. an unresolvable reference is a BLOCKING publish finding, named — `CONTEXT_SCHEMA_NOT_FOUND`
 *     when the tenant has no such schema (a SYSTEM or foreign id resolves to nothing, OD-H) and
 *     `CONTEXT_SCHEMA_VERSION_NOT_FOUND` when the pin names a version that does not exist. A
 *     graph that publishes with a dangling reference fails inside a live consultation instead;
 *  2. a resolvable reference is FROZEN — the derived payload schema onto the compiled trigger
 *     node, the pin into `policyBindings.contextSchemaRefs` — because the harness never re-reads
 *     Postgres (invariant 4);
 *  3. `create()` and `validate()` agree. Before this, `create` reported `ok: true` on a graph
 *     `validate` then refused with ERRORs, so the console could show a green draft the next
 *     call rejected.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
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
const mockContextSchemaService = {
  getEffectiveBundle: vi.fn(),
  resolveReference: vi.fn(),
};

/** `core.trigger`'s own config schema requires a UUID here — the gate checks that too. */
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

const BY_REFERENCE = graphWith({ contextSchema: { contextSchemaId: SCHEMA_ID, versionNumber: 2 } });

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
  graph: BY_REFERENCE,
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
  createdAt: new Date('2026-09-06T00:00:00Z'),
  updatedAt: new Date('2026-09-06T00:00:00Z'),
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

beforeEach(() => {
  vi.clearAllMocks();
  mockClsService.get.mockImplementation((key: string) => {
    if (key === 'tenantId') return 'tenant-1';
    if (key === 'user') return { id: 'admin-1', roles: ['TENANT_ADMIN'] };
    return undefined;
  });
  mockRepository.update.mockImplementation(async (_id: string, e: unknown) => e);
  mockRepository.updateWithVersion.mockImplementation(async (_id: string, e: unknown) => e);
  mockRepository.create.mockImplementation(async (e: unknown) => e);
  mockRepository.findPublishedBySlug.mockResolvedValue(null);
  mockRepository.findMaxVersionNumber.mockResolvedValue(0);
  mockContextSchemaService.getEffectiveBundle.mockResolvedValue({ contextSchemaVersionId: null });
});

describe('publish — an unresolvable trigger context schema', () => {
  it('refuses with CONTEXT_SCHEMA_NOT_FOUND when the tenant has no such schema', async () => {
    mockRepository.findById.mockResolvedValue(entity());
    mockContextSchemaService.resolveReference.mockResolvedValue({ outcome: 'failed', failure: 'CONTEXT_SCHEMA_NOT_FOUND' });

    await expect(makeService().publish('def-1', {})).rejects.toMatchObject({
      response: { findings: expect.arrayContaining([expect.objectContaining({ code: 'CONTEXT_SCHEMA_NOT_FOUND' })]) },
    });
    expect(mockContextSchemaService.resolveReference).toHaveBeenCalledWith(SCHEMA_ID, 2);
    // The gate runs BEFORE compile and before any entity mutation, so a refusal writes nothing.
    expect(mockRepository.update).not.toHaveBeenCalled();
  });

  it('names the VERSION failure differently — the remedy is not the same one', async () => {
    mockRepository.findById.mockResolvedValue(entity());
    mockContextSchemaService.resolveReference.mockResolvedValue({ outcome: 'failed', failure: 'CONTEXT_SCHEMA_VERSION_NOT_FOUND' });

    await expect(makeService().publish('def-1', {})).rejects.toMatchObject({
      response: { findings: expect.arrayContaining([expect.objectContaining({ code: 'CONTEXT_SCHEMA_VERSION_NOT_FOUND' })]) },
    });
  });

  it('does not resolve anything for a graph that binds no schema by reference', async () => {
    mockRepository.findById.mockResolvedValue(entity({ graph: graphWith({}) }));

    await makeService().publish('def-1', {});

    expect(mockContextSchemaService.resolveReference).not.toHaveBeenCalled();
  });
});

describe('publish — a resolvable reference is FROZEN into the artifact', () => {
  it('stamps the derived payload schema on the compiled trigger and records the pin', async () => {
    mockRepository.findById.mockResolvedValue(entity());
    mockContextSchemaService.resolveReference.mockResolvedValue({
      outcome: 'resolved',
      schemaId: SCHEMA_ID,
      versionNumber: 2,
      versionId: VERSION_ID,
      payloadSchema: PAYLOAD_SCHEMA,
    });

    const published = await makeService().publish('def-1', {});

    const compiled = published.compiledConfig as {
      stages: Array<{ nodes: Array<{ nodeId: string; config: Record<string, unknown> }> }>;
      policyBindings: { contextSchemaRefs?: unknown };
    };
    const trigger = compiled.stages.flatMap((stage) => stage.nodes).find((node) => node.nodeId === 't1');
    expect(trigger?.config).toMatchObject({ contextSchema: { contextSchemaId: SCHEMA_ID, versionNumber: 2, resolved: PAYLOAD_SCHEMA } });
    expect(compiled.policyBindings.contextSchemaRefs).toEqual([{ nodeId: 't1', schemaId: SCHEMA_ID, versionNumber: 2, versionId: VERSION_ID }]);
  });
});

describe('validate — records the same failure without refusing', () => {
  it('keeps the row a DRAFT and records the finding', async () => {
    mockRepository.findById.mockResolvedValue(entity());
    mockContextSchemaService.resolveReference.mockResolvedValue({ outcome: 'failed', failure: 'CONTEXT_SCHEMA_NOT_FOUND' });

    const validated = await makeService().validate('def-1');

    expect(validated.status).toBe(WorkflowDefinitionStatus.DRAFT);
    const report = validated.validationReport as { ok: boolean; findings: Array<{ code?: string }> };
    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.code)).toContain('CONTEXT_SCHEMA_NOT_FOUND');
  });
});

describe('create — the seam with validate()', () => {
  it('does not report ok on a graph validate() would then refuse', async () => {
    mockContextSchemaService.resolveReference.mockResolvedValue({ outcome: 'failed', failure: 'CONTEXT_SCHEMA_NOT_FOUND' });

    const created = await makeService().create({
      slug: 'agent_note',
      name: 'Agent Note',
      paletteKey: 'core',
      graph: BY_REFERENCE,
    } as never);

    const report = created.validationReport as { ok: boolean; findings: Array<{ code?: string }> };
    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.code)).toContain('CONTEXT_SCHEMA_NOT_FOUND');
  });

  it('still WRITES the draft — the publish gate is authoring feedback here, never a refusal', async () => {
    mockContextSchemaService.resolveReference.mockResolvedValue({ outcome: 'failed', failure: 'CONTEXT_SCHEMA_NOT_FOUND' });

    await makeService().create({ slug: 'agent_note', name: 'Agent Note', paletteKey: 'core', graph: BY_REFERENCE } as never);

    expect(mockRepository.create).toHaveBeenCalledTimes(1);
  });
});
