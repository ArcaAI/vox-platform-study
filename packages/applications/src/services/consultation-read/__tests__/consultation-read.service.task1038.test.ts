/**
 * TASK-1036 §9.3 / TASK-1038 lane B3b — `POST internal/consultations/:consultationId/read`.
 *
 * The harness's `consultation.read` activity fetches EXACTLY the `consultation.*` paths a node
 * declared (least privilege, PHI minimisation). The gateway enforces:
 *   - every path exists in `CONSULTATION_READ_SCHEMA_V1`                → 400 CONSULTATION_READ_UNKNOWN_PATH
 *   - the run belongs to the tenant, the consultation to the tenant,
 *     and the run to the consultation                                   → 404 (never 403)
 *   - every path is declared by THAT node of THAT run's workflow version → 400 CONSULTATION_READ_UNDECLARED
 *     (compiled `consultationReads`; a pre-contract artifact falls back to the stored graph)
 *   - each read is audited (forceAuditLog) with paths only — never values.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SysEventType } from '@arcaai/domains';
import { ConsultationReadService } from '../consultation-read.service';
import { declaredReadsForNode, isPathDeclared, pickPath } from '../consultation-read-access';

const TENANT = 'tenant-1';
const CONSULTATION = 'c-1';
const RUN = 'run-1';
const VERSION = 'wf-v3';

const graphReadingAge = {
  version: 1,
  nodes: [
    { id: 't1', type: 'core.trigger', config: { kinds: ['consultation'] } },
    {
      id: 'gen',
      type: 'core.agent',
      config: {
        agentRef: { slug: 's' },
        inputs: { age: { from: 'consultation.patient.age' }, note: { from: 'consultation.notes', at: 'runStart' } },
      },
    },
  ],
  edges: [],
};

const compiledWithReads = (reads: unknown) => ({
  formatVersion: 1,
  stages: [{ stageIndex: 0, nodes: [{ nodeId: 'gen', type: 'core.agent', config: {}, consultationReads: reads }] }],
  settings: { connections: [], sources: ['consultation'] },
});

const mocks = {
  runs: { findAll: vi.fn() },
  definitions: { findById: vi.fn() },
  consultations: { findByIdOrNull: vi.fn() },
  assembler: { assemble: vi.fn() },
  cls: { get: vi.fn(), set: vi.fn() },
  events: { emit: vi.fn() },
};

function makeService(): ConsultationReadService {
  return new ConsultationReadService(
    mocks.events as never,
    mocks.cls as never,
    mocks.runs as never,
    mocks.definitions as never,
    mocks.consultations as never,
    mocks.assembler as never,
  );
}

const request = (paths: string[], overrides: Record<string, unknown> = {}) => ({
  tenantId: TENANT,
  consultationId: CONSULTATION,
  runId: RUN,
  nodeId: 'gen',
  paths,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cls.get.mockImplementation((key: string) => (key === 'tenantId' ? TENANT : undefined));
  mocks.runs.findAll.mockResolvedValue([{ id: 'row-1', tenantId: TENANT, runId: RUN, workflowVersionId: VERSION, metaData: null }]);
  mocks.consultations.findByIdOrNull.mockResolvedValue({
    id: CONSULTATION,
    tenantId: TENANT,
    metadata: { governingEngine: { workflowRunId: RUN, workflowDefinitionSlug: 'scribe' } },
  });
  mocks.definitions.findById.mockResolvedValue({
    id: VERSION,
    tenantId: TENANT,
    graph: graphReadingAge,
    compiledConfig: compiledWithReads([
      { path: 'consultation.patient.age', at: 'nodeStart' },
      { path: 'consultation.notes', at: 'runStart' },
    ]),
  });
  mocks.assembler.assemble.mockResolvedValue({ patient: { age: 54, gender: null, dob: null }, notes: { preSummary: 'pre', summary: null } });
});

describe('pure access helpers', () => {
  it('declaredReadsForNode reads compiled consultationReads, including loop bodies', () => {
    const compiled = {
      stages: [],
      loops: [
        {
          nodeId: 'loop',
          body: { stages: [{ stageIndex: 0, nodes: [{ nodeId: 'inner', consultationReads: [{ path: 'consultation.items', at: 'nodeStart' }] }] }] },
        },
      ],
      settings: { connections: [], sources: [] },
    };
    expect(declaredReadsForNode(compiled, null, 'inner')).toEqual(['consultation.items']);
  });

  it('falls back to the stored graph when the artifact predates the data contract', () => {
    expect(declaredReadsForNode({ stages: [] }, graphReadingAge, 'gen').sort()).toEqual(['consultation.notes', 'consultation.patient.age']);
    expect(declaredReadsForNode(null, graphReadingAge, 'gen')).toHaveLength(2);
  });

  it('a contract-era artifact is authoritative: a node with no reads declares nothing', () => {
    expect(declaredReadsForNode(compiledWithReads(undefined), graphReadingAge, 'gen')).toEqual([]);
  });

  it('a declared container covers its descendants; nothing else does', () => {
    expect(isPathDeclared('consultation.notes.preSummary', ['consultation.notes'])).toBe(true);
    expect(isPathDeclared('consultation.notes', ['consultation.notes'])).toBe(true);
    expect(isPathDeclared('consultation.notesX', ['consultation.notes'])).toBe(false);
    expect(isPathDeclared('consultation.notes', ['consultation.notes.summary'])).toBe(false);
  });

  it('pickPath walks the model and answers null for an absent value', () => {
    expect(pickPath({ patient: { age: 54 } }, 'consultation.patient.age')).toBe(54);
    expect(pickPath({ patient: {} }, 'consultation.patient.dob')).toBeNull();
    expect(pickPath({}, 'consultation.department.name')).toBeNull();
  });
});

describe('ConsultationReadService.read', () => {
  it('returns exactly the requested declared paths, with readAt and schemaVersion', async () => {
    const result = await makeService().read(request(['consultation.patient.age', 'consultation.notes.preSummary']));

    expect(result.values).toEqual({ 'consultation.patient.age': 54, 'consultation.notes.preSummary': 'pre' });
    expect(result.schemaVersion).toBe(1);
    expect(Number.isNaN(Date.parse(result.readAt))).toBe(false);
    // Only the roots asked for are assembled.
    expect(mocks.assembler.assemble).toHaveBeenCalledWith(expect.objectContaining({ id: CONSULTATION }), TENANT, new Set(['patient', 'notes']));
  });

  it('400 CONSULTATION_READ_UNKNOWN_PATH for a path the read schema does not declare', async () => {
    const error = await makeService()
      .read(request(['consultation.patient.ssn']))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(((error as BadRequestException).getResponse() as { code: string }).code).toBe('CONSULTATION_READ_UNKNOWN_PATH');
    expect(mocks.runs.findAll).not.toHaveBeenCalled();
  });

  it('400 for an empty path list', async () => {
    await expect(makeService().read(request([]))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('400 CONSULTATION_READ_UNDECLARED for a path the node did not declare', async () => {
    const error = await makeService()
      .read(request(['consultation.transcript.text']))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse() as { code: string; paths: string[] }).toMatchObject({
      code: 'CONSULTATION_READ_UNDECLARED',
      paths: ['consultation.transcript.text'],
    });
    expect(mocks.assembler.assemble).not.toHaveBeenCalled();
  });

  it('400 UNDECLARED for a node that is not in the version', async () => {
    await expect(makeService().read(request(['consultation.patient.age'], { nodeId: 'ghost' }))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404 for an unknown or foreign run', async () => {
    mocks.runs.findAll.mockResolvedValue([]);
    await expect(makeService().read(request(['consultation.patient.age']))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404 for a foreign consultation', async () => {
    mocks.consultations.findByIdOrNull.mockResolvedValue({ id: CONSULTATION, tenantId: 'tenant-2', metadata: null });
    await expect(makeService().read(request(['consultation.patient.age']))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404 when the run is not this consultation`s run', async () => {
    mocks.consultations.findByIdOrNull.mockResolvedValue({
      id: CONSULTATION,
      tenantId: TENANT,
      metadata: { governingEngine: { workflowRunId: 'other', workflowDefinitionSlug: 's' } },
    });
    await expect(makeService().read(request(['consultation.patient.age']))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a run that records its consultation in its own metadata (sandbox / exposure) is accepted', async () => {
    mocks.consultations.findByIdOrNull.mockResolvedValue({ id: CONSULTATION, tenantId: TENANT, metadata: null });
    mocks.runs.findAll.mockResolvedValue([
      { id: 'row-1', tenantId: TENANT, runId: RUN, workflowVersionId: VERSION, metaData: { consultationId: CONSULTATION } },
    ]);
    await expect(makeService().read(request(['consultation.patient.age']))).resolves.toBeDefined();
  });

  it('the run superseded by a resume is still this consultation`s run', async () => {
    mocks.consultations.findByIdOrNull.mockResolvedValue({
      id: CONSULTATION,
      tenantId: TENANT,
      metadata: { governingEngine: { workflowRunId: 'run-2', workflowDefinitionSlug: 's', supersededRunId: RUN } },
    });
    await expect(makeService().read(request(['consultation.patient.age']))).resolves.toBeDefined();
  });

  it('404 when the run`s workflow version is not the tenant`s', async () => {
    mocks.definitions.findById.mockResolvedValue({ id: VERSION, tenantId: 'tenant-2', graph: graphReadingAge, compiledConfig: null });
    await expect(makeService().read(request(['consultation.patient.age']))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('audits the read with paths and PHI counts — never values', async () => {
    await makeService().read(request(['consultation.patient.age']));

    const viewed = mocks.events.emit.mock.calls.find((call) => call[0] === SysEventType.ResourceViewed)?.[1] as Record<string, unknown>;
    expect(viewed).toMatchObject({ resourceId: CONSULTATION, forceAuditLog: true });
    expect(viewed.data).toMatchObject({
      action: 'consultationDeclaredRead',
      runId: RUN,
      nodeId: 'gen',
      paths: ['consultation.patient.age'],
      phiPathCount: 1,
    });
    // Only the audit payload — the event's own id is a random UUID that may contain "54".
    expect(JSON.stringify(viewed.data)).not.toContain('54');
  });
});
