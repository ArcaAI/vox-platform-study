/**
 * TASK-957 F-2 / F-3 (+ TASK-959 §3.2) — what the BLOCKING invocation hands back for billing.
 *
 * `invokeText(..., 'blocking')` used to narrow TEXT's answer to `{prompt_tokens,
 * completion_tokens}` and drop everything else. Everything else is what the ledger needs: the
 * `usage_detail` block carries the task id the idempotency key must be derived from, the
 * cache/reasoning split, the endpoint kind the rater branches on, the BYOK flag, the connection
 * id — and, since TASK-959, the occupancy milliseconds and the vendor byte counts. The
 * `guardrail_usage` block is the guardrail call TEXT made on this request's behalf, which the
 * agent plane never recorded at all.
 *
 * The service does NOT bill; it stops LOSING the numbers. Both blocks are handed back VERBATIM
 * (a `Record`, not a parsed shape) because `parseTextUsageDetail` is the ONE parser and it lives
 * on the emitting side — a second interpretation here is a second thing to keep in step.
 *
 * The NER half is the same fix for `apps/nlp`: `inference_ms` and `device` are on every
 * inference response since TASK-959, and without them a NER invocation records characters but
 * no compute at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedAgent, ResolvedAgentModel } from '@arcaai/types';
import { AgentInvocationService } from '../agent-invocation.service';

const TENANT = '50000000-0000-0000-0000-000000000001';

const post = vi.fn();
const httpService = { axiosRef: { post } } as never;
const configService = {
  get: vi.fn((key: string) => (key === 'NLP_URL' ? 'http://nlp.test' : 'http://text.test')),
} as never;
const enrichment = {
  applyTextRuntimeProfile: vi.fn().mockResolvedValue(undefined),
  applyTenantProviderOverrides: vi.fn().mockResolvedValue(undefined),
  applyGuardrailDecision: vi.fn((body: Record<string, unknown>) => body),
} as never;

function service(): AgentInvocationService {
  return new AgentInvocationService(httpService, configService, enrichment);
}

function textAgent(): ResolvedAgent {
  return {
    agentId: 'a2',
    agentVersionId: 'a2',
    slug: 'casenote-finalization',
    versionNumber: 1,
    task: 'TEXT_GENERATION',
    tenantId: TENANT,
    source: 'tenant',
    fundingTier: 'platform',
    compiledConfig: {
      task: 'TEXT_GENERATION',
      service: 'llm',
      model: { id: 'm2', slug: 'lms-gemma', provider: 'lm-studio', taskType: 'TEXT_GENERATION', wireModelId: 'gemma-3' },
      fallbacks: [],
      instruction: null,
      resolvedPrompt: null,
      parameters: {},
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      outputSchema: { type: 'object' },
      tools: [],
    },
    models: [],
    guardrail: { enabled: true },
  } as unknown as ResolvedAgent;
}

function nerPrimary(): ResolvedAgentModel {
  return {
    role: 'primary',
    slug: 'medical-ner',
    sourceUri: 'blaze999/Medical-NER',
    sourceRevision: 'main',
    localPath: '/mnt/models-bucket/medical-ner',
    wireModelId: null,
    checksum: null,
    format: 'SAFETENSOR',
    computeType: 'float32',
    provider: 'built-in',
    tenantId: '00000000-0000-0000-0000-000000000000',
  } as unknown as ResolvedAgentModel;
}

function nerAgent(): ResolvedAgent {
  return {
    agentId: 'a1',
    agentVersionId: 'a1',
    slug: 'medical-ner',
    versionNumber: 1,
    task: 'NAMED_ENTITY_RECOGNITION',
    tenantId: TENANT,
    source: 'tenant',
    compiledConfig: {
      task: 'NAMED_ENTITY_RECOGNITION',
      service: null,
      model: { id: 'm1', slug: 'medical-ner', provider: 'built-in', taskType: 'TOKEN_CLASSIFICATION', wireModelId: null },
      fallbacks: [],
      instruction: null,
      resolvedPrompt: null,
      parameters: {},
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      outputSchema: { type: 'object', properties: { entities: { type: 'array' } }, required: ['entities'] },
      tools: [],
    },
    models: [nerPrimary()],
    guardrail: { enabled: true },
  } as unknown as ResolvedAgent;
}

/** The block `apps/text` puts on a blocking `/generate` response, TASK-959 fields included. */
const USAGE_DETAIL = {
  task_id: 'text-task-77',
  request_id: 'req-77',
  provider: 'openai_compat',
  model: 'gemma-3',
  endpoint_kind: 'openai.chat',
  interrupted: false,
  byok: false,
  connection_id: 'conn-1',
  service_tier: null,
  occurred_at: '2026-09-12T10:00:00.000Z',
  prompt_tokens: 120,
  completion_tokens: 40,
  total_ms: 2500,
  engine_ms: 2100,
  request_bytes: 4096,
  response_bytes: 8192,
  raw: { prompt_tokens: 120, completion_tokens: 40 },
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TASK-957 F-2/F-3 — the blocking invocation result carries TEXT’s own usage blocks', () => {
  it('hands back `usage_detail` VERBATIM beside the token counts it already returned', async () => {
    post.mockResolvedValue({ data: { content: 'note', provider: 'openai_compat', model: 'gemma-3', usage_detail: USAGE_DETAIL } });

    const result = await service().invokeText(textAgent(), TENANT, { text: 'hi' }, 'blocking');

    // Verbatim: the parser lives on the emitting side, so nothing is re-shaped here.
    expect(result.usageDetail).toEqual(USAGE_DETAIL);
    // And the existing fields are untouched — this is additive, not a replacement.
    expect(result.text).toBe('note');
  });

  it('hands back `guardrail_usage` — the guardrail spend the agent plane never recorded (F-3)', async () => {
    post.mockResolvedValue({ data: { content: 'note', usage_detail: USAGE_DETAIL, guardrail_usage: GUARDRAIL_USAGE } });

    const result = await service().invokeText(textAgent(), TENANT, { text: 'hi' }, 'blocking');

    expect(result.guardrailUsage).toEqual(GUARDRAIL_USAGE);
  });

  it('answers null for both when TEXT sent neither — absent, never an empty object to bill from', async () => {
    post.mockResolvedValue({ data: { content: 'note', usage: { prompt_tokens: 1, completion_tokens: 2 } } });

    const result = await service().invokeText(textAgent(), TENANT, { text: 'hi' }, 'blocking');

    expect(result.usageDetail).toBeNull();
    expect(result.guardrailUsage).toBeNull();
    // The counts-only fallback the controller still needs stays intact.
    expect(result.usage).toEqual({ promptTokens: 1, completionTokens: 2 });
  });

  it('ignores a non-object block rather than passing a string to the parser', async () => {
    post.mockResolvedValue({ data: { content: 'note', usage_detail: 'not-an-object', guardrail_usage: [1, 2] } });

    const result = await service().invokeText(textAgent(), TENANT, { text: 'hi' }, 'blocking');

    expect(result.usageDetail).toBeNull();
    expect(result.guardrailUsage).toBeNull();
  });
});

