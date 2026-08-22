/**
 * WorkflowExposureService unit tests (TASK-722 Task 5).
 *
 * Mocks the repository, harness gateway, workflow-run read-model service, config service,
 * S3 (claim-check) service, Redis cache (idempotency), entitlements, EventEmitter2 and
 * ClsService. Asserts: tenantId is read EXCLUSIVELY from CLS (S-3); 404-over-403 for a
 * foreign-tenant/unpublished slug and for a foreign-tenant/mismatched-slug run; the
 * `WORKFLOW_EXPOSURE_ENABLED` kill-switch (R-1) hides the surface with a 404 when off;
 * `assertMeterQuota` runs before a run is started; a compiled config selecting a cloud provider
 * is allowed through (TASK-720 R-4, owner ruling 2026-08-20 — the former decision #6/R-8 gate is
 * removed, not defaulted on); the ownership-anchor `WorkflowRun` row is written BEFORE the
 * harness dispatcher is called; `Idempotency-Key` replay returns the prior response and
 * starts no second run; `broadcastSysEvent` fires on invoke/cancel.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { SysEventType } from '@arcaai/domains';
import { WorkflowExposureService } from '../workflow-exposure.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

const mockWorkflowDefinitionRepository = {
  findPublishedBySlug: vi.fn(),
  findActivePublishedByTenant: vi.fn(),
};

const mockHarnessGateway = {
  startWorkflowRun: vi.fn(),
  getWorkflowRun: vi.fn(),
  cancelWorkflowRun: vi.fn(),
};

const mockWorkflowRunService = {
  getRun: vi.fn(),
  recordRunStarted: vi.fn(),
  recordRunFinished: vi.fn(),
};

const mockConfigService = {
  getConfigValue: vi.fn((key: string) => {
    if (key === 'WORKFLOW_EXPOSURE_ENABLED') return true;
    return undefined;
  }),
};

const mockS3Service = { putFile: vi.fn().mockResolvedValue(undefined) };
const mockRedisCache = { get: vi.fn().mockResolvedValue(null), setex: vi.fn().mockResolvedValue(undefined) };
const mockEntitlements = { isEnforcementEnabled: vi.fn(() => false), assertMeterQuota: vi.fn() };

const VALID_COMPILED_CONFIG = {
  formatVersion: 1,
  stages: [{ stageIndex: 0, nodes: [{ nodeId: 'n1', type: 'noop', activity: 'interpreter.noop', config: {} }] }],
  gates: [],
};

const CLOUD_COMPILED_CONFIG = {
  formatVersion: 1,
  stages: [{ stageIndex: 0, nodes: [{ nodeId: 'n1', type: 'summarize', activity: 'interpreter.summarize', config: { provider: 'azure' } }] }],
  gates: [],
};

const createMockDefinition = (overrides: Record<string, unknown> = {}) => ({
  id: overrides.id ?? 'def-1',
  tenantId: overrides.tenantId ?? 'tenant-1',
  slug: overrides.slug ?? 'discharge_summary',
  name: overrides.name ?? 'Discharge Summary',
  description: overrides.description ?? null,
  paletteKey: overrides.paletteKey ?? 'summarization',
  versionNumber: overrides.versionNumber ?? 1,
  compiledConfig: overrides.compiledConfig ?? VALID_COMPILED_CONFIG,
});

const createMockRun = (overrides: Record<string, unknown> = {}) => ({
  runId: overrides.runId ?? 'run-1',
  tenantId: overrides.tenantId ?? 'tenant-1',
  workflowSlug: overrides.workflowSlug ?? 'discharge_summary',
  workflowVersionId: overrides.workflowVersionId ?? 'def-1',
  workflowVersionNumber: overrides.workflowVersionNumber ?? 1,
  sessionId: overrides.sessionId ?? 'workflow-interpreter-run-1',
  status: overrides.status ?? 'RUNNING',
});

function build(tenantId: string | null = 'tenant-1') {
  mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? tenantId : undefined));
  return new WorkflowExposureService(
    mockWorkflowDefinitionRepository as any,
    mockHarnessGateway as any,
    mockWorkflowRunService as any,
    mockConfigService as any,
    mockEventEmitter as any,
    mockClsService as any,
    mockS3Service as any,
    mockRedisCache as any,
    mockEntitlements as any,
  );
}

describe('WorkflowExposureService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfigService.getConfigValue.mockImplementation((key: string) => {
      if (key === 'WORKFLOW_EXPOSURE_ENABLED') return true;
      return undefined;
    });
    mockRedisCache.get.mockResolvedValue(null);
    mockEntitlements.isEnforcementEnabled.mockReturnValue(false);
    mockWorkflowRunService.recordRunStarted.mockResolvedValue(undefined);
    mockHarnessGateway.startWorkflowRun.mockResolvedValue({
      runId: 'run-1',
      workflowId: 'workflow-interpreter-run-1',
      temporalRunId: 't-1',
      status: 'started',
    });
  });

  describe('R-1 kill-switch', () => {
    it('throws NotFoundException (surface hidden) when WORKFLOW_EXPOSURE_ENABLED is not true', async () => {
      mockConfigService.getConfigValue.mockImplementation((key: string) => (key === 'WORKFLOW_EXPOSURE_ENABLED' ? false : undefined));
      const service = build();

      await expect(service.invoke('discharge_summary', { input: {} }, {})).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.list()).rejects.toBeInstanceOf(NotFoundException);
      expect(mockWorkflowDefinitionRepository.findPublishedBySlug).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('lists the tenant active published workflows via CLS tenantId only', async () => {
      mockWorkflowDefinitionRepository.findActivePublishedByTenant.mockResolvedValue([createMockDefinition()]);
      const service = build('tenant-1');

      const result = await service.list();

      expect(mockWorkflowDefinitionRepository.findActivePublishedByTenant).toHaveBeenCalledWith('tenant-1');
      expect(result.data).toEqual([
        { slug: 'discharge_summary', name: 'Discharge Summary', description: null, paletteKey: 'summarization', versionNumber: 1 },
      ]);
    });

    it('throws ArgumentInvalidException when CLS carries no tenantId', async () => {
      const service = build(null);
      await expect(service.list()).rejects.toBeInstanceOf(ArgumentInvalidException);
    });
  });

  describe('invoke', () => {
    it('404s a foreign-tenant / unpublished / unknown slug (404-over-403) without ever forwarding tenantId to the repository lookup args', async () => {
      mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(null);
      const service = build('tenant-1');

      await expect(service.invoke('nope', { input: {} }, {})).rejects.toBeInstanceOf(NotFoundException);
      // tenantId came from CLS, never from the invoke() arguments (the DTO has no tenantId field at all).
      expect(mockWorkflowDefinitionRepository.findPublishedBySlug).toHaveBeenCalledWith('tenant-1', 'nope');
    });

    it('runs assertMeterQuota before writing the run row or calling the harness dispatcher, when enforcement is on', async () => {
      mockEntitlements.isEnforcementEnabled.mockReturnValue(true);
      mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(createMockDefinition());
      const service = build('tenant-1');

      await service.invoke('discharge_summary', { input: {} }, {});

      expect(mockEntitlements.assertMeterQuota).toHaveBeenCalledWith('tenant-1', 'monthlyWorkflowInvocations');
      const quotaCallOrder = mockEntitlements.assertMeterQuota.mock.invocationCallOrder[0];
      const recordCallOrder = mockWorkflowRunService.recordRunStarted.mock.invocationCallOrder[0];
      expect(quotaCallOrder).toBeLessThan(recordCallOrder);
    });

    it('propagates a quota-exceeded rejection and starts no run', async () => {
      mockEntitlements.isEnforcementEnabled.mockReturnValue(true);
      mockEntitlements.assertMeterQuota.mockRejectedValue(new Error('quota exceeded'));
      mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(createMockDefinition());
      const service = build('tenant-1');

      await expect(service.invoke('discharge_summary', { input: {} }, {})).rejects.toThrow('quota exceeded');
      expect(mockWorkflowRunService.recordRunStarted).not.toHaveBeenCalled();
      expect(mockHarnessGateway.startWorkflowRun).not.toHaveBeenCalled();
    });

    it('allows a compiled config selecting a cloud provider (TASK-720 R-4: the tenant carries the risk, BYOK)', async () => {
      mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(createMockDefinition({ compiledConfig: CLOUD_COMPILED_CONFIG }));
      const service = build('tenant-1');

      await expect(service.invoke('discharge_summary', { input: {} }, {})).resolves.toBeDefined();
      expect(mockWorkflowRunService.recordRunStarted).toHaveBeenCalled();
      expect(mockHarnessGateway.startWorkflowRun).toHaveBeenCalled();
    });

    it('mints a claim-check ref via IS3Service.putFile, then writes the WorkflowRun row BEFORE calling the harness dispatcher', async () => {
      mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(createMockDefinition());
      const service = build('tenant-1');

      const result = await service.invoke('discharge_summary', { input: {} }, {});

      expect(mockS3Service.putFile).toHaveBeenCalledTimes(1);
      const [bucket, key, data, contentType] = mockS3Service.putFile.mock.calls[0];
      expect(bucket).toBe('harness-claim-check');
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(Buffer.isBuffer(data)).toBe(true);
      expect(contentType).toBe('text/plain; charset=utf-8');

      const recordOrder = mockWorkflowRunService.recordRunStarted.mock.invocationCallOrder[0];
      const startOrder = mockHarnessGateway.startWorkflowRun.mock.invocationCallOrder[0];
      expect(recordOrder).toBeLessThan(startOrder);

      const [startInput] = mockHarnessGateway.startWorkflowRun.mock.calls[0];
      expect(startInput.tenantId).toBe('tenant-1');
      expect(startInput.workflowVersionId).toBe('def-1');
      expect(startInput.configRef).toEqual({
        store: 's3',
        bucket: 'harness-claim-check',
        key,
        size: data.length,
        sha256: key,
        content_type: 'text/plain; charset=utf-8',
      });

      expect(result.status).toBe('started');
      expect(result.statusUrl).toBe(`/api/v1/workflows/discharge_summary/runs/${result.runId}`);
      expect(result.streamUrl).toBe(`/api/v1/workflows/discharge_summary/runs/${result.runId}/stream`);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceCreated,
        expect.objectContaining({
          resourceId: 'def-1',
          tenantId: 'tenant-1',
          data: expect.objectContaining({ action: 'invoke', runId: result.runId }),
        }),
      );
    });

    it('replays the cached response for a repeated Idempotency-Key and starts no second run', async () => {
      const cached = {
        runId: 'run-1',
        status: 'started',
        statusUrl: '/api/v1/workflows/discharge_summary/runs/run-1',
        streamUrl: '/api/v1/workflows/discharge_summary/runs/run-1/stream',
      };
      mockRedisCache.get.mockResolvedValue(JSON.stringify(cached));
      const service = build('tenant-1');

      const result = await service.invoke('discharge_summary', { input: {} }, { idempotencyKey: 'client-key-1' });

      expect(result).toEqual(cached);
      expect(mockWorkflowDefinitionRepository.findPublishedBySlug).not.toHaveBeenCalled();
      expect(mockHarnessGateway.startWorkflowRun).not.toHaveBeenCalled();
    });

    it('caches the response under the Idempotency-Key on a fresh invoke', async () => {
      mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(createMockDefinition());
      const service = build('tenant-1');

      await service.invoke('discharge_summary', { input: {} }, { idempotencyKey: 'client-key-2' });

      expect(mockRedisCache.setex).toHaveBeenCalledWith(
        'idempotency:workflow-invoke:tenant-1:discharge_summary:client-key-2',
        86_400,
        expect.any(String),
      );
    });

    it('records principalType=apiKey and the apiKeyId on the audit event when invoked by an API key', async () => {
      mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(createMockDefinition());
      const service = build('tenant-1');

      await service.invoke('discharge_summary', { input: {} }, { apiKeyId: 'key-1' });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceCreated,
        expect.objectContaining({ data: expect.objectContaining({ principalType: 'apiKey', apiKeyId: 'key-1' }) }),
      );
    });
  });

  describe('getRunStatus', () => {
    it('404s a foreign-tenant run id (delegated to IWorkflowRunService.getRun, which itself 404s)', async () => {
      mockWorkflowRunService.getRun.mockRejectedValue(new NotFoundException('not found'));
      const service = build('tenant-1');

      await expect(service.getRunStatus('discharge_summary', 'run-x')).rejects.toBeInstanceOf(NotFoundException);
    });

    it("404s when the run's slug does not match the URL's :slug", async () => {
      mockWorkflowRunService.getRun.mockResolvedValue(createMockRun({ workflowSlug: 'other_slug' }));
      const service = build('tenant-1');

      await expect(service.getRunStatus('discharge_summary', 'run-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockHarnessGateway.getWorkflowRun).not.toHaveBeenCalled();
    });

    it('returns the live upstream status merged with the run-model slug/version', async () => {
      mockWorkflowRunService.getRun.mockResolvedValue(createMockRun());
      mockHarnessGateway.getWorkflowRun.mockResolvedValue({
        runId: 'run-1',
        status: 'RUNNING',
        stages: [{ stageIndex: 0 }],
        startedAt: '2026-08-16T00:00:00Z',
        endedAt: null,
      });
      const service = build('tenant-1');

      const result = await service.getRunStatus('discharge_summary', 'run-1');

      expect(result).toEqual({
        runId: 'run-1',
        slug: 'discharge_summary',
        workflowVersionNumber: 1,
        status: 'RUNNING',
        stages: [{ stageIndex: 0 }],
        startedAt: '2026-08-16T00:00:00Z',
        endedAt: null,
        // TASK-790 (M-2): the delivered-output read-back. Null here because this run's
        // read-model fixture carries none — an in-flight run has delivered nothing.
        resultRef: null,
      });
      expect(mockWorkflowRunService.recordRunFinished).not.toHaveBeenCalled();
    });

    it('opportunistically syncs the read model on a terminal status', async () => {
      mockWorkflowRunService.getRun.mockResolvedValue(createMockRun());
      mockHarnessGateway.getWorkflowRun.mockResolvedValue({
        runId: 'run-1',
        status: 'COMPLETED',
        stages: [],
        startedAt: '2026-08-16T00:00:00Z',
        endedAt: '2026-08-16T00:05:00Z',
      });
      const service = build('tenant-1');

      await service.getRunStatus('discharge_summary', 'run-1');

      expect(mockWorkflowRunService.recordRunFinished).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-1', runId: 'run-1', sessionId: 'workflow-interpreter-run-1', status: 'COMPLETED' }),
      );
    });

    it('does not fail the status read when the opportunistic read-model sync throws', async () => {
      mockWorkflowRunService.getRun.mockResolvedValue(createMockRun());
      mockHarnessGateway.getWorkflowRun.mockResolvedValue({ runId: 'run-1', status: 'COMPLETED', stages: [], startedAt: null, endedAt: null });
      mockWorkflowRunService.recordRunFinished.mockRejectedValue(new Error('redis down'));
      const service = build('tenant-1');

      await expect(service.getRunStatus('discharge_summary', 'run-1')).resolves.toBeDefined();
    });
  });

  describe('cancelRun', () => {
    it('404s a foreign-tenant/mismatched-slug run before ever calling the harness dispatcher', async () => {
      mockWorkflowRunService.getRun.mockResolvedValue(createMockRun({ workflowSlug: 'other_slug' }));
      const service = build('tenant-1');

      await expect(service.cancelRun('discharge_summary', 'run-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockHarnessGateway.cancelWorkflowRun).not.toHaveBeenCalled();
    });

    it('sends the allow-listed cancel signal and broadcasts a sys-event', async () => {
      mockWorkflowRunService.getRun.mockResolvedValue(createMockRun());
      mockHarnessGateway.cancelWorkflowRun.mockResolvedValue({ runId: 'run-1', status: 'cancel_requested' });
      const service = build('tenant-1');

      const result = await service.cancelRun('discharge_summary', 'run-1');

      expect(result).toEqual({ runId: 'run-1', status: 'cancel_requested' });
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceUpdated,
        expect.objectContaining({ data: expect.objectContaining({ action: 'cancel', runId: 'run-1' }) }),
      );
    });
  });
});
