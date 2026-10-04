/**
 * TASK-1038 E2 (fix 11) — ONE idempotency semantic across run starts.
 *
 * Agent runs already answered a key reused with a DIFFERENT body with 409
 * `IDEMPOTENCY_KEY_REUSED`; a workflow run silently JOINED the first request's run instead, so a
 * caller that reused a key for a second intent got the first intent's result. Now a workflow
 * start fingerprints its body (`input` + the server-resolved consultation) and stores the
 * fingerprint with BOTH idempotency records — the Redis fast path and the durable run row
 * (`_metadata.requestBodyHash`). Same key + same body joins; a different body is 409
 * `IDEMPOTENCY_KEY_REUSED`, and no 409 body names the other request's `runId`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { WorkflowExposureService } from '../workflow-exposure.service';
import { deterministicRunId } from '../deterministic-run-id';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockWorkflowDefinitionRepository = { findPublishedBySlug: vi.fn(), findActivePublishedByTenant: vi.fn() };
const mockHarnessGateway = { startWorkflowRun: vi.fn(), getWorkflowRun: vi.fn(), cancelWorkflowRun: vi.fn() };
const mockWorkflowRunService = { getRun: vi.fn(), recordRunStarted: vi.fn(), recordRunFinished: vi.fn(), getRunRequestBodyHash: vi.fn() };
const mockConfigService = { getConfigValue: vi.fn((key: string) => (key === 'WORKFLOW_EXPOSURE_ENABLED' ? true : undefined)) };
const mockS3Service = { putFile: vi.fn().mockResolvedValue(undefined) };
/** Deliberately a MISSING cache on every read — the point is that idempotency survives it. */
const mockRedisCache = { get: vi.fn().mockResolvedValue(null), setex: vi.fn().mockResolvedValue(undefined) };
const mockEntitlements = { isEnforcementEnabled: vi.fn(() => false), assertMeterQuota: vi.fn() };
const mockConsultationService = { getById: vi.fn() };

const SUMMARIZATION_CONFIG = {
  formatVersion: 1,
  stages: [{ stageIndex: 0, nodes: [{ nodeId: 'n0', type: 'core.agent', activity: 'interpreter.core_agent', config: {} }] }],
  gates: [],
};

const definition = () => ({
  id: 'def-1',
  tenantId: 'tenant-1',
  slug: 'discharge_summary',
  name: 'Discharge Summary',
  description: null,
  paletteKey: 'core',
  versionNumber: 1,
  compiledConfig: SUMMARIZATION_CONFIG,
});

function build() {
  mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? 'tenant-1' : undefined));
  return new WorkflowExposureService(
    mockWorkflowDefinitionRepository as never,
    mockHarnessGateway as never,
    mockWorkflowRunService as never,
    mockConfigService as never,
    mockEventEmitter as never,
    mockClsService as never,
    mockS3Service as never,
    mockRedisCache as never,
    mockEntitlements as never,
    mockConsultationService as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfigService.getConfigValue.mockImplementation((key: string) => (key === 'WORKFLOW_EXPOSURE_ENABLED' ? true : undefined));
  mockRedisCache.get.mockResolvedValue(null);
  mockEntitlements.isEnforcementEnabled.mockReturnValue(false);
  mockWorkflowRunService.recordRunStarted.mockResolvedValue(undefined);
  mockWorkflowRunService.getRun.mockRejectedValue(new NotFoundException('no run'));
  mockWorkflowRunService.getRunRequestBodyHash.mockResolvedValue(null);
  mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(definition());
  mockHarnessGateway.startWorkflowRun.mockResolvedValue({ runId: 'x', workflowId: 'w', temporalRunId: 't', status: 'started' });
});

const RUN = deterministicRunId('tenant-1', 'discharge_summary', 'k-1');

function startedMetaData(): Record<string, unknown> | undefined {
  return (mockWorkflowRunService.recordRunStarted.mock.calls[0]?.[0] as { metaData?: Record<string, unknown> }).metaData;
}

describe('workflow run idempotency — the body fingerprint', () => {
  it('stamps the body fingerprint on the run row and in the Redis record', async () => {
    await build().invoke('discharge_summary', { input: { text: 'a' } }, { idempotencyKey: 'k-1' });
    const hash = startedMetaData()?.requestBodyHash;
    expect(typeof hash).toBe('string');
    const [, , cached] = mockRedisCache.setex.mock.calls[0] as [string, number, string];
    expect(JSON.parse(cached).requestBodyHash).toBe(hash);
  });

  it('no key ⇒ no fingerprint on the row', async () => {
    await build().invoke('discharge_summary', { input: { text: 'a' } }, {});
    expect(startedMetaData()?.requestBodyHash).toBeUndefined();
  });

  it('same key + same body (key order irrelevant) joins the durable run', async () => {
    await build().invoke('discharge_summary', { input: { a: 1, b: 2 } }, { idempotencyKey: 'k-1' });
    const hash = startedMetaData()?.requestBodyHash;
    mockWorkflowRunService.getRun.mockResolvedValue({ runId: RUN, workflowSlug: 'discharge_summary' });
    mockWorkflowRunService.getRunRequestBodyHash.mockResolvedValue(hash);
    const retry = await build().invoke('discharge_summary', { input: { b: 2, a: 1 } }, { idempotencyKey: 'k-1' });
    expect(retry).toMatchObject({ runId: RUN, status: 'already_running' });
    expect(mockHarnessGateway.startWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it('same key + a DIFFERENT body is 409 IDEMPOTENCY_KEY_REUSED (durable layer), with no runId in the body', async () => {
    await build().invoke('discharge_summary', { input: { text: 'a' } }, { idempotencyKey: 'k-1' });
    const hash = startedMetaData()?.requestBodyHash;
    mockWorkflowRunService.getRun.mockResolvedValue({ runId: RUN, workflowSlug: 'discharge_summary' });
    mockWorkflowRunService.getRunRequestBodyHash.mockResolvedValue(hash);

    const refusal = await build()
      .invoke('discharge_summary', { input: { text: 'b' } }, { idempotencyKey: 'k-1' })
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ConflictException);
    const response = (refusal as ConflictException).getResponse() as Record<string, unknown>;
    expect(response.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(JSON.stringify(response)).not.toContain(RUN);
    expect(mockHarnessGateway.startWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it('same key + a DIFFERENT body is 409 on the Redis fast path too', async () => {
    await build().invoke('discharge_summary', { input: { text: 'a' } }, { idempotencyKey: 'k-1' });
    const [, , cached] = mockRedisCache.setex.mock.calls[0] as [string, number, string];
    mockRedisCache.get.mockResolvedValue(cached);
    await expect(build().invoke('discharge_summary', { input: { text: 'b' } }, { idempotencyKey: 'k-1' })).rejects.toBeInstanceOf(ConflictException);
    // and the same body replays the cached answer, without the internal fingerprint
    const replay = await build().invoke('discharge_summary', { input: { text: 'a' } }, { idempotencyKey: 'k-1' });
    expect(replay.runId).toBe(RUN);
    expect(replay).not.toHaveProperty('requestBodyHash');
  });

  it('a row started before fingerprints existed (no hash) still joins', async () => {
    mockWorkflowRunService.getRun.mockResolvedValue({ runId: RUN, workflowSlug: 'discharge_summary' });
    mockWorkflowRunService.getRunRequestBodyHash.mockResolvedValue(null);
    const retry = await build().invoke('discharge_summary', { input: { text: 'anything' } }, { idempotencyKey: 'k-1' });
    expect(retry.status).toBe('already_running');
  });
});
