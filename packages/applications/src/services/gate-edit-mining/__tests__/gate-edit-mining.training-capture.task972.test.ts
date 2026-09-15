/**
 * TASK-972 Lane 2 (OD-4) — the training-capture opt-out, at its two enforcement points.
 *
 * The DNA double-check pattern, for the same reason DNA uses it: the toggle may flip between
 * the moment a job is enqueued and the moment it drains, and the second read is the one that
 * runs immediately before anything is PERSISTED.
 *
 *  - `GateEditMiningQueue.enqueue` — nothing is queued for an opted-out clinician.
 *  - `GateEditMiningProcessor.process` — nothing is mined even for a job that was already queued.
 *
 * The property that matters clinically is the LAST spec in this file: the opt-out suppresses
 * CAPTURE ONLY. A clinical action is never failed for a training-data reason, so the enqueue
 * must return normally — the sign-off that called it is already committed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GateEditMiningProcessor, GateEditMiningQueue } from '../gate-edit-mining.processor';

const TENANT = 'tenant-1';
const CONSULTATION = 'c-1';
const CONTEXT_ITEM = 'ci-1';
const DOCTOR = 'doctor-1';

const job = () => ({
  tenantId: TENANT,
  consultationId: CONSULTATION,
  contextItemId: CONTEXT_ITEM,
  doctorId: DOCTOR,
  gateDecision: 'SIGNED',
  signedAt: '2026-09-15T00:00:00.000Z',
});

const resolver = (effective: boolean) => ({
  resolveEffectiveTrainingCaptureEnabled: vi.fn(async () => ({ effective, tenantEnabled: effective, doctorToggle: effective ? null : false })),
});

describe('GateEditMiningQueue.enqueue — the opt-out at the enqueue', () => {
  let queue: { add: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    queue = { add: vi.fn().mockResolvedValue(undefined) };
  });

  it('queues the encounter when capture is enabled', async () => {
    const sut = new GateEditMiningQueue(queue as never, resolver(true) as never);
    await sut.enqueue(job());
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('queues NOTHING for an opted-out clinician', async () => {
    const config = resolver(false);
    const sut = new GateEditMiningQueue(queue as never, config as never);

    await sut.enqueue(job());

    expect(queue.add).not.toHaveBeenCalled();
    expect(config.resolveEffectiveTrainingCaptureEnabled).toHaveBeenCalledWith({ tenantId: TENANT, doctorId: DOCTOR });
  });

  it('RETURNS NORMALLY when capture is off — a clinical action is never failed for a training-data reason', async () => {
    const sut = new GateEditMiningQueue(queue as never, resolver(false) as never);
    await expect(sut.enqueue(job())).resolves.toBeUndefined();
  });

  it('queues as before when no resolver is wired at all (pre-ticket behaviour)', async () => {
    const sut = new GateEditMiningQueue(queue as never, undefined);
    await sut.enqueue(job());
    expect(queue.add).toHaveBeenCalledTimes(1);
  });
});

describe('GateEditMiningProcessor.process — the RE-check before anything is persisted', () => {
  const build = (config?: unknown) => {
    const miningService = { mineFromGateDecision: vi.fn().mockResolvedValue(undefined) };
    const contextItemVersionRepository = { getVersionsByChangeReason: vi.fn().mockResolvedValue([{ content: 'signed' }]) };
    const consultationRepository = { findById: vi.fn().mockResolvedValue({ departmentId: null, doctorId: DOCTOR, metadata: null, parentConsultationId: null }) };
    const cls = { run: vi.fn(async (fn: () => unknown) => fn()), set: vi.fn(), get: vi.fn() };
    const processor = new GateEditMiningProcessor(
      miningService as never,
      {} as never,
      contextItemVersionRepository as never,
      consultationRepository as never,
      cls as never,
      undefined,
      config as never,
    );
    return { processor, miningService, consultationRepository };
  };

  beforeEach(() => vi.clearAllMocks());

  it('mines when capture is still enabled at drain time', async () => {
    const { processor, miningService } = build(resolver(true));
    await processor.process({ id: 'j-1', data: job() } as never);
    expect(miningService.mineFromGateDecision).toHaveBeenCalledTimes(1);
  });

  it('mines NOTHING when the toggle flipped off between enqueue and drain', async () => {
    const { processor, miningService } = build(resolver(false));
    await processor.process({ id: 'j-1', data: job() } as never);
    expect(miningService.mineFromGateDecision).not.toHaveBeenCalled();
  });

  it('resolves the clinician off the CONSULTATION when the job carries no doctorId (an older queued job)', async () => {
    const config = resolver(false);
    const { processor } = build(config);
    const { doctorId: _omitted, ...withoutDoctor } = job();
    await processor.process({ id: 'j-1', data: withoutDoctor } as never);
    expect(config.resolveEffectiveTrainingCaptureEnabled).toHaveBeenCalledWith({ tenantId: TENANT, doctorId: DOCTOR });
  });

  it('mines as before when no resolver is wired at all (pre-ticket behaviour)', async () => {
    const { processor, miningService } = build(undefined);
    await processor.process({ id: 'j-1', data: job() } as never);
    expect(miningService.mineFromGateDecision).toHaveBeenCalledTimes(1);
  });
});
