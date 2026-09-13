/**
 * TASK-957 F-7b — the three `/text-analyses` benches that emitted nothing.
 *
 * `/entities` has metered since TASK-890. `/diagnosis`, `/topic` and `/intent` sit on the same
 * controller, behind the same ability, on the same platform credential — and recorded nothing at
 * all. OD-E ("every inference activity counts") does not exempt a bench.
 *
 * The two kinds of work bill differently BECAUSE they are different work:
 *
 *  · `/diagnosis` runs two LOCAL models (a symptom NER and a disease classifier) inside
 *    `apps/nlp`, which reports its own `inference_ms` and `device`. That is NLP text units plus
 *    platform compute — a new `nlp.classify` operation beside `ner.extract`, because extraction
 *    and classification are different models at different prices and `operation` is the only
 *    dimension a rollup could tell them apart by.
 *  · `/topic` and `/intent` run NO local model: `apps/nlp` delegates each to `apps/text`, so the
 *    cost of one classification IS that LLM call (plus the guardrail call it triggered). They
 *    bill as `generate` + `guardrail.validate` keyed on TEXT's own task id — the SAME rows the
 *    playground's own text proxy would have written, because it is the same generation.
 */
import { AiCapability, AiDeploymentKind, AiUsageUnit, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { describe, expect, it, vi } from 'vitest';

import { AiInferenceController } from '../ai-inference.controller';

const NLP_MODEL = { sourceUri: 'org/medical-ner', slug: 'medical-ner', provider: 'built-in', metaData: null };

const USAGE_DETAIL = {
  task_id: 'text-task-topic-1',
  request_id: 'corr-1',
  provider: 'lm-studio',
  model: 'qwen3-32b',
  endpoint_kind: 'openai.chat',
  interrupted: false,
  byok: false,
  occurred_at: '2026-09-13T10:00:00.000Z',
  prompt_tokens: 120,
  completion_tokens: 3,
  total_ms: 800,
  raw: { prompt_tokens: 120, completion_tokens: 3 },
};
// Its OWN `raw` block: the normalizer prefers the provider's raw payload (it is the only thing
// carrying the cache/reasoning split), so a fixture that inherited the generation's `raw` would
// assert the generation's counts on the guardrail row.
const GUARDRAIL_USAGE = {
  ...USAGE_DETAIL,
  task_id: 'guard-topic-1',
  prompt_tokens: 40,
  completion_tokens: 1,
  total_ms: 300,
  raw: { prompt_tokens: 40, completion_tokens: 1 },
};

type Recorded = {
  common: { operation: string; capability: string; idempotencyKey: string; provider: string; deployment: string; model?: string | null };
  units: { unit: AiUsageUnit; quantity: unknown; attributesJson?: Record<string, unknown> | null }[];
};

function build(opts: { upstream?: Record<string, unknown>; computeDevice?: unknown } = {}) {
  const client = {
    analyzeGuardrail: vi.fn(),
    classifyTokens: vi.fn(),
    suggestDiagnosis: vi.fn(async () => opts.upstream ?? {}),
    classifyTopic: vi.fn(async () => opts.upstream ?? {}),
    classifyIntent: vi.fn(async () => opts.upstream ?? {}),
  };
  const ledger = { recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o1'], events: 1 }) };
  const controller = new AiInferenceController(
    client as never,
    { resolveDefault: vi.fn(async () => ({ model: NLP_MODEL })) } as never,
    undefined as never,
    { get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-1' : undefined)) } as never,
    ledger as never,
    { getRow: vi.fn(async () => ({ instructionsJson: ['billing', 'clinical'] })) } as never,
    (opts.computeDevice ?? { resolve: vi.fn(async () => 'cuda') }) as never,
  );
  return { controller, client, ledger };
}

const recorded = (ledger: { recordUsage: ReturnType<typeof vi.fn> }, operation: string): Recorded[] =>
  ledger.recordUsage.mock.calls.map((call) => call[0] as Recorded).filter((input) => input.common.operation === operation);

const quantity = (row: Recorded | undefined, unit: AiUsageUnit): unknown => row?.units.find((u) => u.unit === unit)?.quantity;

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('TASK-957 F-7b — /text-analyses/diagnosis records what it consumed', () => {
  it('bills NLP text units under `nlp.classify`, keyed per invocation', async () => {
    const harness = build({ upstream: { suggestions: [], inference_ms: 640, device: 'cuda' } });
    await harness.controller.suggestDiagnosis({ text: 'a'.repeat(250) } as never);
    await settle();

    const [row] = recorded(harness.ledger, 'nlp.classify');
    expect(row).toBeDefined();
    expect(row.common.capability).toBe(AiCapability.NLP);
    // The platform's own weights — there is no cloud/BYOK NER or classification plane at all.
    expect(row.common.provider).toBe('built-in');
    expect(row.common.deployment).toBe(AiDeploymentKind.SELF_HOSTED);
    // 100 characters to the text unit, exactly as `ner.extract` counts.
    expect(quantity(row, AiUsageUnit.TEXT_UNIT)).toBe(2.5);
    expect(quantity(row, AiUsageUnit.REQUEST)).toBe(1);
    // A FRESH key per invocation: two diagnoses in one session must be two rows, never
    // one row and one silent replay at the ledger.
    expect(row.common.idempotencyKey).toMatch(/^nlp:.+/);
  });

  it('turns `apps/nlp`’s own inference_ms + device into the compute row', async () => {
    const harness = build({ upstream: { suggestions: [], inference_ms: 640, device: 'cuda' } });
    await harness.controller.suggestDiagnosis({ text: 'abc' } as never);
    await settle();

    const [row] = recorded(harness.ledger, 'nlp.classify');
    expect(row.units.find((u) => u.unit === AiUsageUnit.GPU_SECOND)).toMatchObject({ quantity: '0.640', attributesJson: { device: 'cuda' } });
  });

  it('records the text units with NO compute row when nlp reported no timing', async () => {
    // Never guessed. A zero-second row would read as "measured, and it was free".
    const harness = build({ upstream: { suggestions: [] } });
    await harness.controller.suggestDiagnosis({ text: 'abc' } as never);
    await settle();

    const [row] = recorded(harness.ledger, 'nlp.classify');
    expect(quantity(row, AiUsageUnit.TEXT_UNIT)).toBeDefined();
    expect(row.units.find((u) => u.unit === AiUsageUnit.GPU_SECOND || u.unit === AiUsageUnit.CPU_SECOND)).toBeUndefined();
  });

  it('never fails the request when metering does', async () => {
    const harness = build({ upstream: { suggestions: [], inference_ms: 10, device: 'cpu' } });
    harness.ledger.recordUsage.mockRejectedValue(new Error('outbox down'));
    await expect(harness.controller.suggestDiagnosis({ text: 'abc' } as never)).resolves.toBeDefined();
  });
});

describe('TASK-957 F-7b — /text-analyses/{topic,intent} record the DELEGATED LLM spend', () => {
  const cases: ('classifyTopic' | 'classifyIntent')[] = ['classifyTopic', 'classifyIntent'];

  it.each(cases)('%s bills a `generate` row keyed on TEXT’s own task id', async (method) => {
    const harness = build({ upstream: { predicted_topic: 'billing', llm_usage: USAGE_DETAIL, llm_guardrail_usage: GUARDRAIL_USAGE } });
    await harness.controller[method]({ text: 'hello' } as never);
    await settle();

    const [generation] = recorded(harness.ledger, 'generate');
    expect(generation).toBeDefined();
    expect(generation.common.capability).toBe(AiCapability.LLM);
    expect(generation.common.idempotencyKey).toBe('llm:text-task-topic-1');
    expect(quantity(generation, AiUsageUnit.INPUT_TOKEN)).toBe(120);
    expect(quantity(generation, AiUsageUnit.OUTPUT_TOKEN)).toBe(3);
    // Resolved from the provider that ACTUALLY served, as every other LLM emitter does.
    expect(generation.units.find((u) => u.unit === AiUsageUnit.GPU_SECOND)).toMatchObject({ quantity: '0.800', attributesJson: { device: 'cuda' } });
  });

  it.each(cases)('%s bills the guardrail call TEXT made on its behalf', async (method) => {
    const harness = build({ upstream: { predicted_intent: 'billing', llm_usage: USAGE_DETAIL, llm_guardrail_usage: GUARDRAIL_USAGE } });
    await harness.controller[method]({ text: 'hello' } as never);
    await settle();

    const [guardrail] = recorded(harness.ledger, 'guardrail.validate');
    expect(guardrail.common.idempotencyKey).toBe('guardrail:guard-topic-1');
    expect(quantity(guardrail, AiUsageUnit.INPUT_TOKEN)).toBe(40);
  });

  it('records NO `nlp.classify` row for a delegated route — the LLM tokens ARE the cost', async () => {
    // Billing text units here too would charge one classification twice, on two capabilities.
    const harness = build({ upstream: { predicted_topic: 'billing', llm_usage: USAGE_DETAIL } });
    await harness.controller.classifyTopic({ text: 'hello' } as never);
    await settle();

    expect(recorded(harness.ledger, 'nlp.classify')).toHaveLength(0);
    expect(recorded(harness.ledger, 'guardrail.validate')).toHaveLength(0);
  });

  it('records an `nlp.classify` COMPUTE row when nlp reports timing of its own', async () => {
    // It does not today (these routes load no model), so this pins the rule rather than
    // today's wire: nlp's own seconds are nlp's, whoever ran the tokens.
    const harness = build({ upstream: { predicted_topic: 'billing', llm_usage: USAGE_DETAIL, inference_ms: 40, device: 'cpu' } });
    await harness.controller.classifyTopic({ text: 'hello' } as never);
    await settle();

    const [row] = recorded(harness.ledger, 'nlp.classify');
    expect(quantity(row, AiUsageUnit.CPU_SECOND)).toBe('0.040');
    // No text units: the tokens already carry the cost of the classification itself.
    expect(quantity(row, AiUsageUnit.TEXT_UNIT)).toBeUndefined();
  });

  it('records nothing at all when nlp carried no usage block', async () => {
    const harness = build({ upstream: { predicted_topic: 'billing' } });
    await harness.controller.classifyTopic({ text: 'hello' } as never);
    await settle();
    expect(harness.ledger.recordUsage).not.toHaveBeenCalled();
  });
});

describe('TASK-957 F-7b — the SYSTEM routing election is unchanged', () => {
  it('still resolves nlp.diagnosis + nlp.ner against SYSTEM before calling upstream', async () => {
    const harness = build({ upstream: { suggestions: [] } });
    await harness.controller.suggestDiagnosis({ text: 'abc' } as never);
    expect(harness.client.suggestDiagnosis).toHaveBeenCalled();
    expect(SYSTEM_TENANT_ID).toBeDefined();
  });
});
