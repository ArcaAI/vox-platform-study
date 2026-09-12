/**
 * TASK-957 F-2 / F-3 + TASK-959 §3.2 — what the BLOCKING agent invocation bills.
 *
 * The stream path of this very route has always billed through `parseTextUsageDetail` +
 * `buildLlmUsageInput`. The blocking path billed from two token counts and a `generateId()`,
 * which cost four separate things:
 *
 *  · cache-read/write and reasoning tokens were never recorded — under-billing and under-COGS
 *    on every cloud model that reports them;
 *  · `endpointKind` / `serviceTier` / `cacheTtl` were absent, so the rater could not select the
 *    cache-TTL and context-band rows the price book already carries;
 *  · `occurredAt` was the gateway clock rather than TEXT's, so a backfilled or delayed event
 *    was priced at the wrong moment;
 *  · `requestId` was RANDOM, which violates the intent-derived-key rule and breaks the only
 *    join between a ledger row and TEXT's persisted task log — the reconciliation a disputed
 *    invoice needs.
 *
 * F-3 is the guardrail half: TEXT reports the screening call it made on this request's behalf,
 * and the agent plane recorded it nowhere. It is COGS, never a tenant line (D16).
 *
 * TASK-959 adds the compute and byte rows to the same batches — occupancy seconds off
 * `engine_ms ?? total_ms`, vendor bytes off the pool counters — on both the blocking and the
 * streaming path.
 */
import 'reflect-metadata';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiCostBasis, AiUsageUnit } from '@arcaai/domains';
import { AgentController } from '../agent.controller';

const TENANT = '50000000-0000-0000-0000-000000000000';

const RESOLVED = {
  agentId: 'a1',
  agentVersionId: 'a1',
  slug: 'clinic-summarizer',
  versionNumber: 2,
  task: 'TEXT_GENERATION',
  tenantId: TENANT,
  source: 'explicit',
  fundingTier: 'platform',
  compiledConfig: {
    task: 'TEXT_GENERATION',
    service: 'llm',
    model: { id: 'm', slug: 'lms-gemma-4-e2b-it-qat', provider: 'lm-studio', taskType: 'TEXT_GENERATION' },
    fallbacks: [],
    instruction: null,
    resolvedPrompt: null,
    parameters: {},
    inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    outputSchema: { type: 'object' },
    tools: [],
    protocols: ['http', 'http-sse'],
  },
  models: [],
  guardrail: { enabled: true },
};

function fakeRes() {
  const headers: Record<string, string> = {};
  const res = {
    headers,
    statusCode: 0,
    body: undefined as unknown,
    setHeader: vi.fn((k: string, v: string) => void (headers[k] = v)),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    status: vi.fn(function (this: unknown, code: number) {
      (res as { statusCode: number }).statusCode = code;
      return res;
    }),
    json: vi.fn((body: unknown) => void ((res as { body: unknown }).body = body)),
    on: vi.fn(),
  };
  return res;
}

function make(over: { device?: Record<string, string>; billing?: { assertSpendLimit: ReturnType<typeof vi.fn> } } = {}) {
  const agentService = { listPublished: vi.fn(), getPublishedBySlug: vi.fn() };
  const resolver = { resolve: vi.fn(async () => RESOLVED) };
  const invocation = {
    inputProblems: vi.fn(() => []),
    invokeText: vi.fn(async (): Promise<unknown> => ({})),
    invokeNer: vi.fn(async (): Promise<unknown> => ({})),
    buildSpeechRequest: vi.fn(),
    guardrailDisposition: vi.fn(async (): Promise<'screened'> => 'screened'),
  };
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'u1' } : undefined)) };
  const entitlementsService = { assertMeterQuota: vi.fn(async () => undefined) };
  const usageLedger = { recordUsage: vi.fn(async (_batch: unknown) => ({ written: 1 })) };
  const tenantSettings = { resolve: vi.fn(() => ({ value: over.device ?? { 'lm-studio': 'cuda' }, source: 'system' })) };
  const controller = new AgentController(
    agentService as never,
    resolver as never,
    invocation as never,
    cls as never,
    {} as never, // httpService
    { getConfigValue: () => 'http://tts' } as never,
    undefined, // secretsService
    undefined, // ttsResolver
    entitlementsService as never,
    usageLedger as never,
    { createBatchJob: vi.fn(), failJob: vi.fn() } as never,
    { dispatchDramatiqJob: vi.fn() } as never,
    { fetchById: vi.fn() } as never,
    { resolve: vi.fn() } as never,
    (over.billing ?? { assertSpendLimit: vi.fn(async () => undefined) }) as never,
    tenantSettings as never,
  );
  return { controller, invocation, usageLedger, entitlementsService, tenantSettings };
}

