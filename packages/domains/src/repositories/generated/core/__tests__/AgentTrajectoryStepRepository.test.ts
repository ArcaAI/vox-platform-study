/**
 * AgentTrajectoryStepRepository — ordered ops-telemetry read/write (
 * Phase 2A).
 *
 * `AgentTrajectoryStep` is the ordered, typed per-session step stream. It is
 * TENANT-SCOPED but INTENTIONALLY exempt from soft-delete + sys-events: it is
 * high-volume operational telemetry pruned by a retention job (hard delete),
 * not lifecycle-managed clinical data. The cross-tenant ISOLATION guarantee is
 * enforced by the shared tenant-scope Prisma `$extends`
 * (`packages/database/src/extensions/tenant-scope.ts`, whose drift guard now
 * lists AgentTrajectoryStep) — this suite covers the repository contract:
 * per-session listing ordered by `seq`, tenant-scoped filters, and a
 * version-stripped create.
 *
 * The base `Repository.db` getter returns
 * `unitOfWork.getDatabaseService()[modelName]`, so we hand the repo a fake
 * unit-of-work whose `agentTrajectoryStep` delegate is a mock and assert the
 * query shape + mapping.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentTrajectoryStepRepository } from '../AgentTrajectoryStepRepository';
import { AgentTrajectoryStepFactory } from '../../../../factories';
import { AgentSessionKind, AgentStepStatus, AgentStepType } from '../../../../enums';
import { AgentTrajectoryStep } from '../../../../models';

const makeUow = (delegate: any) => ({ getDatabaseService: () => ({ agentTrajectoryStep: delegate }) });

const row = (overrides: Partial<AgentTrajectoryStep> = {}): AgentTrajectoryStep =>
  ({
    id: 'ats-1',
    tenantId: 'tenant-1',
    version: 1,
    metaData: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    consultationId: 'consult-1',
    sessionKind: AgentSessionKind.HARNESS_DOC,
    sessionId: 'wf-1',
    runId: '',
    seq: 0,
    stepType: AgentStepType.PHASE,
    name: 'init',
    status: AgentStepStatus.OK,
    startedAt: new Date(),
    endedAt: null,
    durationMs: null,
    stats: null,
    payloadRef: null,
    errorCode: null,
    correlationId: null,
    ...overrides,
  }) as AgentTrajectoryStep;

describe('AgentTrajectoryStepRepository', () => {
  let findMany: ReturnType<typeof vi.fn>;
  let create: ReturnType<typeof vi.fn>;
  let groupBy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    findMany = vi.fn();
    create = vi.fn();
    groupBy = vi.fn();
  });

  it('findBySession lists steps ordered by seq ascending, scoped to the tenant', async () => {
    findMany.mockResolvedValue([
      row({ seq: 0, name: 'init' }),
      row({ seq: 1, name: 'generate' }),
      row({ seq: 2, name: 'run_sensors' }),
    ]);
    const repo = new AgentTrajectoryStepRepository(makeUow({ findMany }) as never);

    const result = await repo.findBySession('tenant-1', 'wf-1');

    expect(findMany).toHaveBeenCalledTimes(1);
    const arg = findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ tenantId: 'tenant-1', sessionId: 'wf-1' });
    expect(arg.orderBy).toEqual([{ seq: 'asc' }]);
    expect(result.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(result.map((e) => e.name)).toEqual(['init', 'generate', 'run_sensors']);
  });

  it('findBySession narrows by runId when supplied (per-run seq stream)', async () => {
    findMany.mockResolvedValue([row({ seq: 0, runId: 'run-1' })]);
    const repo = new AgentTrajectoryStepRepository(makeUow({ findMany }) as never);

    await repo.findBySession('tenant-1', 'wf-1', 'run-1');

    const arg = findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ tenantId: 'tenant-1', sessionId: 'wf-1', runId: 'run-1' });
    expect(arg.orderBy).toEqual([{ seq: 'asc' }]);
  });

  it('findByConsultation lists a consultation timeline ordered by seq, tenant-scoped', async () => {
    findMany.mockResolvedValue([row({ seq: 0 }), row({ seq: 1 })]);
    const repo = new AgentTrajectoryStepRepository(makeUow({ findMany }) as never);

    const result = await repo.findByConsultation('tenant-1', 'consult-1');

    const arg = findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ tenantId: 'tenant-1', consultationId: 'consult-1' });
    expect(arg.orderBy).toEqual([{ seq: 'asc' }]);
    expect(result).toHaveLength(2);
  });

  it('create persists a factory-built step with tenant scope and no DB-owned _version', async () => {
    create.mockImplementation(({ data }: any) => Promise.resolve({ ...row(), ...data }));
    const repo = new AgentTrajectoryStepRepository(makeUow({ create }) as never);

    const step = AgentTrajectoryStepFactory.CreateStep({
      tenantId: 'tenant-1',
      consultationId: 'consult-1',
      sessionKind: AgentSessionKind.HARNESS_DOC,
      sessionId: 'wf-1',
      seq: 0,
      stepType: AgentStepType.PHASE,
      name: 'init',
      status: AgentStepStatus.OK,
      startedAt: new Date(),
    });

    await repo.create(step);

    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      tenantId: 'tenant-1',
      sessionId: 'wf-1',
      seq: 0,
      stepType: 'PHASE',
      name: 'init',
      status: 'OK',
    });
    // `_version` is database-owned (only updateWithVersion writes it) — the
    // mapper must strip it from the create payload.
    expect(data).not.toHaveProperty('version');
  });

  describe('listSessionSummaries — DB-level groupBy', () => {
    it('groups by sessionKind+sessionId+runId with stepCount and first/last timestamps', async () => {
      const first = new Date('2026-07-19T10:00:00.000Z');
      const lastStarted = new Date('2026-07-19T10:00:05.000Z');
      const lastEnded = new Date('2026-07-19T10:00:06.000Z');
      groupBy.mockResolvedValue([
        {
          sessionKind: AgentSessionKind.HARNESS_DOC,
          sessionId: 'wf-1',
          runId: 'run-1',
          _count: { _all: 3 },
          _min: { startedAt: first },
          _max: { startedAt: lastStarted, endedAt: lastEnded, consultationId: 'consult-1' },
        },
      ]);
      const repo = new AgentTrajectoryStepRepository(makeUow({ groupBy }) as never);

      const result = await repo.listSessionSummaries('tenant-1');

      expect(groupBy).toHaveBeenCalledTimes(1);
      const arg = groupBy.mock.calls[0][0];
      expect(arg.by).toEqual(['sessionKind', 'sessionId', 'runId']);
      expect(arg.where).toEqual({ tenantId: 'tenant-1' });
      expect(arg._count).toEqual({ _all: true });
      expect(arg._min).toEqual({ startedAt: true });
      expect(arg._max).toEqual({ startedAt: true, endedAt: true, consultationId: true });
      expect(result).toEqual([
        {
          sessionId: 'wf-1',
          runId: 'run-1',
          sessionKind: 'HARNESS_DOC',
          consultationId: 'consult-1',
          stepCount: 3,
          firstStepAt: first,
          lastStepAt: lastEnded,
        },
      ]);
    });

    it('uses max(startedAt) as lastStepAt when endedAt aggregates are null', async () => {
      const started = new Date('2026-07-19T11:00:00.000Z');
      groupBy.mockResolvedValue([
        {
          sessionKind: AgentSessionKind.LIVE_DOC,
          sessionId: 'live-1',
          runId: '',
          _count: { _all: 1 },
          _min: { startedAt: started },
          _max: { startedAt: started, endedAt: null, consultationId: null },
        },
      ]);
      const repo = new AgentTrajectoryStepRepository(makeUow({ groupBy }) as never);

      const result = await repo.listSessionSummaries('tenant-1');

      expect(result[0].lastStepAt).toEqual(started);
      expect(result[0].consultationId).toBeNull();
    });

    it('applies consultationId, sessionKind, and createdAt range filters', async () => {
      groupBy.mockResolvedValue([]);
      const repo = new AgentTrajectoryStepRepository(makeUow({ groupBy }) as never);
      const from = new Date('2026-07-01T00:00:00.000Z');
      const to = new Date('2026-07-19T23:59:59.000Z');

      await repo.listSessionSummaries('tenant-1', {
        consultationId: 'consult-1',
        sessionKind: AgentSessionKind.SUMMARY_JOB,
        createdAt: { gte: from, lte: to },
      });

      expect(groupBy.mock.calls[0][0].where).toEqual({
        tenantId: 'tenant-1',
        consultationId: 'consult-1',
        sessionKind: AgentSessionKind.SUMMARY_JOB,
        createdAt: { gte: from, lte: to },
      });
    });
  });
});
