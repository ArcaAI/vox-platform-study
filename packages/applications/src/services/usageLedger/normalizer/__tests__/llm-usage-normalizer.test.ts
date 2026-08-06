/**
 * Provider usage-object normalizer — golden tests.
 *
 * These are the FROZEN semantics wave-1 emitters (WS-D, WS-F) code against.
 * Every case below is one of the five defects research-findings.md §3 ranks as
 * most likely to corrupt a meter; a green suite here is the only thing standing
 * between a cached Anthropic request and a 10x mis-bill.
 *
 * THE CONTRACT IN ONE LINE: the five returned counters are DISJOINT. Their sum
 * is the whole billable request. `inputTokens` never contains cache tokens and
 * `outputTokens` never contains reasoning tokens, REGARDLESS of whether the
 * provider reported them inclusively or exclusively — that is the entire point
 * of the normalizer, because the ledger emits one row per unit and overlapping
 * counters would double-stamp every one of them.
 */

import { describe, expect, it } from 'vitest';

import {
  anthropicCacheTtlSplit,
  normalizeLlmUsage,
  reduceStreamingUsage,
  toUsageUnitQuantities,
  totalInputTokens,
  totalOutputTokens,
} from '../llm-usage-normalizer';
import { AiUsageUnit } from '@arcaai/domains';

const ZERO = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

describe('normalizeLlmUsage — OpenAI chat completions (INCLUSIVE input)', () => {
  it('subtracts cached tokens out of prompt_tokens so the counters stay disjoint', () => {
    // prompt_tokens INCLUDES the 900 cached tokens. Emitting 1000 INPUT_TOKEN
    // rows AND 900 CACHE_READ_TOKEN rows would bill 1900 for a 1000-token prompt.
    const usage = {
      prompt_tokens: 1000,
      completion_tokens: 200,
      total_tokens: 1200,
      prompt_tokens_details: { cached_tokens: 900 },
    };

    expect(normalizeLlmUsage('openai', 'openai.chat', usage)).toEqual({
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    });
  });

  it('subtracts reasoning tokens out of completion_tokens', () => {
    const usage = {
      prompt_tokens: 50,
      completion_tokens: 500,
      completion_tokens_details: { reasoning_tokens: 400 },
    };

    const result = normalizeLlmUsage('azure', 'openai.chat', usage);
    expect(result.outputTokens).toBe(100);
    expect(result.reasoningTokens).toBe(400);
    // Sum is preserved — nothing invented, nothing lost.
    expect(totalOutputTokens(result)).toBe(500);
  });

  it('never returns a negative counter when a provider under-reports the total', () => {
    // Defensive: a broken/partial usage object must degrade to 0, never to a
    // negative quantity (the entity validator rejects those, which would throw
    // away the whole event).
    const usage = { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 99 }, completion_tokens: 0 };
    const result = normalizeLlmUsage('vllm', 'openai.chat', usage);
    expect(result.inputTokens).toBe(0);
    expect(result.cacheReadTokens).toBe(99);
  });

  it('treats a missing usage object as all-zero rather than throwing', () => {
    expect(normalizeLlmUsage('openai', 'openai.chat', undefined)).toEqual(ZERO);
    expect(normalizeLlmUsage('openai', 'openai.chat', null)).toEqual(ZERO);
  });

  it('unwraps a full response envelope (usage nested under `usage`)', () => {
    const response = { id: 'chatcmpl-1', usage: { prompt_tokens: 7, completion_tokens: 3 } };
    expect(normalizeLlmUsage('openai', 'openai.chat', response)).toMatchObject({ inputTokens: 7, outputTokens: 3 });
  });

  it('vLLM V1 reports cached_tokens as null — that degrades to 0, not NaN', () => {
    const usage = { prompt_tokens: 120, completion_tokens: 8, prompt_tokens_details: { cached_tokens: null } };
    expect(normalizeLlmUsage('vllm', 'openai.chat', usage)).toMatchObject({ inputTokens: 120, cacheReadTokens: 0 });
  });
});

describe('normalizeLlmUsage — OpenAI Responses API', () => {
  it('reads the input_tokens/output_tokens field names and keeps them disjoint', () => {
    const usage = {
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 250 },
      output_tokens: 300,
      output_tokens_details: { reasoning_tokens: 120 },
    };

    expect(normalizeLlmUsage('openai', 'openai.responses', usage)).toEqual({
      inputTokens: 750,
      outputTokens: 180,
      cacheReadTokens: 250,
      cacheWriteTokens: 0,
      reasoningTokens: 120,
    });
  });
});

