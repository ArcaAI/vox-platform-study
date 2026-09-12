import { AiCapability, AiCostBasis, AiDeploymentKind } from '@arcaai/domains';

import { UsageIdempotencyKey } from '../../usageLedger/idempotency-keys';
import type { UsageEventBatchInput } from '../../usageLedger/dto';
import {
  LLM_ENDPOINT_KINDS,
  type LlmEndpointKind,
  anthropicCacheTtlSplit,
  normalizeLlmUsage,
  toUsageUnitQuantities,
} from '../../usageLedger/normalizer/llm-usage-normalizer';
import type { UsageAttributes } from '../../usageLedger/usage-attributes';
import type { UsageOperation } from '../../usageLedger/vocabulary';

/**
 * Turning an TEXT `/generate` response into ledger rows.
 *
 * TEXT answers with a `usage_detail` block (and, when a guardrail check ran, a
 * `guardrail_usage` block) on the sync path, and with the same block on the
 * terminal frame of a stream. This module is the ONE place that reads it, so
 * the sync path, the async job path and the streaming proxy all bill
 * identically.
 *
 * ============================================================================
 * TWO VOCABULARIES MEET HERE — AND MUST NOT BLEED INTO EACH OTHER
 * ============================================================================
 * TEXT names providers for its own registry: `azure-openai` (with an `azure`
 * alias), `openai_compat` (an alias for the LM Studio factory). The ledger's
 * `provider` is a ROLLUP DIMENSION whose spelling is fixed by `KNOWN_PROVIDERS`.
 * Emitting the TEXT spelling does not fail — it silently forks the dimension, so
 * one provider's cost splits across two rows nobody can reconcile afterwards.
 * {@link toLedgerProvider} is that translation, and it is golden-tested.
 */

/** The block TEXT puts on a response / terminal stream frame, after parsing. */
export interface TextUsageDetail {
  /** Stable per-generation id — the ledger's idempotency key is derived from it. */
  taskId: string;
  /** Correlation id, for log/trace joins. Never used as a billing key. */
  requestId: string | null;
  /** TEXT's OWN provider key — translate with {@link toLedgerProvider} before emitting. */
  textProvider: string;
  model: string;
  endpointKind: LlmEndpointKind;
  interrupted: boolean;
  byok: boolean;
  /**
   * TASK-958 D-7 — WHICH `AiProviderConnection` supplied the key TEXT actually used.
   *
   * `byok` says WHOSE money; this says WHICH of the tenant's accounts. A tenant may
   * hold several connections for one vendor, so `textProvider` no longer identifies
   * the credential that was spent.
   *
   * `null` does NOT mean "the platform paid": a platform-default credential comes from
   * the SYSTEM tenant's own connection row and carries THAT row's id (which is how
   * platform spend stays reconcilable against the platform's own bill). `null` means
   * no row at all — a self-hosted engine, an environment credential, or a TEXT that
   * predates the field. Never guessed from the provider name.
   */
  connectionId: string | null;
  serviceTier: string | null;
  occurredAt: Date;
  promptTokens: number;
  completionTokens: number;
  /** The provider's own usage object, in its wire shape (may be absent). */
  raw: unknown;
}

/**
 * TEXT provider key → canonical ledger provider slug.
 *
 * Only the entries that actually DIFFER are listed; everything else already
 * matches `KNOWN_PROVIDERS` and passes through.
 */
const LEDGER_PROVIDER_BY_TEXT_KEY: Readonly<Record<string, string>> = Object.freeze({
  // `azure-openai` is an TEXT *setting* value; the connection id is `azure`.
  'azure-openai': 'azure',
  azure_openai: 'azure',
  // `openai_compat` is registered as an alias of the LM Studio factory.
  openai_compat: 'lm-studio',
  lmstudio: 'lm-studio',
  llama_cpp: 'llama-cpp',
  llamacpp: 'llama-cpp',
  aws_bedrock: 'bedrock',
});

