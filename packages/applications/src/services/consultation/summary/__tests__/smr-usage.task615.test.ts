import { AiCapability, AiCostBasis, AiDeploymentKind, AiUsageUnit } from '@arcaai/domains';
import { describe, expect, it } from 'vitest';

import { KNOWN_PROVIDERS } from '../../../usageLedger/vocabulary';
import { buildGuardrailUsageInput, buildLlmUsageInput, buildLlmUsageInputFromTokenCounts, parseSmrUsageDetail, toLedgerProvider } from '../smr-usage';

/**
 * Turning an SMR response into ledger rows.
 *
 * Two independent vocabularies meet here and neither is allowed to bleed into
 * the other: SMR names its providers for its own registry (`azure-openai`,
 * `openai_compat`), while the ledger's `provider` is a ROLLUP DIMENSION whose
 * spelling is fixed by `KNOWN_PROVIDERS`. A wrong mapping does not fail — it
 * silently forks the dimension, so a cost figure splits across two rows nobody
 * can then reconcile. That is what these goldens exist to prevent.
 */

const OCCURRED_AT = '2026-08-06T10:00:00.000Z';

function detail(overrides: Record<string, unknown> = {}): unknown {
  return {
    task_id: 'task-1',
    request_id: 'req-1',
    provider: 'openai',
    model: 'gpt-5',
    endpoint_kind: 'openai.chat',
    interrupted: false,
    byok: false,
    occurred_at: OCCURRED_AT,
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    raw: { prompt_tokens: 100, completion_tokens: 20 },
    ...overrides,
  };
}

describe('toLedgerProvider', () => {
  it.each([
    ['azure-openai', 'azure'],
    ['azure', 'azure'],
    ['openai_compat', 'lm-studio'],
    ['lm-studio', 'lm-studio'],
    ['llama-cpp', 'llama-cpp'],
    ['ollama', 'ollama'],
    ['vllm', 'vllm'],
    ['openai', 'openai'],
    ['anthropic', 'anthropic'],
    ['bedrock', 'bedrock'],
    ['vertex', 'vertex'],
  ])('maps the SMR key %s onto the canonical ledger slug %s', (smr, ledger) => {
    expect(toLedgerProvider(smr)).toBe(ledger);
  });

  it('only ever produces a provider the ledger vocabulary knows', () => {
    for (const smr of ['azure-openai', 'azure', 'openai_compat', 'lm-studio', 'llama-cpp', 'ollama', 'vllm', 'openai', 'anthropic', 'bedrock', 'vertex']) {
      expect(KNOWN_PROVIDERS).toContain(toLedgerProvider(smr));
    }
  });

  it('passes an unknown provider through lowercased rather than dropping the usage', () => {
    // A tenant admin can create a connection at runtime. Failing closed here
    // would lose real money to protect a naming convention.
    expect(toLedgerProvider('Some-New-Server')).toBe('some-new-server');
  });
});

describe('parseSmrUsageDetail', () => {
  it('reads the block SMR puts on the response', () => {
    const parsed = parseSmrUsageDetail(detail());

    expect(parsed).not.toBeNull();
    expect(parsed!.taskId).toBe('task-1');
    expect(parsed!.endpointKind).toBe('openai.chat');
    expect(parsed!.occurredAt.toISOString()).toBe(OCCURRED_AT);
  });

  it('returns null for a response that carries no usage block', () => {
    expect(parseSmrUsageDetail(undefined)).toBeNull();
    expect(parseSmrUsageDetail({})).toBeNull();
    expect(parseSmrUsageDetail({ task_id: 'x' })).toBeNull(); // no endpoint kind
  });

  it('rejects an endpoint kind the normalizer does not know', () => {
    // Better to record nothing than to guess between inclusive and exclusive
    // input arithmetic — that coin flip lands on an invoice.
    expect(parseSmrUsageDetail(detail({ endpoint_kind: 'made.up' }))).toBeNull();
  });

  it('falls back to now when the timestamp is unusable', () => {
    const parsed = parseSmrUsageDetail(detail({ occurred_at: 'not-a-date' }));
    expect(parsed!.occurredAt.getTime()).not.toBeNaN();
  });
});