/** TEXT's own block on a blocking `/generate` response — the one this lane stopped discarding. */
const USAGE_DETAIL = {
  task_id: 'text-task-77',
  request_id: 'req-77',
  provider: 'openai_compat',
  model: 'lms-gemma-4-e2b-it-qat',
  endpoint_kind: 'openai.chat',
  interrupted: false,
  byok: false,
  connection_id: 'conn-1',
  service_tier: 'batch',
  occurred_at: '2026-09-12T10:00:00.000Z',
  prompt_tokens: 120,
  completion_tokens: 40,
  total_ms: 2500,
  engine_ms: 2100,
  request_bytes: 4096,
  response_bytes: 8192,
  raw: {
    prompt_tokens: 120,
    completion_tokens: 40,
    prompt_tokens_details: { cached_tokens: 64 },
    completion_tokens_details: { reasoning_tokens: 12 },
  },
};

const GUARDRAIL_USAGE = {
  task_id: 'guard-task-9',
  provider: 'openai_compat',
  model: 'granite-guardian',
  endpoint_kind: 'openai.chat',
  interrupted: false,
  byok: false,
  prompt_tokens: 30,
  completion_tokens: 3,
  total_ms: 300,
};

const blockingResult = (over: Record<string, unknown> = {}) => ({
  text: 'hello',
  provider: 'openai_compat',
  model: 'lms-gemma-4-e2b-it-qat',
  usage: { promptTokens: 120, completionTokens: 40 },
  usageDetail: USAGE_DETAIL,
  guardrailUsage: null,
  promptFragments: null,
  ...over,
});

type Batch = { common: Record<string, unknown>; units: { unit: string; quantity: number | string; attributesJson?: Record<string, unknown> }[] };
const batches = (ledger: { recordUsage: ReturnType<typeof vi.fn> }): Batch[] => ledger.recordUsage.mock.calls.map((call) => call[0] as Batch);
const byOperation = (ledger: { recordUsage: ReturnType<typeof vi.fn> }, operation: string): Batch[] =>
  batches(ledger).filter((batch) => batch.common.operation === operation);
const unitOf = (batch: Batch | undefined, unit: AiUsageUnit) => batch?.units.find((line) => line.unit === unit);

const settle = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TASK-957 F-2 — the blocking invocation bills from `usage_detail`', () => {
  it('keys the row on TEXT’s task id, never a fresh random one', async () => {
    const { controller, invocation, usageLedger } = make();
    invocation.invokeText.mockResolvedValue(blockingResult());

    await controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, undefined);
    await settle();

    const [generation] = byOperation(usageLedger, 'generate');
    expect(generation?.common).toMatchObject({ idempotencyKey: 'llm:text-task-77', requestId: 'text-task-77' });
  });

  it('records the cache and reasoning split the flat counts could never carry', async () => {
    const { controller, invocation, usageLedger } = make();
    invocation.invokeText.mockResolvedValue(blockingResult());

    await controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, undefined);
    await settle();

    const [generation] = byOperation(usageLedger, 'generate');
    expect(unitOf(generation, AiUsageUnit.CACHE_READ_TOKEN)).toMatchObject({ quantity: 64 });
    expect(unitOf(generation, AiUsageUnit.REASONING_TOKEN)).toMatchObject({ quantity: 12 });
    // Inclusive-input arithmetic: the normalizer nets cached reads out of the input row.
    expect(unitOf(generation, AiUsageUnit.INPUT_TOKEN)).toMatchObject({ quantity: 56 });
  });

  it('carries TEXT’s own clock, endpoint kind, service tier and connection id', async () => {
    const { controller, invocation, usageLedger } = make();
    invocation.invokeText.mockResolvedValue(blockingResult());

    await controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, undefined);
    await settle();

    const [generation] = byOperation(usageLedger, 'generate');
    expect(generation?.common.occurredAt).toEqual(new Date('2026-09-12T10:00:00.000Z'));
    expect(generation?.common.connectionId).toBe('conn-1');
    expect(generation?.common.attributesJson).toMatchObject({
      endpointKind: 'openai.chat',
      serviceTier: 'batch',
      // Unchanged from before this lane: the activity and how it was screened.
      trigger: 'AGENT_INVOCATION',
      guardrail: 'screened',
    });
  });

  it('derives BYOK funding from TEXT’s own flag rather than stamping it', async () => {
    const { controller, invocation, usageLedger } = make();
    invocation.invokeText.mockResolvedValue(blockingResult({ usageDetail: { ...USAGE_DETAIL, byok: true, provider: 'openai' } }));

    await controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, undefined);
    await settle();

    const [generation] = byOperation(usageLedger, 'generate');
    expect(generation?.common).toMatchObject({ deployment: 'BYOK', costBasis: AiCostBasis.BYOK_NOTIONAL, provider: 'openai' });
  });

  it('falls back to the counts-only builder ONLY when TEXT sent no block at all', async () => {
    const { controller, invocation, usageLedger } = make();
    invocation.invokeText.mockResolvedValue(blockingResult({ usageDetail: null }));

    await controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, undefined);
    await settle();

    const [generation] = byOperation(usageLedger, 'generate');
    expect(unitOf(generation, AiUsageUnit.INPUT_TOKEN)).toMatchObject({ quantity: 120 });
    expect(unitOf(generation, AiUsageUnit.OUTPUT_TOKEN)).toMatchObject({ quantity: 40 });
    // No usage block means no measurement, so no compute row is invented from one.
    expect(unitOf(generation, AiUsageUnit.GPU_SECOND)).toBeUndefined();
  });

  it('records nothing at all when TEXT reported no usage of any kind', async () => {
    const { controller, invocation, usageLedger } = make();
    invocation.invokeText.mockResolvedValue(blockingResult({ usageDetail: null, usage: null }));

    await controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, undefined);
    await settle();

    expect(usageLedger.recordUsage).not.toHaveBeenCalled();
  });
});

