/**
 * TASK-795 W1 — SUBSTRATE EXCLUSIVITY, write side.
 *
 * `ConsultationWorkflowDispatchService` decides, once, at consultation open, which
 * engine governs. This suite pins that the decision is RECORDED DURABLY, and — just
 * as importantly — the ORDER in which it is recorded.
 *
 * The ordering is the whole safety argument:
 *
 *   dispatch first, mark second.  Every failure before the mark degrades to
 *   "Substrate A documents this consultation", which is the outcome the owner
 *   brief names as preferable. Marking FIRST would mean a failed
 *   `startWorkflowRun` leaves Substrate A suppressed with nothing in its place —
 *   a consultation with no documentation at all.
 *
 * The residual is a mark that fails AFTER the run started: both engines then write
 * for that consultation. It is reported (`governanceRecorded: false`) and logged at
 * ERROR rather than swallowed, and it is strictly the lesser harm.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConsultationWorkflowDispatchService } from '../consultation-workflow-dispatch.service';
import { tenantWorkflowGoverns, GOVERNING_ENGINE_METADATA_KEY } from '../../governing-engine';

const TENANT = '50000000-0000-0000-0000-000000000001';
const CONSULTATION = 'c-1';
const DEPARTMENT = 'd-1';
const USER = 'u-1';

const publishedDefinition = {
  id: 'wd-1',
  slug: 'arcaai-consultation-v1',
  versionNumber: 3,
  name: 'ArcaAI Consultation',
  paletteKey: 'consultation',
  compiledConfig: { formatVersion: 1, stages: [], checksum: 'abc' },
};

function makeDeps(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const consultationRow: { id: string; metadata: unknown } = { id: CONSULTATION, metadata: { scheduling: { room: '4B' } } };
  return {
    calls,
    consultationRow,
    assignments: { resolve: vi.fn().mockResolvedValue({ workflowDefinitionSlug: null, source: 'platform-default' }) },
    definitionRepository: { findPublishedBySlug: vi.fn().mockResolvedValue(null) },
    consultationRepository: {
      findById: vi.fn(async () => consultationRow),
      update: vi.fn(async () => {
        calls.push('update');
        return consultationRow;
      }),
    },
    workflowRunService: { recordRunStarted: vi.fn().mockResolvedValue({}) },
    harnessGateway: {
      startWorkflowRun: vi.fn(async () => {
        calls.push('startWorkflowRun');
        return { status: 'RUNNING' };
      }),
    },
    s3Service: { putFile: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  };
}

function makeService(deps: ReturnType<typeof makeDeps>) {
  return new ConsultationWorkflowDispatchService(
    deps.assignments as never,
    deps.definitionRepository as never,
    deps.consultationRepository as never,
    deps.workflowRunService as never,
    deps.harnessGateway as never,
    deps.s3Service as never,
  );
}

const dispatch = (deps: ReturnType<typeof makeDeps>) =>
  makeService(deps).dispatchForConsultation({
    consultationId: CONSULTATION,
    tenantId: TENANT,
    departmentId: DEPARTMENT,
    userId: USER,
  });

function assigned(deps: ReturnType<typeof makeDeps>) {
  deps.assignments.resolve.mockResolvedValue({ workflowDefinitionSlug: publishedDefinition.slug, source: 'tenant' });
  deps.definitionRepository.findPublishedBySlug.mockResolvedValue(publishedDefinition);
}

describe('Substrate exclusivity — the dispatcher records which engine governs', () => {
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    vi.clearAllMocks();
    deps = makeDeps();
  });

  it('persists a durable marker on the consultation when Substrate B is dispatched', async () => {
    assigned(deps);

    const result = await dispatch(deps);

    expect(result.dispatched).toBe(true);
    expect(result.governanceRecorded).toBe(true);
    expect(deps.consultationRepository.update).toHaveBeenCalledTimes(1);
    expect(tenantWorkflowGoverns(deps.consultationRow.metadata)).toBe(true);
  });

  it('records the run id and definition slug in the marker, so the decision is attributable', async () => {
    assigned(deps);

    const result = await dispatch(deps);

    const marker = (deps.consultationRow.metadata as Record<string, Record<string, unknown>>)[GOVERNING_ENGINE_METADATA_KEY];
    expect(marker.workflowRunId).toBe(result.runId);
    expect(marker.workflowDefinitionSlug).toBe(publishedDefinition.slug);
  });

  it('preserves client-supplied metadata rather than replacing it', async () => {
    assigned(deps);

    await dispatch(deps);

    expect(deps.consultationRow.metadata).toMatchObject({ scheduling: { room: '4B' } });
  });

  it('marks AFTER the run starts, never before — a failed start must leave Substrate A in charge', async () => {
    assigned(deps);

    await dispatch(deps);

    expect(deps.calls).toEqual(['startWorkflowRun', 'update']);
  });

  it('writes NO marker when no assignment resolves — the default path is untouched', async () => {
    await dispatch(deps);

    expect(deps.consultationRepository.update).not.toHaveBeenCalled();
    expect(deps.consultationRepository.findById).not.toHaveBeenCalled();
    expect(tenantWorkflowGoverns(deps.consultationRow.metadata)).toBe(false);
  });

  it('writes NO marker when the interpreter run fails to start', async () => {
    assigned(deps);
    deps.harnessGateway.startWorkflowRun = vi.fn().mockRejectedValue(new Error('harness down'));

    const result = await dispatch(deps);

    expect(result.dispatched).toBe(false);
    expect(deps.consultationRepository.update).not.toHaveBeenCalled();
    expect(tenantWorkflowGoverns(deps.consultationRow.metadata)).toBe(false);
  });

  it('writes NO marker when the assigned definition is the wrong palette', async () => {
    deps.assignments.resolve.mockResolvedValue({ workflowDefinitionSlug: 'stt-graph', source: 'tenant' });
    deps.definitionRepository.findPublishedBySlug.mockResolvedValue({ ...publishedDefinition, paletteKey: 'stt' });

    const result = await dispatch(deps);

    expect(result.dispatched).toBe(false);
    expect(deps.consultationRepository.update).not.toHaveBeenCalled();
  });

  it('reports — never throws — when the marker cannot be persisted after a started run', async () => {
    assigned(deps);
    deps.consultationRepository.update = vi.fn().mockRejectedValue(new Error('row locked'));

    const result = await dispatch(deps);

    // The run DID start, so this is not a dispatch failure; it is an unrecorded one.
    expect(result.dispatched).toBe(true);
    expect(result.governanceRecorded).toBe(false);
  });

  it('reports governanceRecorded: false when the consultation row has vanished', async () => {
    assigned(deps);
    deps.consultationRepository.findById = vi.fn().mockResolvedValue(null);

    const result = await dispatch(deps);

    expect(result.dispatched).toBe(true);
    expect(result.governanceRecorded).toBe(false);
    expect(deps.consultationRepository.update).not.toHaveBeenCalled();
  });

  it('reports governanceRecorded: false on the no-assignment path (nothing to record)', async () => {
    const result = await dispatch(deps);

    expect(result.governanceRecorded).toBe(false);
  });
});