describe('buildLlmUsageInput', () => {
  it('emits one row per non-zero unit under a single request-derived key', () => {
    const input = buildLlmUsageInput({
      usage: parseSmrUsageDetail(detail())!,
      tenantId: 'tenant-1',
      operation: 'generate',
      consultationId: 'consult-1',
      doctorId: 'doc-1',
      departmentId: 'dept-1',
    })!;

    expect(input.common.idempotencyKey).toBe('llm:task-1');
    expect(input.common.capability).toBe(AiCapability.LLM);
    expect(input.common.operation).toBe('generate');
    expect(input.common.provider).toBe('openai');
    expect(input.common.model).toBe('gpt-5');
    expect(input.common.deployment).toBe(AiDeploymentKind.CLOUD);
    expect(input.common.costBasis).toBe(AiCostBasis.INTERNAL);
    expect(input.common.consultationId).toBe('consult-1');
    expect(input.common.doctorId).toBe('doc-1');
    expect(input.common.departmentId).toBe('dept-1');
    expect(input.common.requestId).toBe('task-1');
    expect(input.common.attributesJson).toMatchObject({ endpointKind: 'openai.chat', interrupted: false });

    expect(input.units).toEqual([
      { unit: AiUsageUnit.INPUT_TOKEN, quantity: 100 },
      { unit: AiUsageUnit.OUTPUT_TOKEN, quantity: 20 },
    ]);
  });

  it('splits the cache and reasoning counters apart — they are priced separately', () => {
    const input = buildLlmUsageInput({
      usage: parseSmrUsageDetail(
        detail({
          provider: 'openai',
          endpoint_kind: 'openai.chat',
          raw: {
            prompt_tokens: 1000,
            completion_tokens: 50,
            prompt_tokens_details: { cached_tokens: 900 },
            completion_tokens_details: { reasoning_tokens: 20 },
          },
        }),
      )!,
      tenantId: 'tenant-1',
      operation: 'generate',
    })!;

    // OpenAI reports input INCLUSIVE of cache — 1000 - 900 = 100 uncached.
    expect(input.units).toEqual([
      { unit: AiUsageUnit.INPUT_TOKEN, quantity: 100 },
      { unit: AiUsageUnit.OUTPUT_TOKEN, quantity: 30 },
      { unit: AiUsageUnit.CACHE_READ_TOKEN, quantity: 900 },
      { unit: AiUsageUnit.REASONING_TOKEN, quantity: 20 },
    ]);
  });

  it('passes Anthropic exclusive input through untouched', () => {
    const input = buildLlmUsageInput({
      usage: parseSmrUsageDetail(
        detail({
          provider: 'anthropic',
          model: 'claude-sonnet-5',
          endpoint_kind: 'anthropic.messages',
          raw: {
            input_tokens: 200,
            output_tokens: 90,
            cache_read_input_tokens: 1800,
            cache_creation_input_tokens: 400,
            cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 0 },
          },
        }),
      )!,
      tenantId: 'tenant-1',
      operation: 'generate.stream',
    })!;

    expect(input.common.provider).toBe('anthropic');
    expect(input.units).toEqual([
      { unit: AiUsageUnit.INPUT_TOKEN, quantity: 200 },
      { unit: AiUsageUnit.OUTPUT_TOKEN, quantity: 90 },
      { unit: AiUsageUnit.CACHE_READ_TOKEN, quantity: 1800 },
      { unit: AiUsageUnit.CACHE_WRITE_TOKEN, quantity: 400 },
    ]);
    // The 5m/1h split changes the cache-write multiplier (x1.25 vs x2.00).
    expect(input.common.attributesJson).toMatchObject({ cacheTtl: 'ephemeral_5m' });
  });

  it('marks a BYOK call BYOK_NOTIONAL so platform-spend rollups exclude it', () => {
    const input = buildLlmUsageInput({
      usage: parseSmrUsageDetail(detail({ byok: true, provider: 'anthropic', endpoint_kind: 'anthropic.messages' }))!,
      tenantId: 'tenant-1',
      operation: 'generate',
    })!;

    expect(input.common.deployment).toBe(AiDeploymentKind.BYOK);
    expect(input.common.costBasis).toBe(AiCostBasis.BYOK_NOTIONAL);
  });

  it('A PLATFORM-FUNDED cloud call is CLOUD + INTERNAL, not BYOK', () => {
    // The gateway injected `provider_overrides` for this call — but from the
    // SYSTEM-tenant platform default, not the tenant's own credential. SMR is
    // told which it was via `provider_overrides[<provider>].funding` and
    // reports `byok: false`, so the economics land here as ordinary
    // platform-funded cloud spend (OD-2: no new AiDeploymentKind member).
    //
    // Pinning test: the DECISION lives in SMR's `_used_byok_credential`
    // (`apps/smr/.../generate.py`, tested there). What this pins is the
    // consequence — that `byok: false` on a cloud provider yields a costBasis
    // the drainer will actually accumulate. Stamped BYOK instead, this call
    // would contribute 0 to every COGS rollup and resolve the baseline SELL
    // price rather than the managed-vendor row.
    const input = buildLlmUsageInput({
      usage: parseSmrUsageDetail(detail({ byok: false, provider: 'azure-openai', endpoint_kind: 'openai.chat' }))!,
      tenantId: 'tenant-1',
      operation: 'generate',
    })!;

    expect(input.common.provider).toBe('azure');
    expect(input.common.deployment).toBe(AiDeploymentKind.CLOUD);
    expect(input.common.costBasis).toBe(AiCostBasis.INTERNAL);
  });

  it('classifies a self-hosted engine as SELF_HOSTED, not CLOUD', () => {
    const input = buildLlmUsageInput({
      usage: parseSmrUsageDetail(detail({ provider: 'lm-studio', endpoint_kind: 'lmstudio.chat' }))!,
      tenantId: 'tenant-1',
      operation: 'generate',
    })!;

    expect(input.common.deployment).toBe(AiDeploymentKind.SELF_HOSTED);
  });

  it('marks an interrupted stream without changing the idempotency key', () => {
    const completed = buildLlmUsageInput({
      usage: parseSmrUsageDetail(detail())!,
      tenantId: 'tenant-1',
      operation: 'generate.stream',
    })!;
    const aborted = buildLlmUsageInput({
      usage: parseSmrUsageDetail(detail({ interrupted: true }))!,
      tenantId: 'tenant-1',
      operation: 'generate.stream',
    })!;

    // The SAME key. An `...:aborted` variant would bill the stream twice — the
    // exact failure the abort path exists to prevent.
    expect(aborted.common.idempotencyKey).toBe(completed.common.idempotencyKey);
    expect(aborted.common.attributesJson).toMatchObject({ interrupted: true });
  });

  it('records nothing at all when every counter is zero', () => {
    const input = buildLlmUsageInput({
      usage: parseSmrUsageDetail(detail({ prompt_tokens: 0, completion_tokens: 0, raw: null }))!,
      tenantId: 'tenant-1',
      operation: 'generate',
    });

    expect(input).toBeNull();
  });

  it('falls back to the headline counts when the provider sent no raw usage', () => {
    const input = buildLlmUsageInput({
      usage: parseSmrUsageDetail(detail({ raw: null }))!,
      tenantId: 'tenant-1',
      operation: 'generate',
    })!;

    expect(input.units).toEqual([
      { unit: AiUsageUnit.INPUT_TOKEN, quantity: 100 },
      { unit: AiUsageUnit.OUTPUT_TOKEN, quantity: 20 },
    ]);
  });

  it('carries the provider-reported service tier (a batch tier is ~50% off)', () => {
    const input = buildLlmUsageInput({
      usage: parseSmrUsageDetail(detail({ service_tier: 'batch' }))!,
      tenantId: 'tenant-1',
      operation: 'generate',
    })!;

    expect(input.common.attributesJson).toMatchObject({ serviceTier: 'batch' });
  });
});