describe('TASK-957 F-3 — the guardrail call TEXT made on this request’s behalf', () => {
  it('records a `guardrail.validate` row beside the generation row', async () => {
    const { controller, invocation, usageLedger } = make();
    invocation.invokeText.mockResolvedValue(blockingResult({ guardrailUsage: GUARDRAIL_USAGE }));

    await controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, undefined);
    await settle();

    const [guardrail] = byOperation(usageLedger, 'guardrail.validate');
    expect(guardrail?.common).toMatchObject({ idempotencyKey: 'guardrail:guard-task-9', model: 'granite-guardian' });
    expect(unitOf(guardrail, AiUsageUnit.INPUT_TOKEN)).toMatchObject({ quantity: 30 });
    // The activity is named on this row too (OD-E) — COGS still has to be attributable.
    expect(guardrail?.common.attributesJson).toMatchObject({ trigger: 'AGENT_INVOCATION' });
  });

  it('records the acting clinician on it, exactly as on the generation row', async () => {
    const { controller, invocation, usageLedger } = make();
    invocation.invokeText.mockResolvedValue(blockingResult({ guardrailUsage: GUARDRAIL_USAGE, actingUserId: 'doctor-1' }));

    await controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, undefined);
    await settle();

    expect(byOperation(usageLedger, 'guardrail.validate')[0]?.common.doctorId).toBe('doctor-1');
    expect(byOperation(usageLedger, 'generate')[0]?.common.doctorId).toBe('doctor-1');
  });

  it('records no guardrail row when TEXT reported none — silence is not a zero-cost call', async () => {
    const { controller, invocation, usageLedger } = make();
    invocation.invokeText.mockResolvedValue(blockingResult());

    await controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, undefined);
    await settle();

    expect(byOperation(usageLedger, 'guardrail.validate')).toHaveLength(0);
  });
});

