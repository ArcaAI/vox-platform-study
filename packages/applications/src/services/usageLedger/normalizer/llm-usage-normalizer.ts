import { AiUsageUnit } from '@arcaai/domains';

/**
 * Provider usage-object normalizer (TASK-615 WS-B, research-findings.md §3).
 *
 * Every LLM vendor reports token usage in a different shape, and — worse — with
 * different ARITHMETIC. Two providers can return the identical field name and
 * mean different things by it. This module is the single place that knows the
 * difference, so no emitter ever has to.
 *
 * ============================================================================
 * THE CONTRACT: the five counters are DISJOINT.
 * ============================================================================
 *
 *   billable input  = inputTokens + cacheReadTokens + cacheWriteTokens
 *   billable output = outputTokens + reasoningTokens
 *
 * `inputTokens` is the UNCACHED input; `outputTokens` EXCLUDES reasoning. The
 * ledger emits one row per unit and prices each separately (a cache read costs
 * ~10% of an input token), so overlapping counters would double-stamp every
 * row. Providers that report inclusively (OpenAI, Gemini) get the overlap
 * subtracted here; providers that report exclusively (Anthropic, Bedrock) are
 * passed through untouched. Use {@link totalInputTokens} /
 * {@link totalOutputTokens} when you want the pre-split totals back.
 *
 * BRANCH ON THE ENDPOINT, NEVER ON THE MODEL. Gemini API and Vertex AI serve
 * the same models and return the same field names with opposite meanings for
 * `candidatesTokenCount`; a model-name heuristic gets that wrong 100% of the
 * time for one of the two.
 *
 * PURE. No I/O, no clock, no DI — so it can be exhaustively golden-tested and
 * called from anywhere (gateway proxy, stream teardown, an abort handler).
 */

/**
 * The API SHAPE that produced a usage object.
 *
 * This is the discriminator for every arithmetic decision below. It is
 * deliberately NOT the provider: `openai.chat` is what OpenAI, Azure OpenAI,
 * vLLM, LM Studio and llama.cpp-in-OpenAI-mode all speak, while `gemini.generate`
 * and `vertex.generate` are two different arithmetics over one wire format.
 */
export type LlmEndpointKind =
  | 'openai.chat'
  | 'openai.responses'
  | 'anthropic.messages'
  | 'bedrock.converse'
  | 'gemini.generate'
  | 'vertex.generate'
  | 'ollama.native'
  | 'llamacpp.native'
  | 'lmstudio.chat';

/** The frozen list, for validation and for the contract doc. */
export const LLM_ENDPOINT_KINDS: readonly LlmEndpointKind[] = [
  'openai.chat',
  'openai.responses',
  'anthropic.messages',
  'bedrock.converse',
  'gemini.generate',
  'vertex.generate',
  'ollama.native',
  'llamacpp.native',
  'lmstudio.chat',
] as const;

/** Disjoint token counters — see the module header. */
export interface NormalizedLlmUsage {
  /** Input tokens that were NOT served from cache. */
  inputTokens: number;
  /** Generated tokens EXCLUDING reasoning/thinking tokens. */
  outputTokens: number;
  /** Input tokens served from a prompt cache (billed at a steep discount). */
  cacheReadTokens: number;
  /** Input tokens written INTO a prompt cache (billed at a premium). */
  cacheWriteTokens: number;
  /** Reasoning / thinking tokens. Billed as output everywhere, priced separately here. */
  reasoningTokens: number;
}

const ZERO_USAGE: NormalizedLlmUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
});

/**
 * Normalize one provider usage object into the five disjoint counters.
 *
 * @param provider  Canonical provider id (`openai`, `anthropic`, `bedrock`,
 *                  `vertex`, `ollama`, `lm-studio`, `llama-cpp`, `vllm`, ...).
 *                  Recorded for provenance and available to future
 *                  provider-specific quirk handling; the ARITHMETIC is chosen
 *                  by `endpointKind` alone, deliberately.
 * @param endpointKind The API shape that produced `rawUsage`.
 * @param rawUsage  The provider's usage object, or the whole response envelope
 *                  (a nested `usage` / `usageMetadata` is unwrapped for you).
 *                  `null`/`undefined` yields all-zero — a stream that never
 *                  delivered usage must not crash a teardown handler.
 *
 * @throws when `endpointKind` is not a known kind. Guessing between inclusive
 *         and exclusive input arithmetic is a coin flip that lands on an
 *         invoice; a throw lands in the emitter lane's own test run.
 */