describe('buildGuardrailUsageInput', () => {
  it('emits guardrail.validate rows under a guardrail-prefixed key', () => {
    const input = buildGuardrailUsageInput({
      usage: parseSmrUsageDetail(
        detail({
          task_id: 'guardrail-req-9',
          provider: 'lm-studio',
          model: 'granite-guardian',
          endpoint_kind: 'lmstudio.chat',
          prompt_tokens: 300,
          completion_tokens: 4,
          raw: { prompt_tokens: 300, completion_tokens: 4 },
        }),
      )!,
      tenantId: 'tenant-1',
      consultationId: 'consult-1',
    })!;

    expect(input.common.idempotencyKey).toBe('guardrail:guardrail-req-9');
    expect(input.common.operation).toBe('guardrail.validate');
    expect(input.common.provider).toBe('lm-studio');
    expect(input.common.consultationId).toBe('consult-1');
    expect(input.units).toEqual([
      { unit: AiUsageUnit.INPUT_TOKEN, quantity: 300 },
      { unit: AiUsageUnit.OUTPUT_TOKEN, quantity: 4 },
    ]);
  });

  it('falls back to the parent request id when guardrail reported none', () => {
    const input = buildGuardrailUsageInput({
      // Guardrail does not mint request ids of its own, so neither field is set.
      usage: parseSmrUsageDetail(detail({ task_id: '', request_id: '' }))!,
      tenantId: 'tenant-1',
      fallbackRequestId: 'parent-task-7',
    })!;

    expect(input.common.idempotencyKey).toBe('guardrail:parent-task-7');
  });
});

