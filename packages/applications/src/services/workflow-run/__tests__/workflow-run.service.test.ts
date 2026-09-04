/**
 * WorkflowRunService unit tests.
 *
 *  - listRuns: keyset pagination (cursor round-trip, hasMore at exactly
 *    `limit` rows, malformed cursor -> 400), `includeSandbox=false` excludes
 *    sandbox rows by default, filters compose into the `where`.
 *  - getRun: 404-over-403 on a foreign-tenant / nonexistent run id.
 *  - getRunTrace: issues exactly ONE trajectory read (no per-node query);
 *    folds steps into node rollups; derived-attempt grouping on repeated
 *    consecutive names.
 *  - recordRunStarted / recordRunFinished: idempotent on
 *    (tenantId, sessionId, runId); NO sys-event emitted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WorkflowRunEntity, WorkflowRunFactory, WorkflowRunStatus } from '@arcaai/domains';
import { encodeCursor } from '../../../common/cursorPagination';
import { WorkflowRunService, interpreterSessionId, foldStepsIntoNodeRollups } from '../workflow-run.service';
import { AgentTrajectoryStepResponse } from '../../agent-trajectory';

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';
const RUN_ID = 'run-1';
const SESSION_ID = interpreterSessionId(RUN_ID);

function buildRun(overrides: Partial<Parameters<typeof WorkflowRunFactory.CreateRun>[0]> = {}): WorkflowRunEntity {
  return WorkflowRunFactory.CreateRun({
    tenantId: TENANT,
    workflowVersionId: 'wfv-1',
    workflowSlug: 'triage',
    workflowVersionNumber: 3,
    definitionName: 'Triage Workflow',
    sessionId: SESSION_ID,
    runId: RUN_ID,
    trigger: 'api invoke',
    startedAt: new Date('2026-08-16T10:00:00.000Z'),
    ...overrides,
  });
}

function buildDeps(settings?: Record<string, unknown>) {
  const repository = {
    findAll: vi.fn().mockResolvedValue([]),
    findByRunKey: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockImplementation((entity: WorkflowRunEntity) => Promise.resolve(entity)),
    updateWithVersion: vi.fn().mockImplementation((_id: string, entity: WorkflowRunEntity) => Promise.resolve(entity)),
  };
  const eventEmitter = { emit: vi.fn() };
  const clsService = { get: vi.fn().mockReturnValue(undefined) };
  const agentTrajectoryService = {
    listSteps: vi.fn().mockResolvedValue({ items: [], nextCursor: null, hasMore: false, limit: 100 }),
  };
  const appSettingsService = settings
    ? { getValueWithDefault: vi.fn((key: string, fallback: unknown) => (key in settings ? settings[key] : fallback)) }
    : undefined;

  const service = new WorkflowRunService(
    repository as never,
    eventEmitter as never,
    clsService as never,
    agentTrajectoryService as never,
    appSettingsService as never,
  );
  return { service, repository, eventEmitter, clsService, agentTrajectoryService, appSettingsService };
}

function makeStep(overrides: Partial<AgentTrajectoryStepResponse> = {}): AgentTrajectoryStepResponse {
  return {
    id: `step-${Math.random()}`,
    tenantId: TENANT,
    consultationId: null,
    sessionKind: 'HARNESS_DOC',
    sessionId: SESSION_ID,
    runId: '',
    seq: 0,
    stepType: 'PHASE',
    name: 'interpreter.noop',
    status: 'OK',
    startedAt: '2026-08-16T10:00:00.000Z',
    endedAt: '2026-08-16T10:00:01.000Z',
    durationMs: 1000,
    stats: null,
    errorCode: null,
    correlationId: null,
    createdAt: '2026-08-16T10:00:01.000Z',
    ...overrides,
  } as AgentTrajectoryStepResponse;
}

describe('WorkflowRunService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listRuns', () => {
    it('excludes sandbox runs by default (single query-level filter point)', async () => {
      const { service, repository } = buildDeps();
      await service.listRuns(TENANT);
      const props = repository.findAll.mock.calls[0][0];
      expect(props.where).toMatchObject({ tenantId: TENANT, isSandbox: false });
    });

    it('includes sandbox runs when includeSandbox=true', async () => {
      const { service, repository } = buildDeps();
      await service.listRuns(TENANT, { includeSandbox: true });
      const props = repository.findAll.mock.calls[0][0];
      expect(props.where).not.toHaveProperty('isSandbox');
    });

    it('composes optional filters into the where clause', async () => {
      const { service, repository } = buildDeps();
      await service.listRuns(TENANT, { workflowSlug: 'triage', status: 'FAILED', trigger: 'api invoke' });
      const props = repository.findAll.mock.calls[0][0];
      expect(props.where).toMatchObject({ workflowSlug: 'triage', status: 'FAILED', trigger: 'api invoke' });
    });

    it('rejects a malformed cursor with BadRequestException', async () => {
      const { service } = buildDeps();
      await expect(service.listRuns(TENANT, {}, { cursor: 'not-a-valid-cursor!!' })).rejects.toThrow(BadRequestException);
    });

    it('hasMore is true only when the repository returns MORE than `limit` rows (over-fetch pattern)', async () => {
      const { service, repository } = buildDeps();
      const rows = Array.from({ length: 3 }, (_, i) => buildRun({ runId: `run-${i}` }));
      repository.findAll.mockResolvedValueOnce(rows); // over-fetch of limit(2)+1 = 3
      const page = await service.listRuns(TENANT, {}, { limit: 2 });
      expect(page.data).toHaveLength(2);
      expect(page.hasMore).toBe(true);
      expect(page.nextCursor).not.toBeNull();
    });

    it('hasMore is false when the repository returns exactly `limit` rows', async () => {
      const { service, repository } = buildDeps();
      const rows = [buildRun({ runId: 'run-a' }), buildRun({ runId: 'run-b' })];
      repository.findAll.mockResolvedValueOnce(rows);
      const page = await service.listRuns(TENANT, {}, { limit: 2 });
      expect(page.data).toHaveLength(2);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeNull();
    });

    it("round-trips a cursor from one page into the next page's keyset predicate", async () => {
      const { service, repository } = buildDeps();
      const first = [buildRun({ runId: 'run-a', startedAt: new Date('2026-08-16T10:00:00.000Z') })];
      repository.findAll.mockResolvedValueOnce(first);
      const page1 = await service.listRuns(TENANT, {}, { limit: 1 });
      // No more pages signalled here (1 row for limit 1 => hasMore false), so
      // build a cursor manually to prove decode/round-trip through listRuns.
      const cursor = encodeCursor({ k: '2026-08-16T10:00:00.000Z', id: first[0].id });
      repository.findAll.mockResolvedValueOnce([]);
      await service.listRuns(TENANT, {}, { cursor, limit: 1 });
      const secondProps = repository.findAll.mock.calls[1][0];
      expect(JSON.stringify(secondProps.where)).toContain(first[0].id);
      expect(page1.nextCursor).toBeNull();
    });
  });

  describe('getRun', () => {
    it('returns the mapped run when found in-tenant', async () => {
      const { service, repository } = buildDeps();
      const run = buildRun();
      repository.findByRunKey.mockResolvedValueOnce(run);
      const dto = await service.getRun(TENANT, RUN_ID);
      expect(dto.id).toBe(run.id);
      expect(dto.workflowSlug).toBe('triage');
      expect(repository.findByRunKey).toHaveBeenCalledWith(TENANT, SESSION_ID, RUN_ID);
    });

    it('throws NotFoundException (never Forbidden) on a foreign-tenant/nonexistent run id', async () => {
      const { service, repository } = buildDeps();
      repository.findByRunKey.mockResolvedValueOnce(null);
      await expect(service.getRun(OTHER_TENANT, RUN_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('getRunTrace', () => {
    it('issues exactly ONE trajectory read (no per-node query)', async () => {
      const { service, repository, agentTrajectoryService } = buildDeps();
      const run = buildRun();
      repository.findByRunKey.mockResolvedValue(run);
      agentTrajectoryService.listSteps.mockResolvedValueOnce({
        items: [makeStep({ seq: 0 }), makeStep({ seq: 4 })],
        nextCursor: null,
        hasMore: false,
        limit: 100,
      });
      await service.getRunTrace(TENANT, RUN_ID);
      expect(agentTrajectoryService.listSteps).toHaveBeenCalledTimes(1);
      expect(agentTrajectoryService.listSteps).toHaveBeenCalledWith(TENANT, SESSION_ID, expect.any(Object));
    });

    it('folds consecutive same-name steps into one DERIVED attempt group', async () => {
      const { service, repository, agentTrajectoryService } = buildDeps();
      repository.findByRunKey.mockResolvedValue(buildRun());
      agentTrajectoryService.listSteps.mockResolvedValueOnce({
        items: [
          makeStep({ seq: 0, name: 'interpreter.noop', status: 'ERROR', errorCode: 'simulated_failure' }),
          makeStep({ seq: 4, name: 'interpreter.noop', status: 'OK', errorCode: null }),
          makeStep({ seq: 8, name: 'interpreter.passthrough', status: 'OK' }),
        ],
        nextCursor: null,
        hasMore: false,
        limit: 100,
      });
      const trace = await service.getRunTrace(TENANT, RUN_ID);
      expect(trace.nodes).toHaveLength(2);
      expect(trace.nodes[0].nodeType).toBe('interpreter.noop');
      expect(trace.nodes[0].attemptCount).toBe(2);
      expect(trace.nodes[0].attemptSeqs).toEqual([0, 4]);
      expect(trace.nodes[0].attemptGroupingIsDerived).toBe(true);
      expect(trace.nodes[0].status).toBe('OK'); // last attempt wins
      expect(trace.nodes[1].nodeType).toBe('interpreter.passthrough');
      expect(trace.stepCount).toBe(3);
    });

    it('reports truncated=true when the trajectory read hit its cap', async () => {
      const { service, repository, agentTrajectoryService } = buildDeps();
      repository.findByRunKey.mockResolvedValue(buildRun());
      agentTrajectoryService.listSteps.mockResolvedValueOnce({
        items: [makeStep()],
        nextCursor: 'opaque',
        hasMore: true,
        limit: 100,
      });
      const trace = await service.getRunTrace(TENANT, RUN_ID);
      expect(trace.truncated).toBe(true);
    });

    it('throws NotFoundException for a foreign-tenant run id', async () => {
      const { service, repository } = buildDeps();
      repository.findByRunKey.mockResolvedValueOnce(null);
      await expect(service.getRunTrace(OTHER_TENANT, RUN_ID)).rejects.toThrow(NotFoundException);
    });

    describe('tracePruned (Task 9)', () => {
      it('is false when no AppSettings service is wired (unit fixture) — never a false positive', async () => {
        const { service, repository } = buildDeps(); // no settings arg => appSettingsService undefined
        repository.findByRunKey.mockResolvedValue(buildRun({ startedAt: new Date('2000-01-01T00:00:00.000Z') }));
        const trace = await service.getRunTrace(TENANT, RUN_ID);
        expect(trace.tracePruned).toBe(false);
      });

      it('is false whenever the run has any steps, however old', async () => {
        const { service, repository, agentTrajectoryService } = buildDeps({
          'agentic.trajectory.enabled': true,
          'agentic.trajectory.retentionDays': 30,
        });
        repository.findByRunKey.mockResolvedValue(buildRun({ startedAt: new Date('2000-01-01T00:00:00.000Z') }));
        agentTrajectoryService.listSteps.mockResolvedValueOnce({ items: [makeStep()], nextCursor: null, hasMore: false, limit: 100 });
        const trace = await service.getRunTrace(TENANT, RUN_ID);
        expect(trace.tracePruned).toBe(false);
      });

      it('is false when retention is disabled — nothing is actually pruned yet (README R5)', async () => {
        const { service, repository } = buildDeps({ 'agentic.trajectory.enabled': false, 'agentic.trajectory.retentionDays': 30 });
        repository.findByRunKey.mockResolvedValue(buildRun({ startedAt: new Date('2000-01-01T00:00:00.000Z') }));
        const trace = await service.getRunTrace(TENANT, RUN_ID);
        expect(trace.tracePruned).toBe(false);
      });

      it('is false for a zero-step run that starts within the retention window', async () => {
        const { service, repository } = buildDeps({ 'agentic.trajectory.enabled': true, 'agentic.trajectory.retentionDays': 30 });
        repository.findByRunKey.mockResolvedValue(buildRun({ startedAt: new Date() }));
        const trace = await service.getRunTrace(TENANT, RUN_ID);
        expect(trace.tracePruned).toBe(false);
      });

      it('is true for a zero-step run that predates the effective retention window while retention is enabled', async () => {
        const { service, repository, appSettingsService } = buildDeps({
          'agentic.trajectory.enabled': true,
          'agentic.trajectory.retentionDays': 30,
        });
        const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
        repository.findByRunKey.mockResolvedValue(buildRun({ startedAt: old }));
        const trace = await service.getRunTrace(TENANT, RUN_ID);
        expect(trace.tracePruned).toBe(true);
        expect(appSettingsService?.getValueWithDefault).toHaveBeenCalledWith('agentic.trajectory.enabled', false);
        expect(appSettingsService?.getValueWithDefault).toHaveBeenCalledWith('agentic.trajectory.retentionDays', 30);
      });
    });
  });

  describe('foldStepsIntoNodeRollups (pure helper)', () => {
    it('starts a NEW group for a non-consecutive repeat of the same name', () => {
      const nodes = foldStepsIntoNodeRollups([makeStep({ seq: 0, name: 'a' }), makeStep({ seq: 4, name: 'b' }), makeStep({ seq: 8, name: 'a' })]);
      expect(nodes).toHaveLength(3);
      expect(nodes.map((n) => n.nodeType)).toEqual(['a', 'b', 'a']);
    });
  });

  describe('recordRunStarted', () => {
    it('creates a new RUNNING run row when none exists for the key', async () => {
      const { service, repository } = buildDeps();
      const dto = await service.recordRunStarted({
        tenantId: TENANT,
        workflowVersionId: 'wfv-1',
        workflowSlug: 'triage',
        workflowVersionNumber: 1,
        definitionName: 'Triage',
        sessionId: SESSION_ID,
        runId: RUN_ID,
        trigger: 'api invoke',
      });
      expect(repository.create).toHaveBeenCalledTimes(1);
      expect(dto.status).toBe(WorkflowRunStatus.RUNNING);
    });

    it('is idempotent: a re-delivered start returns the existing row and does not create a second one', async () => {
      const { service, repository } = buildDeps();
      const existing = buildRun();
      repository.findByRunKey.mockResolvedValueOnce(existing);
      const dto = await service.recordRunStarted({
        tenantId: TENANT,
        workflowVersionId: 'wfv-1',
        workflowSlug: 'triage',
        workflowVersionNumber: 1,
        definitionName: 'Triage',
        sessionId: SESSION_ID,
        runId: RUN_ID,
        trigger: 'api invoke',
      });
      expect(repository.create).not.toHaveBeenCalled();
      expect(dto.id).toBe(existing.id);
    });

    it('never emits a sys-event (telemetry exemption)', async () => {
      const { service, eventEmitter } = buildDeps();
      await service.recordRunStarted({
        tenantId: TENANT,
        workflowVersionId: 'wfv-1',
        workflowSlug: 'triage',
        workflowVersionNumber: 1,
        definitionName: 'Triage',
        sessionId: SESSION_ID,
        runId: RUN_ID,
        trigger: 'api invoke',
      });
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('recordRunFinished', () => {
    it('updates the existing run to a terminal status via updateWithVersion', async () => {
      const { service, repository } = buildDeps();
      const existing = buildRun();
      repository.findByRunKey.mockResolvedValueOnce(existing);
      const dto = await service.recordRunFinished({
        tenantId: TENANT,
        sessionId: SESSION_ID,
        runId: RUN_ID,
        status: 'COMPLETED',
        nodeCount: 3,
        failedNodeCount: 0,
        degradedNodeCount: 1,
      });
      expect(repository.updateWithVersion).toHaveBeenCalledTimes(1);
      expect(dto.status).toBe('COMPLETED');
      expect(dto.degradedNodeCount).toBe(1);
    });

    it('throws NotFoundException when no matching run row exists', async () => {
      const { service, repository } = buildDeps();
      repository.findByRunKey.mockResolvedValueOnce(null);
      await expect(service.recordRunFinished({ tenantId: TENANT, sessionId: SESSION_ID, runId: RUN_ID, status: 'FAILED' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('emits exactly ONE sys-event, on the terminal status (TASK-864 D-5 reversed the exemption)', async () => {
      const { service, repository, eventEmitter } = buildDeps();
      repository.findByRunKey.mockResolvedValueOnce(buildRun());
      await service.recordRunFinished({ tenantId: TENANT, sessionId: SESSION_ID, runId: RUN_ID, status: 'COMPLETED' });
      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
      const [, event] = eventEmitter.emit.mock.calls[0]!;
      expect(event.resourceType).toBe('WorkflowRun');
      expect(event.data.status).toBe('COMPLETED');
    });
  });
});