describe('TASK-959 §3.2 — the NER invocation reports the compute apps/nlp measured', () => {
  it('carries `inference_ms` and `device` off the token-classification response', async () => {
    post.mockResolvedValue({ data: { entities: [], model_version: 'medical-ner', inference_ms: 420, device: 'cuda' } });

    const result = await service().invokeNer(nerAgent(), TENANT, { text: 'chest pain' });

    expect(result.inferenceMs).toBe(420);
    expect(result.device).toBe('cuda');
  });

  it('answers null for a device apps/nlp did not name, and for one outside the closed vocabulary', async () => {
    post.mockResolvedValue({ data: { entities: [], inference_ms: 10, device: 'gpu' } });

    const result = await service().invokeNer(nerAgent(), TENANT, { text: 'chest pain' });

    // `gpu` is not one of cuda|mps|cpu. Guessing `cuda` here would bill a GPU second on a word.
    expect(result.device).toBeNull();
    expect(result.inferenceMs).toBe(10);
  });

  it('answers null for an absent or unusable `inference_ms` — no compute row beats a fabricated one', async () => {
    post.mockResolvedValue({ data: { entities: [], device: 'cpu' } });

    const result = await service().invokeNer(nerAgent(), TENANT, { text: 'chest pain' });

    expect(result.inferenceMs).toBeNull();
    expect(result.device).toBe('cpu');
  });
});
