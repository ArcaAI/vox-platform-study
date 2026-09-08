/**
 * lane A step 6 — idempotency that a retried webhook cannot defeat.
 *
 * Before this ticket the ONLY idempotency was a best-effort Redis response cache: on a cache
 * miss (eviction, a cold node, Redis down — all of which `tryReadIdempotencyCache` swallows by
 * design) the same `Idempotency-Key` produced a FRESH `runId`, a fresh workflow id, and a
 * second, separately-billed LLM run. The cache was the mechanism, and the mechanism was
 * allowed to fail open.
 *
 * It is now a fast path in front of two durable layers:
 *
 *   1. the run id is DERIVED from `(tenantId, slug, idempotencyKey)`, so a retry addresses the
 *      same durable read-model row and the same Temporal workflow id — no coordination needed;
 *   2. Temporal's own `USE_EXISTING` + `REJECT_DUPLICATE` policies (asserted on the harness side
 *      in `test_task850_run_subject.py`) refuse a second execution under that id.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { WorkflowExposureService } from '../workflow-exposure.service';
import { deterministicRunId } from '../deterministic-run-id';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockWorkflowDefinitionRepository = { findPublishedBySlug: vi.fn(), findActivePublishedByTenant: vi.fn() };
const mockHarnessGateway = { startWorkflowRun: vi.fn(), getWorkflowRun: vi.fn(), cancelWorkflowRun: vi.fn() };
const mockWorkflowRunService = { getRun: vi.fn(), recordRunStarted: vi.fn(), recordRunFinished: vi.fn() };
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
  mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(definition());
  mockHarnessGateway.startWorkflowRun.mockResolvedValue({ runId: 'x', workflowId: 'w', temporalRunId: 't', status: 'started' });
});

describe('deterministicRunId', () => {
  it('is a pure function of (tenantId, slug, idempotencyKey)', () => {
    expect(deterministicRunId('t', 's', 'k')).toBe(deterministicRunId('t', 's', 'k'));
  });

  it('separates tenants, slugs and keys — no cross-tenant collision', () => {
    const a = deterministicRunId('tenant-a', 'slug', 'key');
    expect(a).not.toBe(deterministicRunId('tenant-b', 'slug', 'key'));
    expect(a).not.toBe(deterministicRunId('tenant-a', 'other', 'key'));
    expect(a).not.toBe(deterministicRunId('tenant-a', 'slug', 'other'));
  });

  it('is a well-formed RFC 9562 v8 UUID', () => {
    expect(deterministicRunId('t', 's', 'k')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('is not length-extendable across the separator — ("ab","c") and ("a","bc") differ', () => {
    expect(deterministicRunId('ab', 'c', 'k')).not.toBe(deterministicRunId('a', 'bc', 'k'));
  });
});

describe('a retried Idempotency-Key JOINS rather than starting a second run', () => {
  it('derives the run id from the key, so the retry addresses the same workflow', async () => {
    const service = build();
    const expected = deterministicRunId('tenant-1', 'discharge_summary', 'webhook-42');

    const first = await service.invoke('discharge_summary', { input: {} }, { idempotencyKey: 'webhook-42' });

    expect(first.runId).toBe(expected);
    expect(mockHarnessGateway.startWorkflowRun.mock.calls[0][0].runId).toBe(expected);
  });

  it('joins the existing durable run WITHOUT a second dispatch, even on a Redis cache miss', async () => {
    const service = build();
    const runId = deterministicRunId('tenant-1', 'discharge_summary', 'webhook-42');

    // First delivery.
    const first = await service.invoke('discharge_summary', { input: {} }, { idempotencyKey: 'webhook-42' });
    expect(first.status).toBe('started');

    // The run row now exists; the Redis cache is still empty (it always is, in this fixture).
    mockWorkflowRunService.getRun.mockResolvedValue({ runId, workflowSlug: 'discharge_summary', sessionId: 's', workflowVersionNumber: 1 });

    const retry = await service.invoke('discharge_summary', { input: {} }, { idempotencyKey: 'webhook-42' });

    expect(retry.runId).toBe(runId);
    expect(retry.status).toBe('already_running');
    // The money assertion: ONE dispatch across both deliveries.
    expect(mockHarnessGateway.startWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it('reports already_running when the dispatcher itself says it joined', async () => {
    mockHarnessGateway.startWorkflowRun.mockResolvedValue({ runId: 'x', workflowId: 'w', temporalRunId: 't', status: 'already_running' });
    const service = build();

    const response = await service.invoke('discharge_summary', { input: {} }, { idempotencyKey: 'webhook-42' });
    expect(response.status).toBe('already_running');
  });

  it('starts independent runs when no Idempotency-Key is supplied', async () => {
    const service = build();

    const a = await service.invoke('discharge_summary', { input: {} }, {});
    const b = await service.invoke('discharge_summary', { input: {} }, {});

    expect(a.runId).not.toBe(b.runId);
    expect(mockHarnessGateway.startWorkflowRun).toHaveBeenCalledTimes(2);
  });
});