/** Providers the platform runs on its OWN hardware — the economics differ. */
const SELF_HOSTED_PROVIDERS: ReadonlySet<string> = new Set(['ollama', 'lm-studio', 'vllm', 'llama-cpp', 'built-in']);

/**
 * The ledger's deployment dimension for a CANONICAL provider slug (i.e. one that has already
 * been through {@link toLedgerProvider}).
 *
 * Exported because the two BENCH finalize paths bill from a `GET /tasks/{id}` read-back that
 * may carry no usage block at all, and they still have to answer this question. Stamping a
 * constant there — which the prompt bench did, always `CLOUD` — forks the rollup dimension:
 * every local `lm-studio` bench run landed in the cloud bucket and the self-hosted totals
 * silently under-reported.
 */
export function resolveDeployment(provider: string, byok: boolean): AiDeploymentKind {
  if (byok) return AiDeploymentKind.BYOK;
  return SELF_HOSTED_PROVIDERS.has(provider) ? AiDeploymentKind.SELF_HOSTED : AiDeploymentKind.CLOUD;
}

/**
 * Translate an TEXT provider key to the canonical ledger slug.
 *
 * An UNKNOWN provider is passed through (lower-cased to satisfy the id shape)
 * rather than rejected: a tenant admin can create an `AiProviderConnection` at
 * runtime, and failing closed here would drop real usage — real money — to
 * protect a naming convention.
 */
export function toLedgerProvider(textProvider: string): string {
  const key = (textProvider ?? '').trim().toLowerCase();
  return LEDGER_PROVIDER_BY_TEXT_KEY[key] ?? key;
}

/**
 * Read TEXT's usage block off a response (or a terminal stream frame).
 *
 * Returns `null` rather than guessing whenever the block is missing or its
 * `endpoint_kind` is one the normalizer does not know: choosing between
 * inclusive and exclusive input arithmetic on a hunch is a coin flip that lands
 * on an invoice, and a missing event is repairable from the provider's own
 * usage API while a wrong one is not.
 */
export function parseTextUsageDetail(raw: unknown): TextUsageDetail | null {
  if (!raw || typeof raw !== 'object') return null;
  const block = raw as Record<string, unknown>;

  const endpointKind = block.endpoint_kind;
  if (typeof endpointKind !== 'string' || !LLM_ENDPOINT_KINDS.includes(endpointKind as LlmEndpointKind)) {
    return null;
  }

  const occurredAt = new Date(typeof block.occurred_at === 'string' ? block.occurred_at : Date.now());

  return {
    taskId: typeof block.task_id === 'string' ? block.task_id : '',
    requestId: typeof block.request_id === 'string' && block.request_id.length > 0 ? block.request_id : null,
    textProvider: typeof block.provider === 'string' ? block.provider : '',
    model: typeof block.model === 'string' ? block.model : '',
    endpointKind: endpointKind as LlmEndpointKind,
    interrupted: block.interrupted === true,
    byok: block.byok === true,
    // A non-string, or an EMPTY string, is not an account id: it stays `null` rather
    // than being stamped on a ledger row as a connection nobody can look up.
    connectionId: typeof block.connection_id === 'string' && block.connection_id.length > 0 ? block.connection_id : null,
    serviceTier: typeof block.service_tier === 'string' && block.service_tier.length > 0 ? block.service_tier : null,
    // A malformed timestamp degrades to "now" rather than poisoning the row:
    // an `Invalid Date` fails validation and the whole event would be lost.
    occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
    promptTokens: toCount(block.prompt_tokens),
    completionTokens: toCount(block.completion_tokens),
    raw: block.raw ?? null,
  };
}

interface BuildLlmUsageParams {
  usage: TextUsageDetail;
  tenantId: string;
  operation: UsageOperation;
  consultationId?: string | null;
  doctorId?: string | null;
  departmentId?: string | null;
}

