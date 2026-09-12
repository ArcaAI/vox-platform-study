/**
 * TASK-959 §10.2 — `computeSamples` on the trajectory POST.
 *
 * The durable worker flushes trajectory steps at phase boundaries and its own
 * compute samples on a separate timer, so a flush often carries only one kind.
 * Under the global `forbidNonWhitelisted` pipe an UNDECLARED key does not
 * degrade — it 400s the whole batch, steps included — which is why the wire
 * contract and this DTO have to agree exactly, and why the shape of a
 * compute-only POST is pinned here rather than assumed.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
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

const step = () => ({
  tenantId: 't-1',
  sessionKind: 'HARNESS_DOC',
  sessionId: 'wf-1',
  runId: 'run-1',
  seq: 0,
  stepType: 'LLM_CALL',
  name: 'generate',
  status: 'OK',
  startedAt: '2026-09-12T10:00:00.000Z',
});

beforeEach(() => {
  vi.clearAllMocks();
  trajectoryService.recordSteps.mockResolvedValue(undefined);
  trajectoryService.recordComputeSamples.mockResolvedValue(undefined);
});

describe('POST internal/harness/trajectory — computeSamples', () => {
  it('accepts a compute-only POST, with no steps key at all', async () => {
    const result = await buildController().reportTrajectory({ computeSamples: [sample()] } as never);

    expect(trajectoryService.recordSteps).not.toHaveBeenCalled();
    expect(trajectoryService.recordComputeSamples).toHaveBeenCalledTimes(1);
    expect(trajectoryService.recordComputeSamples.mock.calls[0][0][0]).toMatchObject({ activityId: '7', attempt: 1, cpuMs: 1.25 });
    expect(result).toEqual({ accepted: 1 });
    // A compute-only POST still has to establish CLS — from the sample, since
    // there is no step batch to read a tenant from.
    expect(cls.set).toHaveBeenCalledWith('tenantId', 't-1');
  });

  it('accepts a mixed POST and counts both halves', async () => {
    const result = await buildController().reportTrajectory({ steps: [step()], computeSamples: [sample(), sample({ activityId: '8' })] } as never);

    expect(trajectoryService.recordSteps).toHaveBeenCalledTimes(1);
    expect(trajectoryService.recordComputeSamples).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ accepted: 3 });
  });

  it('keeps a steps-only POST exactly as it was', async () => {
    const result = await buildController().reportTrajectory({ steps: [step()] } as never);

    expect(trajectoryService.recordComputeSamples).not.toHaveBeenCalled();
    expect(result).toEqual({ accepted: 1 });
  });

  it('rejects a body carrying neither key — there is nothing it could mean', async () => {
    await expect(buildController().reportTrajectory({} as never)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps an explicitly EMPTY steps array a no-op ack, not a 400', async () => {
    await expect(buildController().reportTrajectory({ steps: [] } as never)).resolves.toEqual({ accepted: 0 });
    await expect(buildController().reportTrajectory({ computeSamples: [] } as never)).resolves.toEqual({ accepted: 0 });
  });
});

describe('the computeSamples DTO under the strict global pipe', () => {
  // Exercised through the same three options the global pipe applies in
  // `main.ts`, because "the DTO is fine" and "the pipe accepts it" are only the
  // same statement under `forbidNonWhitelisted`.
  const validateBody = async (body: unknown) =>
    validate(plainToInstance(ReportTrajectoryRequest, body), { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });

  it('accepts the exact wire object the worker sends', async () => {
    await expect(validateBody({ computeSamples: [sample()] })).resolves.toEqual([]);
  });

  it('accepts a FRACTIONAL cpuMs — an integer field would reject most of this worker’s samples', async () => {
    await expect(validateBody({ computeSamples: [sample({ cpuMs: 0.004, wallMs: 0.9 })] })).resolves.toEqual([]);
  });

  it('accepts the optional trigger, and a body with no trigger key', async () => {
    await expect(validateBody({ computeSamples: [sample({ trigger: 'WORKFLOW_RUN' })] })).resolves.toEqual([]);
    await expect(validateBody({ computeSamples: [sample()] })).resolves.toEqual([]);
  });

  it('rejects an undeclared key rather than silently dropping a field the worker thought it sent', async () => {
    const errors = await validateBody({ computeSamples: [{ ...sample(), gpuMs: 3 }] });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a negative or missing identity field', async () => {
    expect((await validateBody({ computeSamples: [sample({ cpuMs: -1 })] })).length).toBeGreaterThan(0);
    expect((await validateBody({ computeSamples: [sample({ runId: '' })] })).length).toBeGreaterThan(0);
    expect((await validateBody({ computeSamples: [sample({ attempt: 'first' })] })).length).toBeGreaterThan(0);
  });
});