describe('TASK-959 §3.2 — compute and byte rows on the agent’s generation', () => {
  it('prefers the engine’s own time over the client wall clock, as GPU seconds for a cuda provider', async () => {
    const { controller, invocation, usageLedger, tenantSettings } = make({ device: { 'lm-studio': 'cuda' } });
    invocation.invokeText.mockResolvedValue(blockingResult());

    await controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, undefined);
    await settle();

    const [generation] = byOperation(usageLedger, 'generate');
    expect(unitOf(generation, AiUsageUnit.GPU_SECOND)).toMatchObject({ quantity: 2.1, attributesJson: { device: 'cuda' } });
    expect(tenantSettings.resolve).toHaveBeenCalledWith('metering.compute.deviceByProvider', TENANT);
  });

  it('falls back to `total_ms` when the engine reported no time of its own', async () => {
    const { controller, invocation, usageLedger } = make();
    invocation.invokeText.mockResolvedValue(blockingResult({ usageDetail: { ...USAGE_DETAIL, engine_ms: null } }));

    await controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, undefined);
    await settle();

    expect(unitOf(byOperation(usageLedger, 'generate')[0], AiUsageUnit.GPU_SECOND)).toMatchObject({ quantity: 2.5 });
  });

  it('records CPU seconds for a provider the tenant’s device map does not name — the cheaper unit, never nothing', async () => {
    const { controller, invocation, usageLedger } = make({ device: { vllm: 'cuda' } });
    invocation.invokeText.mockResolvedValue(blockingResult());

    await controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, undefined);
    await settle();

    expect(unitOf(byOperation(usageLedger, 'generate')[0], AiUsageUnit.CPU_SECOND)).toMatchObject({ quantity: 2.1, attributesJson: { device: 'cpu' } });
  });

  it('records the vendor bytes in both directions', async () => {
    const { controller, invocation, usageLedger } = make();
    invocation.invokeText.mockResolvedValue(blockingResult());

    await controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, undefined);
    await settle();

    const [generation] = byOperation(usageLedger, 'generate');
    expect(unitOf(generation, AiUsageUnit.EGRESS_BYTE)).toMatchObject({ quantity: 4096, attributesJson: { byteSource: 'wire' } });
    expect(unitOf(generation, AiUsageUnit.INGRESS_BYTE)).toMatchObject({ quantity: 8192 });
  });

  it('splits a BYOK call’s CPU seconds into a second INTERNAL batch — the platform’s cost of calling', async () => {
    const { controller, invocation, usageLedger } = make();
    invocation.invokeText.mockResolvedValue(blockingResult({ usageDetail: { ...USAGE_DETAIL, byok: true, provider: 'openai' } }));

    await controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, undefined);
    await settle();

    const generation = byOperation(usageLedger, 'generate');
    expect(generation).toHaveLength(2);
    expect(generation[0]?.common.costBasis).toBe(AiCostBasis.BYOK_NOTIONAL);
    expect(generation[1]?.common.costBasis).toBe(AiCostBasis.INTERNAL);
    // A vendor call is the platform's CPU, whatever the device map says about self-hosted servers.
    expect(unitOf(generation[1], AiUsageUnit.CPU_SECOND)).toMatchObject({ quantity: 2.1, attributesJson: { device: 'cpu' } });
  });

  it('falls back to the DECLARED default map when the settings cascade raises — never a lost usage batch', async () => {
    const { controller, invocation, usageLedger, tenantSettings } = make();
    invocation.invokeText.mockResolvedValue(blockingResult());
    tenantSettings.resolve.mockImplementation(() => {
      throw new Error('settings cache not warmed');
    });

    await controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, undefined);
    await settle();

    const [generation] = byOperation(usageLedger, 'generate');
    // The tokens are billed either way — a device label must never cost a usage batch — and the
    // descriptor's own default is the platform's truthful answer for its own engines.
    expect(unitOf(generation, AiUsageUnit.INPUT_TOKEN)).toBeDefined();
    expect(unitOf(generation, AiUsageUnit.GPU_SECOND)).toMatchObject({ quantity: 2.1, attributesJson: { device: 'cuda' } });
  });

  it('uses the platform default map when the cascade produced no map at all', async () => {
    const { controller, invocation, usageLedger, tenantSettings } = make();
    invocation.invokeText.mockResolvedValue(blockingResult());
    tenantSettings.resolve.mockReturnValue({ value: undefined, source: 'code-default' });

    await controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, undefined);
    await settle();

    expect(unitOf(byOperation(usageLedger, 'generate')[0], AiUsageUnit.GPU_SECOND)).toMatchObject({ quantity: 2.1 });
  });
});

