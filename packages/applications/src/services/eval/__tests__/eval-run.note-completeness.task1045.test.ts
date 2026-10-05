/**
 * EvalRunService — mode `note_completeness` (multi-encounter golden set).
 *
 * A golden set whose cases carry the `multi_encounter_v1` envelope is run in this mode: each case's
 * envelope is composed into a NotePlan by the real composer (`composeFromSnapshot`), and the plans,
 * the golden references and the registry thresholds go to the harness eval endpoint. The fixture is
 * the committed synthetic set under apps/harness. Repositories, settings and the harness are mocked.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import {
  AGENTIC_EVAL_NOTE_COMPLETENESS_DEFAULTS,
  AGENTIC_EVAL_NOTE_DOSE_ACCURACY_MIN_KEY,
  AGENTIC_EVAL_NOTE_LATENCY_P95_MAX_MS_KEY,
  AGENTIC_EVAL_NOTE_RECALL_MIN_KEY,
  AGENTIC_EVAL_NOTE_UNSUPPORTED_RATE_MAX_KEY,
  AGENTIC_EVAL_SETTINGS,
} from '../../settings-registry/descriptors/agentic-eval.descriptors';
import { EvalRunService } from '../eval-run.service';

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../../apps/harness/src/harness/eval/golden/fixtures/multi_encounter_v1.json',
);

interface FixtureCase {
  caseId: string;
  expectedStrategy: string;
  transcript: Record<string, unknown>;
  reference: Record<string, unknown>;
}
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { version: string; name: string; cases: FixtureCase[] };

const SET_ID = 'set-mec';
const TENANT = 'tenant-1';

const mockGoldenSetRepository = { findAll: vi.fn() };
const mockGoldenCaseRepository = { findAll: vi.fn(), decryptFieldsFromEntity: vi.fn() };
const mockEvalService = { recordEvalRunWithScores: vi.fn(), recordEvalRun: vi.fn() };
const mockHarnessGateway = { runEval: vi.fn() };
const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockSecrets = {};
const mockEffectiveSettings = { resolveEffective: vi.fn() };

const SETTINGS: Record<string, unknown> = {
  [AGENTIC_EVAL_NOTE_RECALL_MIN_KEY]: 1,
  [AGENTIC_EVAL_NOTE_DOSE_ACCURACY_MIN_KEY]: 0.98,
  [AGENTIC_EVAL_NOTE_UNSUPPORTED_RATE_MAX_KEY]: 0.03,
  [AGENTIC_EVAL_NOTE_LATENCY_P95_MAX_MS_KEY]: 90000,
};

function useCases(cases: FixtureCase[]) {
  mockGoldenCaseRepository.findAll.mockResolvedValue(cases.map((c) => ({ id: `gc-${c.caseId}`, tenantId: TENANT, goldenSetId: SET_ID })));
  mockGoldenCaseRepository.decryptFieldsFromEntity.mockImplementation(async (entity: { id: string }) => {
    const c = cases.find((x) => `gc-${x.caseId}` === entity.id)!;
    return { transcript: JSON.stringify(c.transcript), referenceNote: JSON.stringify(c.reference) };
  });
}

function harnessResult(over: Record<string, unknown> = {}) {
  return {
    mode: 'note_completeness',
    golden_set_version: 'v1',
    judge_model: 'note-completeness',
    aggregates: { critical_fact_recall: 1, dose_accuracy: 1, unsupported_rate: 0, stop_to_note_p95_ms: 4000 },
    thresholds: { critical_fact_recall: 1, dose_accuracy: 0.98, unsupported_rate: 0.03, stop_to_note_p95_ms: 90000 },
    passed: true,
    failures: [],
    caseScores: [
      { caseId: 'gc-me01-chest-tightness-metformin', metric: 'critical_fact_recall', score: 1, maxScore: 1, judgeModel: 'note-completeness' },
    ],
    ...over,
  };
}

describe('EvalRunService — note_completeness mode', () => {
  let service: EvalRunService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => (key === 'user' ? { id: 'admin-1' } : key === 'tenantId' ? TENANT : null));
    mockGoldenSetRepository.findAll.mockResolvedValue([{ id: SET_ID, tenantId: TENANT, name: FIXTURE.name, pinnedVersion: FIXTURE.version }]);
    mockEffectiveSettings.resolveEffective.mockImplementation(async (key: string) =>
      key in SETTINGS ? { value: SETTINGS[key], sourceScope: 'system' } : { value: undefined, sourceScope: 'code-default' },
    );
    mockEvalService.recordEvalRunWithScores.mockImplementation(async (run: Record<string, unknown>) => ({
      run: { id: 'run-1', ...run },
      scores: [],
    }));
    mockEvalService.recordEvalRun.mockImplementation(async (run: Record<string, unknown>) => ({ id: 'run-1', ...run }));
    mockHarnessGateway.runEval.mockResolvedValue(harnessResult());

    service = new EvalRunService(
      mockEventEmitter as never,
      mockClsService as never,
      mockGoldenSetRepository as never,
      mockGoldenCaseRepository as never,
      mockEvalService as never,
      mockHarnessGateway as never,
      mockSecrets as never,
      mockEffectiveSettings as never,
    );
  });

  it('declares the four thresholds as platform global-kv descriptors, open to their defaults', () => {
    const keys = [
      AGENTIC_EVAL_NOTE_RECALL_MIN_KEY,
      AGENTIC_EVAL_NOTE_DOSE_ACCURACY_MIN_KEY,
      AGENTIC_EVAL_NOTE_UNSUPPORTED_RATE_MAX_KEY,
      AGENTIC_EVAL_NOTE_LATENCY_P95_MAX_MS_KEY,
    ];
    for (const key of keys) {
      const d = AGENTIC_EVAL_SETTINGS.find((s) => s.key === key);
      expect(d, key).toBeDefined();
      expect(d).toMatchObject({ tier: 'global-kv', maxScope: 'system', globalOnly: true, failMode: 'open-to-default', dataType: 'number' });
      expect(d!.validate?.(-1)).toBeTruthy();
    }
    expect(AGENTIC_EVAL_NOTE_COMPLETENESS_DEFAULTS).toEqual({
      criticalFactRecallMin: 1,
      doseAccuracyMin: 1,
      unsupportedRateMax: 0.02,
      latencyP95MaxMs: 0,
    });
  });

  it('runs a multi_encounter_v1 set in mode note_completeness with composed plans and registry thresholds', async () => {
    useCases(FIXTURE.cases);

    const outcome = await service.runGoldenSet({ goldenSetId: SET_ID, tenantId: TENANT, triggerType: 'PROMOTION', promptTemplateId: 'tpl-1' });

    expect(outcome.passed).toBe(true);
    const payload = mockHarnessGateway.runEval.mock.calls[0][0];
    expect(payload.mode).toBe('note_completeness');
    expect(payload.goldenSet).toBeUndefined();
    expect(payload.promptTemplateId).toBe('tpl-1');
    expect(payload.noteCompleteness).toMatchObject({
      version: FIXTURE.version,
      name: FIXTURE.name,
      tenantId: TENANT,
      temperature: 0,
      thresholds: { criticalFactRecallMin: 1, doseAccuracyMin: 0.98, unsupportedRateMax: 0.03, latencyP95MaxMs: 90000 },
    });
    const sent = payload.noteCompleteness.cases as Array<{ caseId: string; reference: unknown; plan: Record<string, any>; output?: unknown }>;
    expect(sent).toHaveLength(FIXTURE.cases.length);
    for (const [index, c] of FIXTURE.cases.entries()) {
      expect(sent[index].caseId).toBe(`gc-${c.caseId}`);
      expect(sent[index].reference).toEqual(c.reference);
      expect(sent[index].output).toBeUndefined();
      const plan = sent[index].plan;
      expect(plan.schema).toBe('hope.note_plan.v1');
      expect(plan.tenantId).toBe(TENANT);
      expect(plan.model.contextWindow).toBe(32768);
      // The real composer chose the strategy the case was authored to force.
      expect(plan.budget.strategy, c.caseId).toBe(c.expectedStrategy);
      // Every coverage label resolves to a source of the plan (S/R/A labels as the golden facts cite them).
      expect(plan.coverage.criticalFacts, c.caseId).not.toBeNull();
      for (const fact of (c.reference as { criticalFacts: Array<{ citations: string[] }> }).criticalFacts) {
        for (const label of fact.citations) expect(plan.coverage.sourceIds[label], `${c.caseId} ${label}`).toBeDefined();
      }
    }
    const reduced = sent.find((s) => s.caseId === 'gc-me09-copd-long-codeine-allergy')!.plan;
    expect(reduced.budget.reductions).toEqual([expect.objectContaining({ kind: 'prior_encounter_to_ledger', encounterSeq: 1 })]);
    expect(reduced.blocks.map((b: { key: string }) => b.key)).toEqual(['encounter_1', 'ledger_1', 'results', 'encounter_2']);
    const grouped = sent.find((s) => s.caseId === 'gc-me11-pneumonia-long-template')!.plan;
    expect(grouped.calls.length).toBeGreaterThan(1);

    const [runArg, scoresArg] = mockEvalService.recordEvalRunWithScores.mock.calls[0];
    expect(runArg).toMatchObject({ status: 'COMPLETED', judgeModel: 'note-completeness', triggerType: 'PROMOTION' });
    expect(scoresArg[0]).toMatchObject({ goldenCaseId: 'gc-me01-chest-tightness-metformin', metric: 'critical_fact_recall', score: 1 });
  });

  it('falls back to the descriptor defaults when a threshold is unset', async () => {
    useCases(FIXTURE.cases.slice(0, 1));
    mockEffectiveSettings.resolveEffective.mockResolvedValue({ value: undefined, sourceScope: 'code-default' });

    await service.runGoldenSet({ goldenSetId: SET_ID, tenantId: TENANT, triggerType: 'MANUAL' });

    expect(mockHarnessGateway.runEval.mock.calls[0][0].noteCompleteness.thresholds).toEqual(AGENTIC_EVAL_NOTE_COMPLETENESS_DEFAULTS);
  });

  it('records a failing gate as a FAILED run without throwing', async () => {
    useCases(FIXTURE.cases.slice(0, 2));
    mockHarnessGateway.runEval.mockResolvedValue(harnessResult({ passed: false, failures: ['critical_fact_recall 0.9000 < 1.0000'] }));

    const outcome = await service.runGoldenSet({ goldenSetId: SET_ID, tenantId: TENANT, triggerType: 'PROMOTION' });

    expect(outcome.passed).toBe(false);
    expect(outcome.failures).toEqual(['critical_fact_recall 0.9000 < 1.0000']);
    expect(mockEvalService.recordEvalRunWithScores.mock.calls[0][0].status).toBe('FAILED');
  });

  it('refuses a set that mixes multi-encounter and plain cases', async () => {
    const [first] = FIXTURE.cases;
    mockGoldenCaseRepository.findAll.mockResolvedValue([
      { id: 'gc-a', tenantId: TENANT, goldenSetId: SET_ID },
      { id: 'gc-b', tenantId: TENANT, goldenSetId: SET_ID },
    ]);
    mockGoldenCaseRepository.decryptFieldsFromEntity.mockImplementation(async (entity: { id: string }) =>
      entity.id === 'gc-a'
        ? { transcript: JSON.stringify(first.transcript), referenceNote: JSON.stringify(first.reference) }
        : { transcript: 'patient reports headache', referenceNote: 'S: headache.' },
    );

    await expect(service.runGoldenSet({ goldenSetId: SET_ID, tenantId: TENANT, triggerType: 'MANUAL' })).rejects.toBeInstanceOf(
      ArgumentInvalidException,
    );
    expect(mockHarnessGateway.runEval).not.toHaveBeenCalled();
  });

  it('keeps a plain set on the PDSQI path (no mode, goldenSet inlined)', async () => {
    mockGoldenCaseRepository.findAll.mockResolvedValue([{ id: 'c0', tenantId: TENANT, goldenSetId: SET_ID }]);
    mockGoldenCaseRepository.decryptFieldsFromEntity.mockResolvedValue({ transcript: 'patient reports headache', referenceNote: 'S: headache.' });
    mockHarnessGateway.runEval.mockResolvedValue(harnessResult({ judge_model: 'stub-judge', caseScores: [] }));

    await service.runGoldenSet({ goldenSetId: SET_ID, tenantId: TENANT, triggerType: 'MANUAL' });

    const payload = mockHarnessGateway.runEval.mock.calls[0][0];
    expect(payload.mode).toBeUndefined();
    expect(payload.noteCompleteness).toBeUndefined();
    expect(payload.goldenSet.cases[0]).toMatchObject({ case_id: 'c0', source_documents: ['patient reports headache'] });
  });
});