export function normalizeLlmUsage(provider: string, endpointKind: LlmEndpointKind, rawUsage: unknown): NormalizedLlmUsage {
  if (!LLM_ENDPOINT_KINDS.includes(endpointKind)) {
    throw new Error(`normalizeLlmUsage: unknown endpoint kind "${String(endpointKind)}" (provider "${provider}")`);
  }
  if (rawUsage === null || rawUsage === undefined || typeof rawUsage !== 'object') {
    return { ...ZERO_USAGE };
  }

  const container = rawUsage as Record<string, unknown>;
  const usage = unwrapUsage(container);

  switch (endpointKind) {
    case 'openai.chat':
    case 'lmstudio.chat':
      return fromOpenAiChat(usage);

    case 'openai.responses':
      return fromOpenAiResponses(usage);

    case 'anthropic.messages':
      return fromAnthropic(usage);

    case 'bedrock.converse':
      return fromBedrock(usage);

    case 'gemini.generate':
      // `candidatesTokenCount` INCLUDES `thoughtsTokenCount`.
      return fromGoogle(usage, /* candidatesIncludeThoughts */ true);

    case 'vertex.generate':
      // `candidatesTokenCount` EXCLUDES `thoughtsTokenCount` — the same field,
      // the opposite meaning. This one line is the whole Vertex/Gemini trap.
      return fromGoogle(usage, /* candidatesIncludeThoughts */ false);

    case 'ollama.native':
      return clamp({
        ...ZERO_USAGE,
        inputTokens: num(usage.prompt_eval_count),
        outputTokens: num(usage.eval_count),
      });

    case 'llamacpp.native':
      return fromLlamaCpp(container, usage);
  }
}

/**
 * The billable input total, re-assembled from the disjoint counters.
 *
 * This is the number an Anthropic invoice line shows as "input"; the ledger
 * keeps the three parts apart because they carry three different prices.
 */