describe('normalizeLlmUsage — Anthropic (EXCLUSIVE input)', () => {
  it('does NOT subtract cache tokens: input_tokens already excludes them', () => {
    // The mirror image of the OpenAI case. Applying the OpenAI arithmetic here
    // would bill 100 - 900 -> 0 input tokens for a request that really consumed
    // 100 uncached + 900 cached.
    const usage = {
      input_tokens: 100,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 40,
      output_tokens: 200,
    };

    const result = normalizeLlmUsage('anthropic', 'anthropic.messages', usage);
    expect(result).toEqual({
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 900,
      cacheWriteTokens: 40,
      reasoningTokens: 0,
    });
    // Documented derivation: total input = input + cache_read + cache_creation.
    expect(totalInputTokens(result)).toBe(1040);
  });

  it('falls back to the TTL breakdown when the flat cache_creation_input_tokens is absent', () => {
    const usage = {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 700 },
    };
    expect(normalizeLlmUsage('anthropic', 'anthropic.messages', usage).cacheWriteTokens).toBe(1000);
  });

  it('exposes the 5m/1h split separately — the two write rates differ (x1.25 vs x2.00)', () => {
    const usage = {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 700 },
    };
    expect(anthropicCacheTtlSplit(usage)).toEqual({ ephemeral5m: 300, ephemeral1h: 700 });
  });

  it('reports no TTL split when the provider did not send one', () => {
    expect(anthropicCacheTtlSplit({ input_tokens: 1, output_tokens: 1 })).toBeNull();
  });

  it('does not invent a reasoning counter — Anthropic folds thinking into output', () => {
    const result = normalizeLlmUsage('anthropic', 'anthropic.messages', { input_tokens: 5, output_tokens: 900 });
    expect(result.reasoningTokens).toBe(0);
    expect(result.outputTokens).toBe(900);
  });
});

describe('normalizeLlmUsage — Bedrock Converse (EXCLUSIVE input, camelCase)', () => {
  it('maps the camelCase field names and keeps input exclusive', () => {
    const usage = {
      inputTokens: 100,
      outputTokens: 200,
      totalTokens: 300,
      cacheReadInputTokens: 900,
      cacheWriteInputTokens: 40,
    };

    expect(normalizeLlmUsage('bedrock', 'bedrock.converse', usage)).toEqual({
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 900,
      cacheWriteTokens: 40,
      reasoningTokens: 0,
    });
  });
});

describe('normalizeLlmUsage — Gemini API vs Vertex AI (the same field, different arithmetic)', () => {
  const usageMetadata = {
    promptTokenCount: 1000,
    cachedContentTokenCount: 200,
    candidatesTokenCount: 500,
    thoughtsTokenCount: 300,
  };

  it('Gemini API: candidatesTokenCount INCLUDES thoughts, so reasoning is subtracted out', () => {
    expect(normalizeLlmUsage('gemini', 'gemini.generate', usageMetadata)).toEqual({
      inputTokens: 800,
      outputTokens: 200,
      cacheReadTokens: 200,
      cacheWriteTokens: 0,
      reasoningTokens: 300,
    });
    // 500 billable output tokens either way — only the split differs.
    expect(totalOutputTokens(normalizeLlmUsage('gemini', 'gemini.generate', usageMetadata))).toBe(500);
  });

  it('Vertex AI: candidatesTokenCount EXCLUDES thoughts, so nothing is subtracted', () => {
    expect(normalizeLlmUsage('vertex', 'vertex.generate', usageMetadata)).toEqual({
      inputTokens: 800,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheWriteTokens: 0,
      reasoningTokens: 300,
    });
    // Billable output is 800 here, NOT 500 — this is the whole point of
    // branching on the endpoint rather than on the model name.
    expect(totalOutputTokens(normalizeLlmUsage('vertex', 'vertex.generate', usageMetadata))).toBe(800);
  });

  it('unwraps a response envelope carrying usageMetadata', () => {
    expect(normalizeLlmUsage('vertex', 'vertex.generate', { candidates: [], usageMetadata })).toMatchObject({
      inputTokens: 800,
      outputTokens: 500,
    });
  });
});