describe('TASK-959 §3.2 — compute and byte rows on the agent’s STREAM', () => {
  /** The terminal frame `apps/text` writes, CRLF-framed exactly as `sse_starlette` does. */
  const terminalFrame = (usage: Record<string, unknown>) => `event: done\r\ndata: ${JSON.stringify({ data: { usage } })}\r\n\r\n`;

  it('appends the compute and byte rows off the terminal frame the stream already meters', async () => {
    const { controller, invocation, usageLedger } = make();
    const stream = new PassThrough();
    invocation.invokeText.mockResolvedValue({ stream });

    await controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, 'stream');
    stream.write(`data: {"delta":"tok"}\r\n\r\n`);
    stream.write(terminalFrame({ ...USAGE_DETAIL, interrupted: false }));
    stream.end();
    await settle();

    const [generation] = byOperation(usageLedger, 'generate.stream');
    expect(unitOf(generation, AiUsageUnit.GPU_SECOND)).toMatchObject({ quantity: 2.1, attributesJson: { device: 'cuda' } });
    expect(unitOf(generation, AiUsageUnit.EGRESS_BYTE)).toMatchObject({ quantity: 4096 });
    expect(unitOf(generation, AiUsageUnit.INGRESS_BYTE)).toMatchObject({ quantity: 8192 });
    // The tokens are still billed by the shared collector, untouched.
    expect(unitOf(generation, AiUsageUnit.OUTPUT_TOKEN)).toBeDefined();
  });

  it('still bills the tokens when the frame carried no timing at all', async () => {
    const { controller, invocation, usageLedger } = make();
    const stream = new PassThrough();
    invocation.invokeText.mockResolvedValue({ stream });

    await controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, 'stream');
    stream.write(terminalFrame({ ...USAGE_DETAIL, total_ms: undefined, engine_ms: undefined, request_bytes: undefined, response_bytes: undefined }));
    stream.end();
    await settle();

    const [generation] = byOperation(usageLedger, 'generate.stream');
    expect(unitOf(generation, AiUsageUnit.OUTPUT_TOKEN)).toBeDefined();
    expect(unitOf(generation, AiUsageUnit.GPU_SECOND)).toBeUndefined();
  });

  it('records the compute on an ABORTED stream too — those seconds were still occupied', async () => {
    const { controller, invocation, usageLedger } = make();
    const stream = new PassThrough();
    invocation.invokeText.mockResolvedValue({ stream });

    await controller.invoke('clinic-summarizer', { text: 'hi' }, fakeRes() as never, 'stream');
    stream.write(terminalFrame(USAGE_DETAIL));
    await settle();
    stream.emit('error', new Error('socket died'));
    await settle();

    const [generation] = byOperation(usageLedger, 'generate.stream');
    expect(unitOf(generation, AiUsageUnit.GPU_SECOND)).toMatchObject({ quantity: 2.1 });
  });
});

/**
 * The NER branch of the same route. It shares `buildNerUsageEvent` with the two clinical call
 * sites and the playground proxy, so the reading is carried rather than re-derived — but the
 * route is what proves the wire values reach it at all.
 */
describe('TASK-959 §3.2 — compute on an agent NER invocation', () => {
  const nerAgent = { ...RESOLVED, task: 'NAMED_ENTITY_RECOGNITION', slug: 'medical-ner' };

  it('records the seconds apps/nlp measured, in the unit its device decides', async () => {
    const { controller, invocation, usageLedger } = make();
    (invocation as unknown as { invokeNer: ReturnType<typeof vi.fn> }).invokeNer = vi.fn(async () => ({
      entities: [],
      model: 'medical-ner',
      charCount: 250,
      inferenceMs: 420,
      device: 'cuda',
    }));
    (controller as unknown as { resolver: { resolve: ReturnType<typeof vi.fn> } }).resolver.resolve.mockResolvedValue(nerAgent);

    await controller.invoke('medical-ner', { text: 'chest pain' }, fakeRes() as never, undefined);
    await settle();

    const [extraction] = byOperation(usageLedger, 'ner.extract');
    expect(unitOf(extraction, AiUsageUnit.GPU_SECOND)).toMatchObject({ quantity: 0.42, attributesJson: { device: 'cuda' } });
    expect(unitOf(extraction, AiUsageUnit.TEXT_UNIT)).toMatchObject({ quantity: 2.5 });
  });

  it('records characters and no compute when apps/nlp measured nothing', async () => {
    const { controller, invocation, usageLedger } = make();
    (invocation as unknown as { invokeNer: ReturnType<typeof vi.fn> }).invokeNer = vi.fn(async () => ({
      entities: [],
      model: 'medical-ner',
      charCount: 250,
      inferenceMs: null,
      device: null,
    }));
    (controller as unknown as { resolver: { resolve: ReturnType<typeof vi.fn> } }).resolver.resolve.mockResolvedValue(nerAgent);

    await controller.invoke('medical-ner', { text: 'chest pain' }, fakeRes() as never, undefined);
    await settle();

    const [extraction] = byOperation(usageLedger, 'ner.extract');
    expect(unitOf(extraction, AiUsageUnit.GPU_SECOND)).toBeUndefined();
    expect(unitOf(extraction, AiUsageUnit.CPU_SECOND)).toBeUndefined();
    expect(unitOf(extraction, AiUsageUnit.TEXT_UNIT)).toBeDefined();
  });
});
