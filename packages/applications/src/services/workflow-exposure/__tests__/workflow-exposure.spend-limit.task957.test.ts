/**
 * TASK-957 F-4 — the tenant spend ceiling (D12) at workflow-run start.
 *
 * `monthlyWorkflowInvocations` is a COUNT quota and it is gated here already, but only while
 * entitlement enforcement is on, and a run under the count is free however much it spends: a
 * single run can fan out to dozens of LLM steps. The spend ceiling is the other control — money
 * across every unit — and it reached consultation summaries only.
 *
 * The two gates are deliberately independent: the ceiling is checked whether or not entitlement
 * ENFORCEMENT is enabled, because a tenant that set a cap set it on purpose and the enforcement
 * kill-switch governs the allowance plane, not the tenant's own ceiling.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SpendLimitExceededException } from '@arcaai/exceptions';
import { WorkflowExposureService } from '../workflow-exposure.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockWorkflowDefinitionRepository = { findPublishedBySlug: vi.fn(), findActivePublishedByTenant: vi.fn() };
const mockHarnessGateway = { startWorkflowRun: vi.fn(), getWorkflowRun: vi.fn(), cancelWorkflowRun: vi.fn() };
const mockWorkflowRunService = { getRun: vi.fn(), recordRunStarted: vi.fn(), recordRunFinished: vi.fn() };
const mockConfigService = { getConfigValue: vi.fn((key: string) => (key === 'WORKFLOW_EXPOSURE_ENABLED' ? true : undefined)) };
const mockS3Service = { putFile: vi.fn().mockResolvedValue(undefined) };
const mockRedisCache = { get: vi.fn().mockResolvedValue(null), setex: vi.fn().mockResolvedValue(undefined) };
const mockEntitlements = { isEnforcementEnabled: vi.fn(() => false), assertMeterQuota: vi.fn() };
const mockBilling = { assertSpendLimit: vi.fn(async () => undefined) };

const COMPILED = {
  formatVersion: 1,
  stages: [{ stageIndex: 0, nodes: [{ nodeId: 'n1', type: 'noop', activity: 'interpreter.noop', config: {} }] }],
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
  compiledConfig: COMPILED,
});

const overLimit = () =>
  new SpendLimitExceededException('Tenant has reached its monthly spend limit for 2026-09.', {
    tenantId: 'tenant-1',
    period: '2026-09',
    spendLimitMicros: 1_000_000,
    overageSpendMicros: 1_200_000,
  });

function build(billing: unknown = mockBilling) {
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
    undefined, // consultationService
    undefined, // webhookSecretRepository
    undefined, // secretsService
    undefined, // tenantSettings
    undefined, // userIdentity
    billing as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfigService.getConfigValue.mockImplementation((key: string) => (key === 'WORKFLOW_EXPOSURE_ENABLED' ? true : undefined));
  mockRedisCache.get.mockResolvedValue(null);
  mockEntitlements.isEnforcementEnabled.mockReturnValue(false);
  mockWorkflowRunService.recordRunStarted.mockResolvedValue(undefined);
  mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(definition());
  mockHarnessGateway.startWorkflowRun.mockResolvedValue({
    runId: 'run-1',
    workflowId: 'workflow-interpreter-run-1',
    temporalRunId: 't-1',
    status: 'started',
  });
  mockBilling.assertSpendLimit.mockResolvedValue(undefined);
});

describe('TASK-957 F-4 — spend ceiling at run start', () => {
  it('checks the ceiling before the run row is written or the harness is dispatched', async () => {
    await build().invoke('discharge_summary', { input: {} }, {});

    expect(mockBilling.assertSpendLimit).toHaveBeenCalledWith('tenant-1');
    expect(mockBilling.assertSpendLimit.mock.invocationCallOrder[0]).toBeLessThan(
      mockWorkflowRunService.recordRunStarted.mock.invocationCallOrder[0],
    );
  });

  it('starts no run when the tenant is over its ceiling', async () => {
    mockBilling.assertSpendLimit.mockRejectedValue(overLimit());

    await expect(build().invoke('discharge_summary', { input: {} }, {})).rejects.toBeInstanceOf(SpendLimitExceededException);
    expect(mockWorkflowRunService.recordRunStarted).not.toHaveBeenCalled();
    expect(mockHarnessGateway.startWorkflowRun).not.toHaveBeenCalled();
  });

  it('checks it even while entitlement ENFORCEMENT is off — the ceiling is the tenant’s own', async () => {
    mockEntitlements.isEnforcementEnabled.mockReturnValue(false);

    await build().invoke('discharge_summary', { input: {} }, {});

    expect(mockEntitlements.assertMeterQuota).not.toHaveBeenCalled();
    expect(mockBilling.assertSpendLimit).toHaveBeenCalledWith('tenant-1');
  });

  it('runs normally with no billing service wired — absent is "not enforced"', async () => {
    await expect(build(undefined).invoke('discharge_summary', { input: {} }, {})).resolves.toBeDefined();
    expect(mockWorkflowRunService.recordRunStarted).toHaveBeenCalled();
  });
});