// Context.service.ts#addRawSummary is a WRITE
// PATH THAT NEVER CALLS SMR ITSELF (confirmed: zero httpService/axios
// references in that file). It exists to persist a summary + bare
// inputTokens/outputTokens the CALLER already computed, so there is no real
// SmrUsageDetail — no provider, no endpointKind, no raw provider payload.
// buildLlmUsageInput requires all of that (and would force a fabricated
// endpointKind onto attributesJson, misrepresenting an API shape that never
// happened), so this is a separate, honest, minimal builder for that one
// case: reuses UsageIdempotencyKey/toUsageUnitQuantities, no forked logic.
describe('buildLlmUsageInputFromTokenCounts', () => {
  it('emits INPUT_TOKEN + OUTPUT_TOKEN rows keyed to the supplied requestId, with no fabricated attributesJson', () => {
    const input = buildLlmUsageInputFromTokenCounts({
      tenantId: 'tenant-1',
      operation: 'generate',
      requestId: 'req-compat-1',
      provider: 'none',
      model: 'gpt-4',
      deployment: AiDeploymentKind.CLOUD,
      occurredAt: new Date(OCCURRED_AT),
      inputTokens: 1500,
      outputTokens: 500,
      consultationId: 'consult-1',
      doctorId: 'doc-1',
      departmentId: 'dept-1',
    })!;

    expect(input.common).toMatchObject({
      tenantId: 'tenant-1',
      idempotencyKey: 'llm:req-compat-1',
      operation: 'generate',
      capability: AiCapability.LLM,
      provider: 'none',
      model: 'gpt-4',
      deployment: AiDeploymentKind.CLOUD,
      consultationId: 'consult-1',
      doctorId: 'doc-1',
      departmentId: 'dept-1',
      requestId: 'req-compat-1',
      attributesJson: { interrupted: false },
    });
    expect(input.units).toEqual([
      { unit: AiUsageUnit.INPUT_TOKEN, quantity: 1500 },
      { unit: AiUsageUnit.OUTPUT_TOKEN, quantity: 500 },
    ]);
  });

  it('records nothing at all when both counts are zero/absent (no work billed)', () => {
    expect(
      buildLlmUsageInputFromTokenCounts({
        tenantId: 'tenant-1',
        operation: 'generate',
        requestId: 'req-empty',
        provider: 'none',
        model: null,
        deployment: AiDeploymentKind.CLOUD,
        occurredAt: new Date(OCCURRED_AT),
      }),
    ).toBeNull();
  });

  it('drops a zero unit but keeps the non-zero one', () => {
    const input = buildLlmUsageInputFromTokenCounts({
      tenantId: 'tenant-1',
      operation: 'generate',
      requestId: 'req-input-only',
      provider: 'none',
      model: null,
      deployment: AiDeploymentKind.CLOUD,
      occurredAt: new Date(OCCURRED_AT),
      inputTokens: 200,
    })!;

    expect(input.units).toEqual([{ unit: AiUsageUnit.INPUT_TOKEN, quantity: 200 }]);
  });
});
