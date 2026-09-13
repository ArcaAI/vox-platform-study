/**
 * TASK-957 F-8 — the trajectory ingest must ACCEPT and FORWARD the identity the
 * harness now sends.
 *
 * Two halves, and the first one is the reason the second matters. Under the
 * global `forbidNonWhitelisted` pipe an undeclared key does not degrade — it
 * 400s the WHOLE batch, every step in it, and the harness POST is
 * fire-and-forget, so the failure is a warn line and a permanently missing
 * ledger row. So the DTO has to accept the four fields BEFORE any worker sends
 * them, which is also why they are pinned here rather than only where they are
 * consumed.
 *
 * `nodeType` is accepted and deliberately goes no further than the ingest
 * input: `attributesJson` is a PHI allow-list and adding a key to it is a
 * deliberate act (`usage-attributes.ts`), `nodeId` already identifies the node
 * within its version, and the type is recoverable from the definition. Accepted
 * ≠ billed, and the gap between the two is the point.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

import { HarnessInternalController, ReportTrajectoryRequest } from '../harness-internal.controller';

const trajectoryService = { recordSteps: vi.fn(), recordComputeSamples: vi.fn() };
const cls = { run: vi.fn((fn: () => unknown) => fn()), set: vi.fn() };

const buildController = () =>
  new HarnessInternalController(
    undefined as never,
    undefined as never,
    cls as never,
    undefined as never,
    undefined as never,
    trajectoryService as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
  );

const step = (overrides: Record<string, unknown> = {}) => ({
  tenantId: 't-1',
  sessionKind: 'HARNESS_DOC',
  sessionId: 'wf-1',
  runId: 'run-1',
  seq: 0,
  stepType: 'LLM_CALL',
  name: 'generate',
  status: 'OK',
  startedAt: '2026-09-13T10:00:00.000Z',
  ...overrides,
});

const identity = {
  doctorId: 'dr-9',
  nodeId: 'draft-note',
  workflowVersionId: 'wfv-7',
  nodeType: 'core.agent',
};

beforeEach(() => {
  vi.clearAllMocks();
  trajectoryService.recordSteps.mockResolvedValue(undefined);
  trajectoryService.recordComputeSamples.mockResolvedValue(undefined);
});

describe('POST internal/harness/trajectory — step identity (TASK-957 F-8)', () => {
  it('validates a step carrying all four identity fields', async () => {
    const dto = plainToInstance(ReportTrajectoryRequest, { steps: [step(identity)] });

    expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
  });

  it('still validates a step carrying none of them — an older worker is unaffected', async () => {
    const dto = plainToInstance(ReportTrajectoryRequest, { steps: [step()] });

    expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
  });

  it('forwards all four onto the ingest input', async () => {
    await buildController().reportTrajectory({ steps: [step(identity)] } as never);

    expect(trajectoryService.recordSteps).toHaveBeenCalledTimes(1);
    expect(trajectoryService.recordSteps.mock.calls[0][0][0]).toMatchObject(identity);
  });

  it('forwards undefined, never null, when the worker sent nothing', async () => {
    await buildController().reportTrajectory({ steps: [step()] } as never);

    const mapped = trajectoryService.recordSteps.mock.calls[0][0][0];
    expect(mapped.doctorId).toBeUndefined();
    expect(mapped.nodeId).toBeUndefined();
    expect(mapped.workflowVersionId).toBeUndefined();
    expect(mapped.nodeType).toBeUndefined();
  });
});

describe('POST internal/harness/trajectory — compute-sample identity (TASK-957 F-8)', () => {
  const sample = (overrides: Record<string, unknown> = {}) => ({
    tenantId: 't-1',
    sessionId: 'wf-1',
    runId: 'run-1',
    activityId: '7',
    attempt: 1,
    activityType: 'core.agent',
    cpuMs: 1.25,
    wallMs: 40,
    ...overrides,
  });

  it('accepts the identity fields a metering interceptor can read off the activity input', async () => {
    const dto = plainToInstance(ReportTrajectoryRequest, {
      computeSamples: [sample({ nodeId: 'draft-note', workflowVersionId: 'wfv-7', doctorId: 'dr-9' })],
    });

    expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
  });

  it('forwards them onto the sample input', async () => {
    await buildController().reportTrajectory({
      computeSamples: [sample({ nodeId: 'draft-note', workflowVersionId: 'wfv-7', doctorId: 'dr-9' })],
    } as never);

    expect(trajectoryService.recordComputeSamples.mock.calls[0][0][0]).toMatchObject({
      nodeId: 'draft-note',
      workflowVersionId: 'wfv-7',
      doctorId: 'dr-9',
    });
  });
});
