/**
 * AgentTrajectoryService — token + $ accounting.
 *
 * The substrate for per-run budgets was already complete and already ignored:
 * `SmrGenerationResult.stats` carries token counts, the harness forwards it
 * verbatim onto every LLM_CALL step (`activities.py:1003-1008`), and
 * `AgentTrajectoryStep.stats` persists it — but `parseGenerationStats` read only
 * three keys (`ttft_ms`, `tokens_per_second`, `stop_reason`) and threw the tokens
 * away. Nothing anywhere summed them, so "per-run token budget" had no numerator.
 *
 * This slice reads what is already there. No schema change, no new activity, and
 * therefore no replay surface.
 *
 * $-cost comes from `AiModel.metaData.pricing` (data, not a migration — the
 * schema has no pricing column and does not need one).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentStepType } from '@arcaai/domains';
import { AgentTrajectoryService } from '../agent-trajectory.service';

const TENANT = 'tenant-budget';

const stepRepository = { findAll: vi.fn(), createMany: vi.fn(), groupBy: vi.fn() };
const cls = {
  get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'user-1' } : undefined)),
};

function buildService() {
  return new AgentTrajectoryService(
    stepRepository as never,
    { emit: vi.fn() } as never,
    cls as never,
  );
}

/** An LLM_CALL step whose stats carry the SMR usage block. */
const llmStep = (stats: Record<string, unknown>) => ({ stepType: AgentStepType.LLM_CALL, stats });

describe('AgentTrajectoryService — token accounting', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sums prompt/completion tokens that were already being persisted and discarded', async () => {
    stepRepository.findAll.mockResolvedValue([
      llmStep({ ttft_ms: 100, prompt_tokens: 1200, completion_tokens: 300 }),
      llmStep({ ttft_ms: 120, prompt_tokens: 800, completion_tokens: 200 }),
    ]);

    const metrics = await buildService().aggregateGenerationStats(TENANT);

    expect(metrics.promptTokensTotal).toBe(2000);
    expect(metrics.completionTokensTotal).toBe(500);
    expect(metrics.totalTokens).toBe(2500);
  });

  it('tolerates camelCase and the nested usage block the SMR client emits', async () => {
    stepRepository.findAll.mockResolvedValue([
      llmStep({ promptTokens: 10, completionTokens: 5 }),
      llmStep({ usage: { prompt_tokens: 7, completion_tokens: 3 } }),
    ]);

    const metrics = await buildService().aggregateGenerationStats(TENANT);

    expect(metrics.promptTokensTotal).toBe(17);
    expect(metrics.completionTokensTotal).toBe(8);
  });

  it('counts a token-only sample — tokens alone make a step meaningful', async () => {
    // Before B4 a stats block with ONLY token counts parsed to null and the step
    // was skipped entirely, so it contributed to no metric at all.
    stepRepository.findAll.mockResolvedValue([llmStep({ prompt_tokens: 42 })]);

    const metrics = await buildService().aggregateGenerationStats(TENANT);

    expect(metrics.sampleCount).toBe(1);
    expect(metrics.promptTokensTotal).toBe(42);
  });

  it('leaves token totals null when no sample carried any', async () => {
    stepRepository.findAll.mockResolvedValue([llmStep({ ttft_ms: 100 })]);

    const metrics = await buildService().aggregateGenerationStats(TENANT);

    expect(metrics.promptTokensTotal).toBeNull();
    expect(metrics.totalTokens).toBeNull();
    // The pre-B4 KPIs are untouched.
    expect(metrics.ttftMedianMs).toBe(100);
  });

  it('computes $-cost from AiModel.metaData.pricing when a price book is supplied', async () => {
    stepRepository.findAll.mockResolvedValue([
      llmStep({ model: 'medgemma-27b', prompt_tokens: 1000, completion_tokens: 500 }),
    ]);

    const metrics = await buildService().aggregateGenerationStats(TENANT, {
      pricing: { 'medgemma-27b': { inputPer1k: 0.002, outputPer1k: 0.006, currency: 'USD' } },
    });

    // 1000/1000*0.002 + 500/1000*0.006 = 0.002 + 0.003
    expect(metrics.estimatedCost).toBeCloseTo(0.005, 6);
    expect(metrics.currency).toBe('USD');
  });

  it('leaves cost null when the model has no price-book entry (never guesses)', async () => {
    stepRepository.findAll.mockResolvedValue([
      llmStep({ model: 'unpriced-model', prompt_tokens: 1000, completion_tokens: 500 }),
    ]);

    const metrics = await buildService().aggregateGenerationStats(TENANT, {
      pricing: { 'other-model': { inputPer1k: 1, outputPer1k: 1, currency: 'USD' } },
    });

    expect(metrics.estimatedCost).toBeNull();
    expect(metrics.totalTokens).toBe(1500);
  });

  it('leaves cost null when no price book is supplied at all', async () => {
    stepRepository.findAll.mockResolvedValue([llmStep({ model: 'm', prompt_tokens: 10, completion_tokens: 10 })]);

    const metrics = await buildService().aggregateGenerationStats(TENANT);

    expect(metrics.estimatedCost).toBeNull();
  });
});

