/**
 * `Repository.createMany` — optional transaction client.
 *
 * `createMany` never accepted a `tx` client — every other write path on the
 * base class (`create`, `updateWithVersion`) does, precisely so a caller can
 * fold the write into a business transaction. That gap forced
 * `AgentTrajectoryService.recordSteps` to persist steps and emit their
 * usage-ledger rows as two INDEPENDENT operations (the "sanctioned no-tx
 * fallback"). These tests pin the fix through the
 * concrete `AgentTrajectoryStepRepository` — the base `Repository` class
 * itself is untestable directly (`common/__tests__/repository.test.ts` is
 * disabled behind a circular-dependency `it.todo` stub), so a generated
 * subclass is the smallest reachable surface for the base method.
 */
import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { AgentSessionKind, AgentStepStatus, AgentStepType } from '../../enums';
import { AgentTrajectoryStepFactory } from '../../factories';
import { AgentTrajectoryStepRepository } from '../generated/core/AgentTrajectoryStepRepository';

function makeRepo() {
  const delegate = { createMany: vi.fn().mockResolvedValue({ count: 2 }) };
  const uow = { getDatabaseService: () => ({ agentTrajectoryStep: delegate }) };
  const repo = new AgentTrajectoryStepRepository(uow as never);
  return { repo, delegate };
}

function makeEntities() {
  return [
    AgentTrajectoryStepFactory.CreateStep({
      tenantId: 'tenant-1',
      sessionKind: AgentSessionKind.LIVE_DOC,
      sessionId: 'session-1',
      runId: 'run-1',
      seq: 0,
      stepType: AgentStepType.LLM_CALL,
      name: 'step-0',
      status: AgentStepStatus.OK,
      startedAt: new Date('2026-08-06T10:00:00.000Z'),
    }),
    AgentTrajectoryStepFactory.CreateStep({
      tenantId: 'tenant-1',
      sessionKind: AgentSessionKind.LIVE_DOC,
      sessionId: 'session-1',
      runId: 'run-1',
      seq: 1,
      stepType: AgentStepType.PHASE,
      name: 'step-1',
      status: AgentStepStatus.OK,
      startedAt: new Date('2026-08-06T10:00:01.000Z'),
    }),
  ];
}

describe('Repository.createMany — optional tx (mirrors create()/updateWithVersion())', () => {
  it('without tx: writes through the cached extended-client delegate (unchanged behavior)', async () => {
    const { repo, delegate } = makeRepo();

    const result = await repo.createMany(makeEntities(), true);

    expect(result).toEqual({ count: 2 });
    expect(delegate.createMany).toHaveBeenCalledTimes(1);
    const [call] = delegate.createMany.mock.calls;
    expect(call[0].skipDuplicates).toBe(true);
    expect(call[0].data).toHaveLength(2);
  });

  it('with tx: routes the write through tx.<model>.createMany, NOT the cached delegate', async () => {
    const { repo, delegate } = makeRepo();
    const txDelegate = { createMany: vi.fn().mockResolvedValue({ count: 2 }) };
    const tx = { agentTrajectoryStep: txDelegate };

    const result = await repo.createMany(makeEntities(), true, tx as never);

    expect(result).toEqual({ count: 2 });
    expect(txDelegate.createMany).toHaveBeenCalledTimes(1);
    expect(delegate.createMany).not.toHaveBeenCalled();
  });

  it('an empty entity array short-circuits to {count: 0} without touching either delegate, tx or not', async () => {
    const { repo, delegate } = makeRepo();
    const txDelegate = { createMany: vi.fn() };

    const result = await repo.createMany([], true, { agentTrajectoryStep: txDelegate } as never);

    expect(result).toEqual({ count: 0 });
    expect(delegate.createMany).not.toHaveBeenCalled();
    expect(txDelegate.createMany).not.toHaveBeenCalled();
  });

  it('skipDuplicates still threads through when tx is supplied', async () => {
    const { repo } = makeRepo();
    const txDelegate = { createMany: vi.fn().mockResolvedValue({ count: 1 }) };

    await repo.createMany(makeEntities(), false, { agentTrajectoryStep: txDelegate } as never);

    expect(txDelegate.createMany.mock.calls[0][0].skipDuplicates).toBe(false);
  });
});
