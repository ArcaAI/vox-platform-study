/**
 * TASK-1022 L-RESUME (owner decision 2026-09-30) — a GOVERNED consultation that records again
 * after a stop is re-finalised by its GOVERNING graph, not by the default `harness-doc` engine.
 *
 * The governing run is parked at its `core.humanReview` (a `ReviewGate` child), and its
 * `n_finalize` does not re-run. The chosen mechanism (S) supersedes that run: a FRESH run of the
 * SAME workflow definition version is started through the same dispatch path, the marker moves to
 * it with provenance, and only then is the parked run terminated (its review child goes with it,
 * by Temporal's default parent-close policy). No workflow code changes: the fresh run's live phase
 * reads the handoff the resumed stop wrote, and its `n_finalize` → `persistDraft` adopts the
 * existing unsigned note in place.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';

import { ConsultationWorkflowDispatchService } from '../consultation-workflow-dispatch.service';

const TENANT = '50000000-0000-0000-0000-000000000001';
const CONSULTATION = 'c-resume';
const DOCTOR = 'doctor-1';
const PATIENT = 'patient-1';
const OLD_RUN = 'run-old';

const governedVersion = {
  id: 'wd-v3',
  slug: 'arcaai-consultation-v1',
  versionNumber: 3,
  name: 'ArcaAI Consultation',
  paletteKey: 'core',
  compiledConfig: { formatVersion: 1, stages: [], checksum: 'abc' },
};

function governedRow(marker: Record<string, unknown> = {}) {
  return {
    id: CONSULTATION,
    tenantId: TENANT,
    doctorId: DOCTOR,
    patientId: PATIENT,
    status: 'DRAINING',
    version: 7,
    metadata: {
      clientKey: 'kept',
      governingEngine: {
        engine: 'tenant-workflow',
        workflowRunId: OLD_RUN,
        workflowDefinitionSlug: governedVersion.slug,
        decidedAt: '2026-09-30T08:00:00.000Z',
        ...marker,
      },
    },
  };
}

function makeDeps() {
  let row: ReturnType<typeof governedRow> = governedRow();
  const deps = {
    get row() {
      return row;
    },
    set row(value) {
      row = value;
    },
    assignments: { resolve: vi.fn() },
    definitionRepository: {
      findById: vi.fn().mockResolvedValue(governedVersion),
      findPublishedBySlug: vi.fn().mockResolvedValue({ ...governedVersion, id: 'wd-v4', versionNumber: 4 }),
    },
    consultationRepository: {
      findById: vi.fn(async () => structuredClone(row)),
      update: vi.fn(),
      updateWithVersion: vi.fn(async (_id: string, entity: typeof row, expected: number) => {
        if (expected !== row.version)
          throw new OptimisticConcurrencyException('Consultation', CONSULTATION, { expectedVersion: expected, currentVersion: row.version });
        row = { ...structuredClone(entity), version: row.version + 1 };
        return row;
      }),
    },
    workflowRunService: {
      getRun: vi.fn().mockResolvedValue({ runId: OLD_RUN, workflowVersionId: governedVersion.id }),
      recordRunStarted: vi.fn().mockResolvedValue({}),
      recordRunFinished: vi.fn().mockResolvedValue({}),
      recordRunSuperseded: vi.fn().mockResolvedValue({}),
    },
    harnessGateway: {
      startWorkflowRun: vi.fn().mockResolvedValue({ status: 'RUNNING' }),
      terminateWorkflowRun: vi.fn().mockResolvedValue({ action: 'terminate' }),
    },
    s3Service: { putFile: vi.fn().mockResolvedValue(undefined) },
    runCompletion: { watch: vi.fn().mockReturnValue(true) },
  };
  return deps;
}

function makeService(deps: ReturnType<typeof makeDeps>) {
  return new ConsultationWorkflowDispatchService(
    deps.assignments as never,
    deps.definitionRepository as never,
    deps.consultationRepository as never,
    deps.workflowRunService as never,
    deps.harnessGateway as never,
    deps.s3Service as never,
    undefined, // visitTypes
    deps.runCompletion as never,
  );
}

const input = {
  consultationId: CONSULTATION,
  tenantId: TENANT,
  triggerId: 'agg-2',
  authoredContext: { vitals: { heartRate: 88 } },
};

describe('ConsultationWorkflowDispatchService.supersedeGoverningRun (TASK-1022 L-RESUME)', () => {
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('starts a FRESH run of the SAME definition version, with the consultation identity and the authored context', async () => {
    const result = await makeService(deps).supersedeGoverningRun(input);

    expect(result.superseded).toBe(true);
    expect(result.supersededRunId).toBe(OLD_RUN);
    expect(result.runId).toBeTruthy();
    expect(result.runId).not.toBe(OLD_RUN);

    // The version the parked run executed — never whatever is published now.
    expect(deps.workflowRunService.getRun).toHaveBeenCalledWith(TENANT, OLD_RUN);
    expect(deps.definitionRepository.findById).toHaveBeenCalledWith(governedVersion.id);
    expect(deps.definitionRepository.findPublishedBySlug).not.toHaveBeenCalled();

    expect(deps.workflowRunService.recordRunStarted).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        runId: result.runId,
        sessionId: `wf-${result.runId}`,
        workflowVersionId: governedVersion.id,
        workflowSlug: governedVersion.slug,
        workflowVersionNumber: 3,
        trigger: 'consultation resume',
        isSandbox: false,
      }),
    );
    expect(deps.harnessGateway.startWorkflowRun).toHaveBeenCalledOnce();
    expect(deps.harnessGateway.startWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: result.runId,
        sessionId: `wf-${result.runId}`,
        workflowVersionId: governedVersion.id,
        tenantId: TENANT,
        sandbox: false,
        subject: { consultationId: CONSULTATION, userId: DOCTOR, externalPatientId: PATIENT },
        payload: { vitals: { heartRate: 88 } },
      }),
    );
    expect(deps.runCompletion.watch).toHaveBeenCalledWith(TENANT, result.runId, CONSULTATION);
  });

  it('moves the marker to the new run WITH provenance, keeping every other metadata key', async () => {
    const result = await makeService(deps).supersedeGoverningRun(input);

    const metadata = deps.row.metadata as Record<string, Record<string, unknown>>;
    expect(metadata.clientKey).toBe('kept');
    expect(metadata.governingEngine).toMatchObject({
      engine: 'tenant-workflow',
      workflowRunId: result.runId,
      workflowDefinitionSlug: governedVersion.slug,
      supersededRunId: OLD_RUN,
      supersedeTriggerId: 'agg-2',
    });
    // A fresh run has no terminal outcome yet.
    expect(metadata.governingEngine).not.toHaveProperty('runStatus');
    // Compare-and-set, never a blind write: a concurrent supersede must lose, not overwrite.
    expect(deps.consultationRepository.updateWithVersion).toHaveBeenCalled();
    expect(deps.consultationRepository.update).not.toHaveBeenCalled();
  });

  it('terminates the parked run only AFTER the new one started, and closes its run row as CANCELED', async () => {
    const order: string[] = [];
    deps.harnessGateway.startWorkflowRun.mockImplementation(async () => {
      order.push('start');
      return { status: 'RUNNING' };
    });
    deps.harnessGateway.terminateWorkflowRun.mockImplementation(async () => {
      order.push('terminate');
      return {};
    });

    const result = await makeService(deps).supersedeGoverningRun(input);

    expect(order).toEqual(['start', 'terminate']);
    expect(deps.harnessGateway.terminateWorkflowRun).toHaveBeenCalledWith(
      OLD_RUN,
      expect.objectContaining({ tenantId: TENANT, reason: expect.stringContaining(String(result.runId)) }),
    );
    // TASK-1022 A2 — the row is closed through `recordRunSuperseded`, which cancels only a row that
    // is still RUNNING; a finished run keeps its terminal status and `endedAt`.
    expect(deps.workflowRunService.recordRunSuperseded).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        runId: OLD_RUN,
        sessionId: `wf-${OLD_RUN}`,
        supersededBy: result.runId,
        consultationId: CONSULTATION,
      }),
    );
    expect(deps.workflowRunService.recordRunFinished).not.toHaveBeenCalled();
  });

  it('two deliveries of the same resumed stop start ONE run (single-flight + the marker’s trigger id)', async () => {
    const service = makeService(deps);

    const [first, second] = await Promise.all([service.supersedeGoverningRun(input), service.supersedeGoverningRun(input)]);

    expect(deps.harnessGateway.startWorkflowRun).toHaveBeenCalledOnce();
    expect(deps.harnessGateway.terminateWorkflowRun).toHaveBeenCalledOnce();
    expect([first.superseded, second.superseded].sort()).toEqual([false, true]);
    expect(second.runId).toBe(first.runId);
  });

  it('a duplicate already recorded on the marker (another instance won) starts nothing', async () => {
    deps.row = governedRow({ workflowRunId: 'run-new-elsewhere', supersededRunId: OLD_RUN, supersedeTriggerId: 'agg-2' });

    const result = await makeService(deps).supersedeGoverningRun(input);

    expect(result).toMatchObject({ superseded: false, runId: 'run-new-elsewhere', skippedReason: 'duplicate' });
    expect(deps.harnessGateway.startWorkflowRun).not.toHaveBeenCalled();
    expect(deps.harnessGateway.terminateWorkflowRun).not.toHaveBeenCalled();
  });

  it('a later resumed stop supersedes the run the previous supersede started', async () => {
    const service = makeService(deps);
    const first = await service.supersedeGoverningRun(input);
    deps.workflowRunService.getRun.mockResolvedValue({ runId: first.runId, workflowVersionId: governedVersion.id });

    const second = await service.supersedeGoverningRun({ ...input, triggerId: 'agg-3' });

    expect(second.superseded).toBe(true);
    expect(second.supersededRunId).toBe(first.runId);
    expect(deps.harnessGateway.terminateWorkflowRun).toHaveBeenLastCalledWith(first.runId, expect.anything());
  });

  it('an ungoverned consultation is never superseded', async () => {
    deps.row = { ...governedRow(), metadata: { clientKey: 'kept' } } as never;

    const result = await makeService(deps).supersedeGoverningRun(input);

    expect(result).toMatchObject({ superseded: false, skippedReason: 'not-governed' });
    expect(deps.harnessGateway.startWorkflowRun).not.toHaveBeenCalled();
  });

  it('a start that fails puts the marker back and leaves the parked run alone', async () => {
    deps.harnessGateway.startWorkflowRun.mockRejectedValue(new Error('harness unreachable'));

    const result = await makeService(deps).supersedeGoverningRun(input);

    expect(result.superseded).toBe(false);
    expect(result.skippedReason).toBe('failed');
    expect((deps.row.metadata as Record<string, Record<string, unknown>>).governingEngine).toMatchObject({ workflowRunId: OLD_RUN });
    expect((deps.row.metadata as Record<string, Record<string, unknown>>).governingEngine).not.toHaveProperty('supersedeTriggerId');
    expect(deps.harnessGateway.terminateWorkflowRun).not.toHaveBeenCalled();
  });

  it('a terminate that fails does not undo the supersede — the new run governs', async () => {
    deps.harnessGateway.terminateWorkflowRun.mockRejectedValue(new Error('already closed'));

    const result = await makeService(deps).supersedeGoverningRun(input);

    expect(result.superseded).toBe(true);
    expect((deps.row.metadata as Record<string, Record<string, unknown>>).governingEngine).toMatchObject({ workflowRunId: result.runId });
  });

  it('retries the claim on a concurrent row write that did not supersede', async () => {
    // Another writer (the stop's DRAINING transition) bumps the row between read and claim.
    let bumped = false;
    const original = deps.consultationRepository.findById.getMockImplementation()!;
    deps.consultationRepository.findById.mockImplementation(async () => {
      const read = await original();
      if (!bumped) {
        bumped = true;
        deps.row = { ...deps.row, version: deps.row.version + 1 };
      }
      return read;
    });

    const result = await makeService(deps).supersedeGoverningRun(input);

    expect(result.superseded).toBe(true);
    expect(deps.harnessGateway.startWorkflowRun).toHaveBeenCalledOnce();
  });
});