describe('normalizeLlmUsage — self-hosted native shapes', () => {
  it('Ollama: prompt_eval_count / eval_count', () => {
    const raw = { model: 'llama3', prompt_eval_count: 26, eval_count: 298, total_duration: 5_043_500_667 };
    expect(normalizeLlmUsage('ollama', 'ollama.native', raw)).toEqual({
      inputTokens: 26,
      outputTokens: 298,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    });
  });

  it('llama.cpp: falls back to timings.prompt_n / timings.predicted_n when no usage block is present', () => {
    const raw = { timings: { prompt_n: 12, predicted_n: 34, prompt_ms: 5 } };
    expect(normalizeLlmUsage('llama-cpp', 'llamacpp.native', raw)).toMatchObject({ inputTokens: 12, outputTokens: 34 });
  });

  it('llama.cpp: prefers the OpenAI-shaped usage block when the server sends one', () => {
    // `timings.prompt_n` is the NON-CACHED prompt portion while
    // `usage.prompt_tokens` is the full prompt — they disagree by design, so
    // the richer, cache-aware block wins.
    const raw = { usage: { prompt_tokens: 100, completion_tokens: 34 }, timings: { prompt_n: 12, predicted_n: 34 } };
    expect(normalizeLlmUsage('llama-cpp', 'llamacpp.native', raw)).toMatchObject({ inputTokens: 100, outputTokens: 34 });
  });

  it('LM Studio: OpenAI-shaped usage, non-standard stats ignored', () => {
    const raw = { usage: { prompt_tokens: 40, completion_tokens: 60 }, stats: { tokens_per_second: 51.2, stop_reason: 'eosFound' } };
    expect(normalizeLlmUsage('lm-studio', 'lmstudio.chat', raw)).toMatchObject({ inputTokens: 40, outputTokens: 60 });
  });
});

describe('normalizeLlmUsage — unknown endpoint kind', () => {
  it('throws rather than guessing an arithmetic', () => {
    // Guessing means picking inclusive-or-exclusive at random. A throw surfaces
    // in the emitter lane's own tests; a guess surfaces on an invoice.
    expect(() => normalizeLlmUsage('openai', 'openai.chatt' as never, { prompt_tokens: 1 })).toThrow(/endpoint kind/i);
  });
});

describe('reduceStreamingUsage', () => {
  it('Anthropic deltas are CUMULATIVE — take the last, never the sum', () => {
    const chunks = [
      { type: 'message_start', message: { usage: { input_tokens: 25, cache_read_input_tokens: 100, output_tokens: 1 } } },
      { type: 'message_delta', usage: { output_tokens: 15 } },
      { type: 'message_delta', usage: { output_tokens: 42 } },
      { type: 'message_delta', usage: { output_tokens: 87 } },
    ];

    const raw = reduceStreamingUsage('anthropic.messages', chunks);
    const result = normalizeLlmUsage('anthropic', 'anthropic.messages', raw);

    // Summing the deltas would report 145 output tokens instead of 87.
    expect(result.outputTokens).toBe(87);
    // Input/cache come from message_start and survive the merge.
    expect(result.inputTokens).toBe(25);
    expect(result.cacheReadTokens).toBe(100);
  });

  it('an interrupted Anthropic stream still yields the usage seen so far (abort path)', () => {
    // TASK-470/471 bug class: teardown on abort must emit whatever was observed
    // rather than nothing at all.
    const chunks = [
      { type: 'message_start', message: { usage: { input_tokens: 25, output_tokens: 0 } } },
      { type: 'message_delta', usage: { output_tokens: 12 } },
    ];
    expect(normalizeLlmUsage('anthropic', 'anthropic.messages', reduceStreamingUsage('anthropic.messages', chunks))).toMatchObject({
      inputTokens: 25,
      outputTokens: 12,
    });
  });

  it('OpenAI-compatible streams: the trailing include_usage chunk wins', () => {
    const chunks = [
      { choices: [{ delta: { content: 'a' } }], usage: null },
      { choices: [{ delta: { content: 'b' } }], usage: null },
      { choices: [], usage: { prompt_tokens: 11, completion_tokens: 22 } },
    ];
    expect(normalizeLlmUsage('openai', 'openai.chat', reduceStreamingUsage('openai.chat', chunks))).toMatchObject({
      inputTokens: 11,
      outputTokens: 22,
    });
  });

  it('a stream that never delivered usage reduces to null, and normalizes to zeros', () => {
    const chunks = [{ choices: [{ delta: { content: 'a' } }] }];
    expect(reduceStreamingUsage('openai.chat', chunks)).toBeNull();
    expect(normalizeLlmUsage('openai', 'openai.chat', reduceStreamingUsage('openai.chat', chunks))).toEqual(ZERO);
  });

  it('an empty chunk list reduces to null', () => {
    expect(reduceStreamingUsage('anthropic.messages', [])).toBeNull();
  });
});

describe('toUsageUnitQuantities', () => {
  it('maps the five counters onto ledger units and drops the zeros', () => {
    const normalized = {
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 40,
      reasoningTokens: 0,
    };

    // Zero-quantity rows carry no information and would triple the ledger for
    // every provider that reports no cache/reasoning tokens.
    expect(toUsageUnitQuantities(normalized)).toEqual([
      { unit: AiUsageUnit.INPUT_TOKEN, quantity: 100 },
      { unit: AiUsageUnit.OUTPUT_TOKEN, quantity: 200 },
      { unit: AiUsageUnit.CACHE_WRITE_TOKEN, quantity: 40 },
    ]);
  });

  it('returns an empty list when nothing was consumed', () => {
    expect(toUsageUnitQuantities(ZERO)).toEqual([]);
  });
});