export function totalInputTokens(usage: NormalizedLlmUsage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/** The billable output total (reasoning bills as output at every vendor). */
export function totalOutputTokens(usage: NormalizedLlmUsage): number {
  return usage.outputTokens + usage.reasoningTokens;
}

/**
 * Anthropic's cache-write TTL breakdown, when the provider sent one.
 *
 * A 5-minute cache write costs x1.25 of base input; a 1-hour write costs x2.00.
 * The flat `cache_creation_input_tokens` field cannot tell them apart, and the
 * ledger has a single `CACHE_WRITE_TOKEN` unit — so the split is surfaced here
 * for `attributesJson.cacheTtl` (and for a future price dimension) rather than
 * being silently averaged into one number.
 *
 * @returns the split, or `null` when the provider reported no breakdown.
 */
export function anthropicCacheTtlSplit(rawUsage: unknown): { ephemeral5m: number; ephemeral1h: number } | null {
  if (!rawUsage || typeof rawUsage !== 'object') return null;
  const usage = unwrapUsage(rawUsage as Record<string, unknown>);
  const creation = usage.cache_creation;
  if (!creation || typeof creation !== 'object') return null;
  const split = creation as Record<string, unknown>;
  const ephemeral5m = num(split.ephemeral_5m_input_tokens);
  const ephemeral1h = num(split.ephemeral_1h_input_tokens);
  if (ephemeral5m === 0 && ephemeral1h === 0) return null;
  return { ephemeral5m, ephemeral1h };
}

/**
 * Collapse a stream's usage-bearing chunks into ONE authoritative usage object.
 *
 * Two incompatible conventions are in play:
 *   - **Anthropic** sends input/cache counts once in `message_start` and then a
 *     CUMULATIVE `output_tokens` on every `message_delta`. Summing the deltas
 *     multiplies the bill; the LAST delta is the answer.
 *   - **Everyone else** sends usage exactly once, in a trailing chunk (OpenAI
 *     only when `stream_options.include_usage` was requested). Last non-empty
 *     wins.
 *
 * Both branches are abort-safe by construction: whatever chunks were observed
 * before the client hung up still reduce to the usage seen so far, which is
 * exactly what the abort path must emit (the TASK-470/471 bug class).
 *
 * @returns the raw usage object to feed {@link normalizeLlmUsage}, or `null`
 *          when the stream carried no usage at all.
 */
export function reduceStreamingUsage(endpointKind: LlmEndpointKind, chunks: readonly unknown[]): unknown {
  if (!Array.isArray(chunks) || chunks.length === 0) return null;

  if (endpointKind === 'anthropic.messages') {
    let base: Record<string, unknown> | null = null;
    let latestOutputTokens: number | null = null;

    for (const chunk of chunks) {
      if (!chunk || typeof chunk !== 'object') continue;
      const record = chunk as Record<string, unknown>;

      // `message_start` carries the input/cache counts for the whole request.
      const startUsage = asRecord(asRecord(record.message)?.usage);
      if (startUsage) base = { ...startUsage };

      // Every `message_delta` restates the cumulative output count.
      const deltaUsage = asRecord(record.usage);
      if (deltaUsage && deltaUsage.output_tokens !== undefined && deltaUsage.output_tokens !== null) {
        latestOutputTokens = num(deltaUsage.output_tokens);
      }
    }

    if (base === null && latestOutputTokens === null) return null;
    return { ...(base ?? {}), ...(latestOutputTokens === null ? {} : { output_tokens: latestOutputTokens }) };
  }

  // Last chunk that actually carried a usage object wins.
  for (let i = chunks.length - 1; i >= 0; i--) {
    const chunk = chunks[i];
    if (!chunk || typeof chunk !== 'object') continue;
    const record = chunk as Record<string, unknown>;
    if (asRecord(record.usage) || asRecord(record.usageMetadata) || asRecord(record.timings)) return record;
    // A bare usage object (not wrapped in an envelope) also counts.
    if (hasAnyUsageField(record)) return record;
  }
  return null;
}

/**
 * Project the normalized counters onto `(unit, quantity)` pairs ready for
 * `IUsageLedgerService.recordUsage`.
 *
 * Zero-quantity units are DROPPED: most requests use no cache and no reasoning
 * tokens, so emitting them would triple the ledger's row count to record
 * "nothing happened". A unit that is genuinely zero-but-meaningful (a REQUEST
 * count, say) is emitted explicitly by its own caller, not through here.
 */
export function toUsageUnitQuantities(usage: NormalizedLlmUsage): Array<{ unit: AiUsageUnit; quantity: number }> {
  const pairs: Array<{ unit: AiUsageUnit; quantity: number }> = [
    { unit: AiUsageUnit.INPUT_TOKEN, quantity: usage.inputTokens },
    { unit: AiUsageUnit.OUTPUT_TOKEN, quantity: usage.outputTokens },
    { unit: AiUsageUnit.CACHE_READ_TOKEN, quantity: usage.cacheReadTokens },
    { unit: AiUsageUnit.CACHE_WRITE_TOKEN, quantity: usage.cacheWriteTokens },
    { unit: AiUsageUnit.REASONING_TOKEN, quantity: usage.reasoningTokens },
  ];
  return pairs.filter((pair) => pair.quantity > 0);
}

// ── per-shape extraction ────────────────────────────────────────────────────

/** OpenAI Chat Completions (and every OpenAI-compatible server). INPUT IS INCLUSIVE. */
function fromOpenAiChat(usage: Record<string, unknown>): NormalizedLlmUsage {
  const promptDetails = asRecord(usage.prompt_tokens_details);
  const completionDetails = asRecord(usage.completion_tokens_details);

  const cacheReadTokens = num(promptDetails?.cached_tokens);
  const cacheWriteTokens = num(promptDetails?.cache_write_tokens ?? usage.cache_creation_input_tokens);
  const reasoningTokens = num(completionDetails?.reasoning_tokens);

  return clamp({
    inputTokens: num(usage.prompt_tokens) - cacheReadTokens - cacheWriteTokens,
    outputTokens: num(usage.completion_tokens) - reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
  });
}

/** OpenAI Responses API — same arithmetic, different field names. */
function fromOpenAiResponses(usage: Record<string, unknown>): NormalizedLlmUsage {
  const inputDetails = asRecord(usage.input_tokens_details);
  const outputDetails = asRecord(usage.output_tokens_details);

  const cacheReadTokens = num(inputDetails?.cached_tokens);
  const cacheWriteTokens = num(inputDetails?.cache_write_tokens);
  const reasoningTokens = num(outputDetails?.reasoning_tokens);

  return clamp({
    inputTokens: num(usage.input_tokens) - cacheReadTokens - cacheWriteTokens,
    outputTokens: num(usage.output_tokens) - reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
  });
}

/**
 * Anthropic Messages. INPUT IS EXCLUSIVE — `input_tokens` already has the cache
 * counts taken out, so subtracting again would zero out cache-heavy requests.
 */
function fromAnthropic(usage: Record<string, unknown>): NormalizedLlmUsage {
  const ttlSplit = anthropicCacheTtlSplit(usage);
  const flatCacheWrite = usage.cache_creation_input_tokens;

  return clamp({
    inputTokens: num(usage.input_tokens),
    // Thinking tokens are not broken out — they are already inside output_tokens.
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheWriteTokens:
      flatCacheWrite !== undefined && flatCacheWrite !== null ? num(flatCacheWrite) : ttlSplit ? ttlSplit.ephemeral5m + ttlSplit.ephemeral1h : 0,
    reasoningTokens: 0,
  });
}

/** Bedrock Converse — Anthropic's exclusive arithmetic, camelCase field names. */
function fromBedrock(usage: Record<string, unknown>): NormalizedLlmUsage {
  return clamp({
    inputTokens: num(usage.inputTokens),
    outputTokens: num(usage.outputTokens),
    cacheReadTokens: num(usage.cacheReadInputTokens),
    cacheWriteTokens: num(usage.cacheWriteInputTokens),
    reasoningTokens: 0,
  });
}

/**
 * Google — Gemini API and Vertex AI share the wire format and disagree on one
 * thing: whether `candidatesTokenCount` already contains `thoughtsTokenCount`.
 * `promptTokenCount` is inclusive of cached content on BOTH.
 */
function fromGoogle(usage: Record<string, unknown>, candidatesIncludeThoughts: boolean): NormalizedLlmUsage {
  const cacheReadTokens = num(usage.cachedContentTokenCount);
  const reasoningTokens = num(usage.thoughtsTokenCount);
  const candidates = num(usage.candidatesTokenCount);

  return clamp({
    inputTokens: num(usage.promptTokenCount) - cacheReadTokens,
    outputTokens: candidatesIncludeThoughts ? candidates - reasoningTokens : candidates,
    cacheReadTokens,
    cacheWriteTokens: 0,
    reasoningTokens,
  });
}

/**
 * llama.cpp server. Prefers the OpenAI-shaped `usage` block when present.
 *
 * The `timings` fallback is NOT equivalent: `timings.prompt_n` counts only the
 * NON-CACHED prompt portion, so it silently under-reports whenever the server's
 * prompt cache hits. It is used only when the server sent no `usage` at all.
 */
function fromLlamaCpp(container: Record<string, unknown>, usage: Record<string, unknown>): NormalizedLlmUsage {
  if (hasAnyUsageField(usage)) return fromOpenAiChat(usage);

  const timings = asRecord(container.timings) ?? asRecord(usage.timings);
  if (!timings) return { ...ZERO_USAGE };

  return clamp({
    ...ZERO_USAGE,
    inputTokens: num(timings.prompt_n),
    outputTokens: num(timings.predicted_n),
  });
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Accept either a bare usage object or a full response envelope.
 *
 * Emitters hold a response, not a usage object, and forcing every call site to
 * remember whether its provider nests under `usage` or `usageMetadata` is
 * exactly the kind of per-lane detail this module exists to absorb.
 */
function unwrapUsage(container: Record<string, unknown>): Record<string, unknown> {
  return asRecord(container.usage) ?? asRecord(container.usageMetadata) ?? container;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Any recognisable token field — used to tell "usage present" from "envelope". */
function hasAnyUsageField(record: Record<string, unknown>): boolean {
  return (
    record.prompt_tokens !== undefined ||
    record.completion_tokens !== undefined ||
    record.input_tokens !== undefined ||
    record.output_tokens !== undefined ||
    record.inputTokens !== undefined ||
    record.outputTokens !== undefined ||
    record.promptTokenCount !== undefined ||
    record.candidatesTokenCount !== undefined ||
    record.prompt_eval_count !== undefined ||
    record.eval_count !== undefined
  );
}

/**
 * Coerce a reported count to a non-negative finite integer.
 *
 * Providers send `null` for fields they do not populate (vLLM V1's broken
 * `cached_tokens` is the documented example) and occasionally a numeric string.
 * `NaN` must never reach the ledger — the entity rejects a non-numeric quantity
 * and the whole event would be lost.
 */
function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0;
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.round(parsed);
}

/**
 * Floor every counter at zero.
 *
 * A negative counter means the provider's own arithmetic disagreed with ours
 * (a partial usage object, a new field we do not read yet). Under-reporting one
 * unit is recoverable via reconciliation; a negative quantity throws in
 * `AiUsageEventEntity.validate()` and takes the ENTIRE event down with it.
 */
function clamp(usage: NormalizedLlmUsage): NormalizedLlmUsage {
  return {
    inputTokens: Math.max(0, usage.inputTokens),
    outputTokens: Math.max(0, usage.outputTokens),
    cacheReadTokens: Math.max(0, usage.cacheReadTokens),
    cacheWriteTokens: Math.max(0, usage.cacheWriteTokens),
    reasoningTokens: Math.max(0, usage.reasoningTokens),
  };
}
