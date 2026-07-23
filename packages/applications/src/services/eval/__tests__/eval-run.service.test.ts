/**
 * EvalRunService unit tests.
 *
 * EvalRunService is the gateway ORCHESTRATOR for an eval run: it loads a golden
 * set (404 if not the tenant's), decrypts its cases, calls the harness
 * `/eval/run` endpoint, persists the EvalRun + per-case EvalScores through
 * EvalService, and broadcasts a ResourceCreated sys-event. These tests mock the
 * repositories, EvalService, and HarnessGatewayService — no DB/network.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataNotFoundException } from '@arcaai/exceptions';
import { SysEventType } from '@arcaai/domains';
import { EvalRunService } from '../eval-run.service';

const SET_ID = 'set-1';
const TENANT = 'tenant-1';

function goldenSet(over: Record<string, unknown> = {}) {
  return { id: SET_ID, tenantId: TENANT, name: 'GI golden', pinnedVersion: 'v1', departmentId: null, ...over };
}
function goldenCase(id: string) {
  return { id, tenantId: TENANT, goldenSetId: SET_ID };
}

const mockGoldenSetRepository = { findAll: vi.fn() };
const mockGoldenCaseRepository = { findAll: vi.fn(), decryptFieldsFromEntity: vi.fn() };
const mockEvalService = { recordEvalRunWithScores: vi.fn(), recordEvalRun: vi.fn() };
const mockHarnessGateway = { runEval: vi.fn() };
const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockSecrets = {};

function harnessResult(over: Record<string, unknown> = {}) {
  return {
    golden_set_version: 'v1',
    judge_model: 'stub-judge',
    aggregates: { pdsqi_mean: 4.5 },
    thresholds: { pdsqi_mean: 4.0 },
    passed: true,
    failures: [],
    caseScores: [
      { caseId: 'c0', metric: 'pdsqi_mean', score: 4.5, maxScore: 5.0, judgeModel: 'stub-judge' },
    ],
    ...over,
  };
}

describe('EvalRunService', () => {
  let service: EvalRunService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) =>
      key === 'user' ? { id: 'admin-1' } : key === 'tenantId' ? TENANT : null,
    );
    mockGoldenSetRepository.findAll.mockResolvedValue([goldenSet()]);
    mockGoldenCaseRepository.findAll.mockResolvedValue([goldenCase('c0')]);
    mockGoldenCaseRepository.decryptFieldsFromEntity.mockResolvedValue({
      transcript: 'patient reports headache',
      referenceNote: 'S: headache. A/P: analgesia.',
    });
    mockEvalService.recordEvalRunWithScores.mockImplementation(async (run: Record<string, unknown>) => ({
      run: { id: 'run-1', ...run },
      scores: [],
    }));
    mockEvalService.recordEvalRun.mockImplementation(async (run: Record<string, unknown>) => ({ id: 'run-1', ...run }));

    service = new EvalRunService(
      mockEventEmitter as never,
      mockClsService as never,
      mockGoldenSetRepository as never,
      mockGoldenCaseRepository as never,
      mockEvalService as never,
      mockHarnessGateway as never,
      mockSecrets as never,
    );
  });

  it('runs, persists a passing EvalRun+scores, and broadcasts a sys-event', async () => {
    mockHarnessGateway.runEval.mockResolvedValue(harnessResult());

    const outcome = await service.runGoldenSet({
      goldenSetId: SET_ID,
      tenantId: TENANT,
      triggerType: 'MANUAL',
      promptTemplateId: 'tpl-1',
      promptVersionNumber: 3,
    });

    expect(outcome.passed).toBe(true);
    expect(outcome.failures).toEqual([]);
    expect(outcome.aggregates).toEqual({ pdsqi_mean: 4.5 });

    // Harness got the decrypted case mapped transcript→source_documents,
    // referenceNote→generated_note.
    const payload = mockHarnessGateway.runEval.mock.calls[0][0];
    expect(payload.goldenSet.cases[0]).toMatchObject({
      case_id: 'c0',
      source_documents: ['patient reports headache'],
      generated_note: 'S: headache. A/P: analgesia.',
    });

    // Persisted run carries provenance + triggerType + aggregate + COMPLETED status.
    const [runArg, scoresArg] = mockEvalService.recordEvalRunWithScores.mock.calls[0];
    expect(runArg).toMatchObject({
      tenantId: TENANT,
      goldenSetId: SET_ID,
      triggerType: 'MANUAL',
      promptTemplateId: 'tpl-1',
      promptVersionNumber: 3,
      judgeModel: 'stub-judge',
      status: 'COMPLETED',
    });
    expect(scoresArg[0]).toMatchObject({ goldenCaseId: 'c0', metric: 'pdsqi_mean', score: 4.5 });

    // Sys-event broadcast (ResourceCreated for the EvalRun).
    expect(mockEventEmitter.emit).toHaveBeenCalledWith(
      SysEventType.ResourceCreated,
      expect.objectContaining({ resourceId: 'run-1' }),
    );
  });

  it('flags a failing gate without throwing (run persisted, passed=false)', async () => {
    mockHarnessGateway.runEval.mockResolvedValue(
      harnessResult({ passed: false, failures: ['pdsqi_accurate=2.0000 < 4.0'] }),
    );

    const outcome = await service.runGoldenSet({ goldenSetId: SET_ID, tenantId: TENANT, triggerType: 'PROMOTION' });

    expect(outcome.passed).toBe(false);
    expect(outcome.failures).toContain('pdsqi_accurate=2.0000 < 4.0');
    const [runArg] = mockEvalService.recordEvalRunWithScores.mock.calls[0];
    expect(runArg.status).toBe('FAILED');
    expect(runArg.triggerType).toBe('PROMOTION');
  });

  it('404s when the golden set is not the tenant’s', async () => {
    mockGoldenSetRepository.findAll.mockResolvedValue([]);
    await expect(
      service.runGoldenSet({ goldenSetId: 'nope', tenantId: TENANT, triggerType: 'MANUAL' }),
    ).rejects.toBeInstanceOf(DataNotFoundException);
    expect(mockHarnessGateway.runEval).not.toHaveBeenCalled();
  });

  it('records a FAILED run (no scores) when the harness call throws', async () => {
    mockHarnessGateway.runEval.mockRejectedValue(new Error('harness down'));

    const outcome = await service.runGoldenSet({ goldenSetId: SET_ID, tenantId: TENANT, triggerType: 'PROMOTION' });

    expect(outcome.passed).toBe(false);
    expect(outcome.harnessError).toContain('harness down');
    // FAILED run persisted via the no-scores path, sys-event still broadcast.
    expect(mockEvalService.recordEvalRun).toHaveBeenCalledTimes(1);
    expect(mockEvalService.recordEvalRun.mock.calls[0][0]).toMatchObject({ status: 'FAILED', triggerType: 'PROMOTION' });
    expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.anything());
  });
});