/**
 * Build the `{common, units}` batch a `generate` / `generate.stream` /
 * `presummarize` call produces.
 *
 * Returns `null` when every counter is zero — a request that consumed nothing
 * gets no rows at all rather than a row saying "nothing happened".
 */
export function buildLlmUsageInput(params: BuildLlmUsageParams): UsageEventBatchInput | null {
  const { usage, tenantId, operation } = params;

  const units = normalizeUnits(usage);
  if (units.length === 0) return null;

  const provider = toLedgerProvider(usage.textProvider);

  return {
    common: {
      tenantId,
      // The TEXT task id — stable across the completion and abort paths, so an
      // aborted stream that later also runs teardown converges on ONE billed
      // event instead of two. An `...:aborted` variant would double-bill.
      idempotencyKey: UsageIdempotencyKey.llmRequest(usage.taskId || usage.requestId || ''),
      occurredAt: usage.occurredAt,
      capability: AiCapability.LLM,
      operation,
      provider,
      model: usage.model || null,
      deployment: resolveDeployment(provider, usage.byok),
      // Explicit, never derived from `deployment`: a silently-inferred cost
      // basis makes a forgotten BYOK flag invisible.
      costBasis: usage.byok ? AiCostBasis.BYOK_NOTIONAL : AiCostBasis.INTERNAL,
      // TASK-958 D-7 — WHICH key, beside whose money. Carried from TEXT's own usage
      // block; `null` when it named none.
      connectionId: usage.connectionId,
      consultationId: params.consultationId ?? null,
      doctorId: params.doctorId ?? null,
      departmentId: params.departmentId ?? null,
      requestId: usage.taskId || usage.requestId || null,
      attributesJson: buildAttributes(usage),
    },
    units,
  };
}

interface BuildGuardrailUsageParams {
  usage: TextUsageDetail;
  tenantId: string;
  consultationId?: string | null;
  doctorId?: string | null;
  departmentId?: string | null;
  /** Used when guardrail reported no request id of its own. */
  fallbackRequestId?: string | null;
}

/**
 * Build the `guardrail.validate` batch for the guardrail call TEXT forwarded.
 *
 * Metered in full for COGS; never quota-blocked and never line-itemed to a
 * tenant (D16) — a safety check the platform mandates belongs in per-encounter
 * margin, not on a bill.
 */
export function buildGuardrailUsageInput(params: BuildGuardrailUsageParams): UsageEventBatchInput | null {
  const { usage, tenantId } = params;

  const units = normalizeUnits(usage);
  if (units.length === 0) return null;

  const requestId = usage.taskId || usage.requestId || params.fallbackRequestId || '';
  const provider = toLedgerProvider(usage.textProvider);

  return {
    common: {
      tenantId,
      idempotencyKey: UsageIdempotencyKey.guardrailRequest(requestId),
      occurredAt: usage.occurredAt,
      capability: AiCapability.LLM,
      operation: 'guardrail.validate',
      provider,
      model: usage.model || null,
      deployment: resolveDeployment(provider, usage.byok),
      costBasis: usage.byok ? AiCostBasis.BYOK_NOTIONAL : AiCostBasis.INTERNAL,
      connectionId: usage.connectionId,
      consultationId: params.consultationId ?? null,
      doctorId: params.doctorId ?? null,
      departmentId: params.departmentId ?? null,
      requestId,
      attributesJson: buildAttributes(usage),
    },
    units,
  };
}

interface BuildLlmUsageFromTokenCountsParams {
  tenantId: string;
  operation: UsageOperation;
  /** Ties every unit row of this call together. */
  requestId: string;
  provider: string;
  model?: string | null;
  deployment: AiDeploymentKind;
  occurredAt: Date;
  inputTokens?: number | null;
  outputTokens?: number | null;
  consultationId?: string | null;
  doctorId?: string | null;
  departmentId?: string | null;
}

