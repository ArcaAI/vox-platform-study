/**
 * TASK-1042 — the `invoke` call site of the run-audio binding (C2/C3/C7/C8).
 *
 * A standalone start whose `input` names an `sttSessionId` is bound BEFORE the run row and the
 * harness start; the run row records `sttSessionId` beside `startedBy`; the harness start carries
 * `liveAudio`; a failed start releases the binding. A consultation-bound start refuses the field
 * (400 `LIVE_AUDIO_UNSUPPORTED`). A start with no `sttSessionId` is untouched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { WorkflowExposureService } from '../workflow-exposure.service';
import { RunPrincipalAccessService } from '../../workflow-run/run-principal-access';

const TENANT = 'tenant-1';
const SLUG = 'dictate';

let store: Record<string, unknown> = {};
const cls = { get: vi.fn((key: string) => store[key]), set: vi.fn() };
const definitions = { findPublishedBySlug: vi.fn(), findActivePublishedByTenant: vi.fn() };
const harness = { startWorkflowRun: vi.fn(), getWorkflowRun: vi.fn(), cancelWorkflowRun: vi.fn() };
const runs = { getRun: vi.fn(), getRunForReader: vi.fn(), recordRunStarted: vi.fn(), recordRunFinished: vi.fn(), getRunRequestBodyHash: vi.fn() };
const config = { getConfigValue: vi.fn((key: string) => (key === 'WORKFLOW_EXPOSURE_ENABLED' ? true : undefined)) };
const s3 = { putFile: vi.fn().mockResolvedValue(undefined) };
const redis = { get: vi.fn().mockResolvedValue(null), setex: vi.fn().mockResolvedValue(undefined) };
const consultations = { getById: vi.fn() };
const release = vi.fn().mockResolvedValue(undefined);
const runAudio = { bind: vi.fn() };

const compiledConfig = {
  formatVersion: 1,
  stages: [{ stageIndex: 0, nodes: [{ nodeId: 'n0', type: 'core.agent', activity: 'interpreter.core_agent', config: {} }] }],
  gates: [],
};
const definition = () => ({
  id: 'def-1',
  tenantId: TENANT,
  slug: SLUG,
  name: 'Dictate',
  description: null,
  paletteKey: 'core',
  versionNumber: 7,
  compiledConfig,
  graph: { nodes: [] },
});

function build(options: { withRunAudio?: boolean } = {}) {
  const positional: unknown[] = [
    definitions,
    harness,
    runs,
    config,
    { emit: vi.fn() },
    cls,
    s3,
    redis,
    undefined /* entitlements */,
    consultations,
    undefined /* webhook secrets */,
    undefined /* secrets */,
    undefined /* tenant settings */,
    undefined /* user identity */,
    undefined /* billing */,
    undefined /* context schemas */,
    undefined /* effective trigger schema */,
    undefined /* blob storage */,
    new RunPrincipalAccessService(cls as never),
    options.withRunAudio === false ? undefined : runAudio,
  ];
  return new (WorkflowExposureService as unknown as new (...args: unknown[]) => WorkflowExposureService)(...positional);
}

const withAudio = { note: 'x', audio: { sttSessionId: 'stt-1' } };

beforeEach(() => {
  vi.clearAllMocks();
  store = { tenantId: TENANT, user: { id: 'human-1', tenantId: TENANT }, apiKey: { id: 'key-A', scopes: [] } };
  redis.get.mockResolvedValue(null);
  runs.recordRunStarted.mockResolvedValue(undefined);
  runs.getRun.mockRejectedValue(new NotFoundException('no run'));
  runs.getRunRequestBodyHash.mockResolvedValue(null);
  definitions.findPublishedBySlug.mockResolvedValue(definition());
  harness.startWorkflowRun.mockResolvedValue({ runId: 'x', workflowId: 'w', temporalRunId: 't', status: 'started' });
  runAudio.bind.mockResolvedValue({ liveAudio: { sttSessionId: 'stt-1', maxWaitSeconds: 1800 }, release });
  consultations.getById.mockResolvedValue({ id: 'c-1', patientId: 'p-1' });
});