describe('AgentTrajectoryService — per-run token spend', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sums a single run identified by (sessionId, runId)', async () => {
    stepRepository.findAll.mockResolvedValue([
      llmStep({ prompt_tokens: 100, completion_tokens: 50 }),
      llmStep({ prompt_tokens: 200, completion_tokens: 25 }),
    ]);

    const spend = await buildService().getRunTokenSpend(TENANT, 'session-1', 'run-1');

    expect(spend.totalTokens).toBe(375);
    expect(spend.promptTokens).toBe(300);
    expect(spend.completionTokens).toBe(75);
  });

  it('scopes the query to the run and to LLM_CALL steps only', async () => {
    stepRepository.findAll.mockResolvedValue([]);

    await buildService().getRunTokenSpend(TENANT, 'session-1', 'run-1');

    const where = stepRepository.findAll.mock.calls[0][0].where;
    expect(where).toMatchObject({
      tenantId: TENANT,
      sessionId: 'session-1',
      runId: 'run-1',
      stepType: AgentStepType.LLM_CALL,
    });
  });

  it('reports zero (not null) for a run with no recorded spend — a budget check needs a number', async () => {
    stepRepository.findAll.mockResolvedValue([]);

    const spend = await buildService().getRunTokenSpend(TENANT, 'session-1', 'run-1');

    expect(spend.totalTokens).toBe(0);
  });

  it('handles the "" runId sentinel used by live-doc / job sessions', async () => {
    stepRepository.findAll.mockResolvedValue([llmStep({ prompt_tokens: 5, completion_tokens: 5 })]);

    const spend = await buildService().getRunTokenSpend(TENANT, 'session-live', '');

    expect(stepRepository.findAll.mock.calls[0][0].where.runId).toBe('');
    expect(spend.totalTokens).toBe(10);
  });
});

describe('budget exhaustion predicate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('perRun=0 means unbounded — the original behaviour, byte-for-byte', async () => {
    stepRepository.findAll.mockResolvedValue([llmStep({ prompt_tokens: 10_000_000 })]);

    const result = await buildService().checkRunBudget(TENANT, 'session-1', 'run-1', 0);

    expect(result.exceeded).toBe(false);
    expect(result.perRunBudget).toBe(0);
  });

  it('flags exceeded once spend reaches the budget', async () => {
    stepRepository.findAll.mockResolvedValue([llmStep({ prompt_tokens: 900, completion_tokens: 200 })]);

    const result = await buildService().checkRunBudget(TENANT, 'session-1', 'run-1', 1000);

    expect(result.usedTokens).toBe(1100);
    expect(result.exceeded).toBe(true);
  });

  it('does not flag while under budget', async () => {
    stepRepository.findAll.mockResolvedValue([llmStep({ prompt_tokens: 100 })]);

    const result = await buildService().checkRunBudget(TENANT, 'session-1', 'run-1', 1000);

    expect(result.exceeded).toBe(false);
  });
});