/**
 * Build an LLM usage batch from BARE `{inputTokens, outputTokens}` — for a
 * writer that never called TEXT itself and therefore has no
 * {@link TextUsageDetail} (no provider, no `endpointKind`, no raw provider
 * payload). `context.service.ts#addRawSummary` is the one caller: a legacy
 * write path that persists a summary + pre-computed token counts a caller
 * supplied directly, with zero TEXT/HTTP calls anywhere in that file.
 *
 * Deliberately NOT layered on {@link buildLlmUsageInput} — that function
 * requires a real `endpointKind` and stamps it onto `attributesJson`
 * unconditionally, which would fabricate an API shape that never happened.
 * This builder reuses the SAME primitives (`UsageIdempotencyKey`,
 * `toUsageUnitQuantities`, the vocabulary/enum types) without any of the
 * normalizer logic, since there is nothing to normalize — two counts, no
 * cache/reasoning split, no provider translation.
 */
export function buildLlmUsageInputFromTokenCounts(params: BuildLlmUsageFromTokenCountsParams): UsageEventBatchInput | null {
  const units = toUsageUnitQuantities({
    inputTokens: toCount(params.inputTokens),
    outputTokens: toCount(params.outputTokens),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  });
  if (units.length === 0) return null;

  return {
    common: {
      tenantId: params.tenantId,
      idempotencyKey: UsageIdempotencyKey.llmRequest(params.requestId),
      occurredAt: params.occurredAt,
      capability: AiCapability.LLM,
      operation: params.operation,
      provider: params.provider,
      model: params.model ?? null,
      deployment: params.deployment,
      consultationId: params.consultationId ?? null,
      doctorId: params.doctorId ?? null,
      departmentId: params.departmentId ?? null,
      requestId: params.requestId,
      // No endpointKind/serviceTier/cacheTtl: this path carries no TEXT usage
      // detail block, so there is nothing honest to record beyond "this row
      // was not interrupted" (this write path has no streaming/abort concept).
      attributesJson: { interrupted: false },
    },
    units,
  };
}

// ── internals ───────────────────────────────────────────────────────────────

/**
 * Project the provider's usage onto disjoint `(unit, quantity)` pairs.
 *
 * The raw provider object is preferred because it is the only thing that
 * carries the cache and reasoning splits. When it is absent (an older TEXT, a
 * provider that reported nothing) the headline counts stand in — losing the
 * breakdown is a rate imprecision; losing the event is lost revenue.
 */
function normalizeUnits(usage: TextUsageDetail): ReturnType<typeof toUsageUnitQuantities> {
  const fromRaw = usage.raw ? toUsageUnitQuantities(normalizeLlmUsage(toLedgerProvider(usage.textProvider), usage.endpointKind, usage.raw)) : [];
  if (fromRaw.length > 0) return fromRaw;

  return toUsageUnitQuantities({
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  });
}

/**
 * SELF_HOSTED / CLOUD / BYOK — the economics, independent of the provider name.
 * A BYOK call is tenant-funded regardless of which vendor served it.
 */

/**
 * The allow-listed dimensions this lane may record. Anything descriptive is
 * rejected by `recordUsage` on purpose — this is the PHI boundary of the
 * billing plane, not a place for context.
 */
function buildAttributes(usage: TextUsageDetail): UsageAttributes {
  const attributes: UsageAttributes = {
    endpointKind: usage.endpointKind,
    interrupted: usage.interrupted,
  };
  if (usage.serviceTier) attributes.serviceTier = usage.serviceTier;

  // A 5-minute cache write costs x1.25 of base input, a 1-hour write x2.00, and
  // the ledger has ONE `CACHE_WRITE_TOKEN` unit — so the dominant TTL is
  // recorded as a dimension the price book can grow into.
  const split = anthropicCacheTtlSplit(usage.raw);
  if (split) {
    attributes.cacheTtl = split.ephemeral1h > split.ephemeral5m ? 'ephemeral_1h' : 'ephemeral_5m';
  }

  return attributes;
}

function toCount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0;
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}