describe('invoke — a run with no live audio is untouched', () => {
  it('binds nothing, sends no liveAudio and records no sttSessionId', async () => {
    await build().invoke(SLUG, { input: { note: 'x' } }, { apiKeyId: 'key-A' });
    expect(runAudio.bind).not.toHaveBeenCalled();
    expect(harness.startWorkflowRun.mock.calls[0][0]).not.toHaveProperty('liveAudio');
    expect(runs.recordRunStarted.mock.calls[0][0].metaData).not.toHaveProperty('sttSessionId');
  });
});

describe('invoke — a standalone run that names a live session', () => {
  it('binds before the run row and the harness start, then carries liveAudio (C7) and records sttSessionId (C8)', async () => {
    const response = await build().invoke(SLUG, { input: withAudio }, { apiKeyId: 'key-A' });
    expect(runAudio.bind).toHaveBeenCalledWith({
      tenantId: TENANT,
      runId: response.runId,
      workflow: { slug: SLUG, versionNumber: 7, compiledConfig, graph: { nodes: [] } },
      input: withAudio,
    });
    expect(runAudio.bind.mock.invocationCallOrder[0]).toBeLessThan(runs.recordRunStarted.mock.invocationCallOrder[0]);
    expect(harness.startWorkflowRun.mock.calls[0][0]).toMatchObject({
      liveAudio: { sttSessionId: 'stt-1', maxWaitSeconds: 1800 },
      payload: withAudio,
    });
    expect(runs.recordRunStarted.mock.calls[0][0].metaData).toMatchObject({ sttSessionId: 'stt-1', startedBy: { type: 'apiKey', id: 'key-A' } });
    expect(release).not.toHaveBeenCalled();
  });

  it('a binding refusal starts nothing', async () => {
    runAudio.bind.mockRejectedValue(new ConflictException({ code: 'RUN_AUDIO_SESSION_NOT_LIVE', message: 'ended' }));
    await expect(build().invoke(SLUG, { input: withAudio }, { apiKeyId: 'key-A' })).rejects.toBeInstanceOf(ConflictException);
    expect(runs.recordRunStarted).not.toHaveBeenCalled();
    expect(harness.startWorkflowRun).not.toHaveBeenCalled();
  });

  it('the harness start failing releases the binding and rethrows', async () => {
    harness.startWorkflowRun.mockRejectedValue(new Error('harness down'));
    await expect(build().invoke(SLUG, { input: withAudio }, { apiKeyId: 'key-A' })).rejects.toThrow('harness down');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('the run row write failing releases the binding too', async () => {
    runs.recordRunStarted.mockRejectedValue(new Error('db down'));
    await expect(build().invoke(SLUG, { input: withAudio }, { apiKeyId: 'key-A' })).rejects.toThrow('db down');
    expect(release).toHaveBeenCalledTimes(1);
    expect(harness.startWorkflowRun).not.toHaveBeenCalled();
  });

  it('an idempotent retry that JOINS the existing run never binds again', async () => {
    runs.getRun.mockResolvedValue({ runId: 'r', workflowSlug: SLUG });
    const response = await build().invoke(SLUG, { input: withAudio }, { apiKeyId: 'key-A', idempotencyKey: 'k-1' });
    expect(response.status).toBe('already_running');
    expect(runAudio.bind).not.toHaveBeenCalled();
  });

  it('without the binding service a live-audio start is refused, never started unchecked', async () => {
    await expect(build({ withRunAudio: false }).invoke(SLUG, { input: withAudio }, { apiKeyId: 'key-A' })).rejects.toMatchObject({ status: 503 });
    expect(harness.startWorkflowRun).not.toHaveBeenCalled();
  });
});

describe('invoke — the consultation-bound route refuses sttSessionId', () => {
  it('400 LIVE_AUDIO_UNSUPPORTED, before anything is written', async () => {
    const error = await build()
      .invoke(SLUG, { input: withAudio }, { apiKeyId: 'key-A', consultationId: 'c-1' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'LIVE_AUDIO_UNSUPPORTED' });
    expect(runAudio.bind).not.toHaveBeenCalled();
    expect(runs.recordRunStarted).not.toHaveBeenCalled();
  });

  it('a consultation-bound run without sttSessionId is unaffected', async () => {
    await build().invoke(SLUG, { input: { note: 'x' } }, { apiKeyId: 'key-A', consultationId: 'c-1' });
    expect(harness.startWorkflowRun).toHaveBeenCalledTimes(1);
    expect(runAudio.bind).not.toHaveBeenCalled();
  });
});
