/**
 * WorkflowSandboxRunService unit tests (TASK-721 Phase C).
 *
 * Mocks `IWorkflowDefinitionService` (fresh compile), `WorkflowTestFixtureRepository`, the
 * harness gateway, `IWorkflowRunService`, S3 (claim-check), EventEmitter2 and ClsService.
 * Asserts: tenantId is read EXCLUSIVELY from CLS; `sandbox: true` and `isSandbox: true` are
 * ALWAYS set (never caller-controlled); explicit `input` wins over `fixtureId`; a foreign-
 * tenant fixture or definition -> `NotFoundException`; the ownership-anchor row is written
 * BEFORE the harness dispatcher is called; a run not started against the given definitionId
 * -> `NotFoundException`; `broadcastSysEvent` fires on start/cancel.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { SysEventType } from '@arcaai/domains';
import { WorkflowSandboxRunService } from '../workflow-sandbox-run.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

const mockWorkflowDefinitionService = {
  getCompiledConfigForSandboxRun: vi.fn(),
};

const mockWorkflowTestFixtureRepository = {
  findById: vi.fn(),
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

const mockS3Service = { putFile: vi.fn().mockResolvedValue(undefined) };

const VALID_COMPILED_CONFIG = {
  formatVersion: 1,
  stages: [{ stageIndex: 0, nodes: [{ nodeId: 'n1', type: 'noop', activity: 'interpreter.noop', config: {} }] }],
  gates: [],
};

const createCompileResult = (overrides: Record<string, unknown> = {}) => ({
  compiledConfig: overrides.compiledConfig ?? VALID_COMPILED_CONFIG,
  workflowVersionId: overrides.workflowVersionId ?? 'def-1',
  workflowSlug: overrides.workflowSlug ?? 'discharge_summary',
  workflowVersionNumber: overrides.workflowVersionNumber ?? 1,
  definitionName: overrides.definitionName ?? 'Discharge Summary',
});

const createMockFixture = (overrides: Record<string, unknown> = {}) => ({
  id: overrides.id ?? 'fixture-1',
  tenantId: overrides.tenantId ?? 'tenant-1',
  input: overrides.input ?? { transcript: 'synthetic sample only' },
});

const createMockRun = (overrides: Record<string, unknown> = {}) => ({
  runId: overrides.runId ?? 'run-1',
  tenantId: overrides.tenantId ?? 'tenant-1',
  workflowVersionId: overrides.workflowVersionId ?? 'def-1',
  sessionId: overrides.sessionId ?? 'workflow-interpreter-run-1',
  status: overrides.status ?? 'RUNNING',
});

function build(tenantId: string | null = 'tenant-1') {
  mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? tenantId : undefined));
  return new WorkflowSandboxRunService(
    mockWorkflowDefinitionService as any,
    mockWorkflowTestFixtureRepository as any,
    mockHarnessGateway as any,
    mockWorkflowRunService as any,
    mockEventEmitter as any,
    mockClsService as any,
    mockS3Service as any,
  );
}

describe('WorkflowSandboxRunService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkflowDefinitionService.getCompiledConfigForSandboxRun.mockResolvedValue(createCompileResult());
    mockWorkflowRunService.recordRunStarted.mockResolvedValue(undefined);
    mockHarnessGateway.startWorkflowRun.mockResolvedValue({
      runId: 'run-1',
      workflowId: 'workflow-interpreter-run-1',
      temporalRunId: 't-1',
      status: 'started',
    });
  });

  describe('startRun', () => {
    it('throws ArgumentInvalidException when no tenant is in CLS', async () => {
      const service = build(null);
      await expect(service.startRun('def-1', {})).rejects.toBeInstanceOf(ArgumentInvalidException);
    });

    it('always starts with sandbox: true and records isSandbox: true, regardless of the request body', async () => {
      const service = build();

      await service.startRun('def-1', {});

      expect(mockHarnessGateway.startWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ sandbox: true }));
      expect(mockWorkflowRunService.recordRunStarted).toHaveBeenCalledWith(expect.objectContaining({ isSandbox: true, trigger: 'workbench sandbox' }));
    });

    it('writes the ownership-anchor run row BEFORE calling the harness dispatcher', async () => {
      const service = build();
      const callOrder: string[] = [];
      mockWorkflowRunService.recordRunStarted.mockImplementation(async () => {
        callOrder.push('recordRunStarted');
      });
      mockHarnessGateway.startWorkflowRun.mockImplementation(async () => {
        callOrder.push('startWorkflowRun');
        return { runId: 'run-1', workflowId: 'wf-1', temporalRunId: 't-1', status: 'started' };
      });

      await service.startRun('def-1', {});

      expect(callOrder).toEqual(['recordRunStarted', 'startWorkflowRun']);
    });

    it('defaults the payload to {} when neither input nor fixtureId is supplied', async () => {
      const service = build();

      await service.startRun('def-1', {});

      expect(mockHarnessGateway.startWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ payload: {} }));
      expect(mockWorkflowTestFixtureRepository.findById).not.toHaveBeenCalled();
    });

    it('uses the named fixture’s input as the payload', async () => {
      const service = build();
      mockWorkflowTestFixtureRepository.findById.mockResolvedValue(createMockFixture());

      await service.startRun('def-1', { fixtureId: 'fixture-1' });

      expect(mockWorkflowTestFixtureRepository.findById).toHaveBeenCalledWith('fixture-1');
      expect(mockHarnessGateway.startWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ payload: { transcript: 'synthetic sample only' } }));
    });

    it('an explicit inline input wins over fixtureId', async () => {
      const service = build();
      mockWorkflowTestFixtureRepository.findById.mockResolvedValue(createMockFixture());

      await service.startRun('def-1', { fixtureId: 'fixture-1', input: { transcript: 'inline wins' } });

      expect(mockWorkflowTestFixtureRepository.findById).not.toHaveBeenCalled();
      expect(mockHarnessGateway.startWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ payload: { transcript: 'inline wins' } }));
    });

    it('throws NotFoundException on a foreign-tenant fixtureId (404-over-403)', async () => {
      const service = build();
      mockWorkflowTestFixtureRepository.findById.mockResolvedValue(createMockFixture({ tenantId: 'tenant-OTHER' }));

      await expect(service.startRun('def-1', { fixtureId: 'fixture-1' })).rejects.toBeInstanceOf(NotFoundException);
      expect(mockHarnessGateway.startWorkflowRun).not.toHaveBeenCalled();
    });

    it('propagates a 400 from an uncompilable graph without starting a run', async () => {
      const service = build();
      mockWorkflowDefinitionService.getCompiledConfigForSandboxRun.mockRejectedValue(new BadRequestException('bad graph'));

      await expect(service.startRun('def-1', {})).rejects.toBeInstanceOf(BadRequestException);
      expect(mockWorkflowRunService.recordRunStarted).not.toHaveBeenCalled();
      expect(mockHarnessGateway.startWorkflowRun).not.toHaveBeenCalled();
    });

    it('broadcasts ResourceCreated on a successful start', async () => {
      const service = build();
      mockWorkflowTestFixtureRepository.findById.mockResolvedValue(createMockFixture({ id: 'fixture-2' }));

      await service.startRun('def-1', { fixtureId: 'fixture-2' });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceCreated,
        expect.objectContaining({ resourceId: 'def-1', data: expect.objectContaining({ action: 'sandboxRun', runId: expect.any(String), fixtureId: 'fixture-2' }) }),
      );
    });
  });

  describe('getRunStatus', () => {
    it('returns the live upstream status keyed by definitionId', async () => {
      const service = build();
      mockWorkflowRunService.getRun.mockResolvedValue(createMockRun());
      mockHarnessGateway.getWorkflowRun.mockResolvedValue({ runId: 'run-1', status: 'RUNNING', stages: [], startedAt: '2026-08-16T00:00:00Z', endedAt: null });

      const result = await service.getRunStatus('def-1', 'run-1');

      expect(result.workflowDefinitionId).toBe('def-1');
      expect(result.status).toBe('RUNNING');
    });

    it('throws NotFoundException when the run does not belong to the given definitionId', async () => {
      const service = build();
      mockWorkflowRunService.getRun.mockResolvedValue(createMockRun({ workflowVersionId: 'def-OTHER' }));

      await expect(service.getRunStatus('def-1', 'run-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockHarnessGateway.getWorkflowRun).not.toHaveBeenCalled();
    });

    it('propagates a foreign-tenant/unknown runId as NotFoundException (404-over-403)', async () => {
      const service = build();
      mockWorkflowRunService.getRun.mockRejectedValue(new NotFoundException('Run not found'));

      await expect(service.getRunStatus('def-1', 'run-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('syncs the read model to terminal but still returns status on a sync failure', async () => {
      const service = build();
      mockWorkflowRunService.getRun.mockResolvedValue(createMockRun());
      mockHarnessGateway.getWorkflowRun.mockResolvedValue({ runId: 'run-1', status: 'COMPLETED', stages: [], startedAt: '2026-08-16T00:00:00Z', endedAt: '2026-08-16T00:01:00Z' });
      mockWorkflowRunService.recordRunFinished.mockRejectedValue(new Error('db down'));

      const result = await service.getRunStatus('def-1', 'run-1');

      expect(mockWorkflowRunService.recordRunFinished).toHaveBeenCalled();
      expect(result.status).toBe('COMPLETED');
    });
  });

  describe('cancelRun', () => {
    it('sends the allow-listed cancel signal and broadcasts ResourceUpdated', async () => {
      const service = build();
      mockWorkflowRunService.getRun.mockResolvedValue(createMockRun());
      mockHarnessGateway.cancelWorkflowRun.mockResolvedValue({ runId: 'run-1', status: 'cancel_requested' });

      const result = await service.cancelRun('def-1', 'run-1');

      expect(mockHarnessGateway.cancelWorkflowRun).toHaveBeenCalledWith('run-1');
      expect(result.status).toBe('cancel_requested');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.objectContaining({ resourceId: 'def-1' }));
    });

    it('throws NotFoundException when the run does not belong to the given definitionId', async () => {
      const service = build();
      mockWorkflowRunService.getRun.mockResolvedValue(createMockRun({ workflowVersionId: 'def-OTHER' }));

      await expect(service.cancelRun('def-1', 'run-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockHarnessGateway.cancelWorkflowRun).not.toHaveBeenCalled();
    });
  });
});
