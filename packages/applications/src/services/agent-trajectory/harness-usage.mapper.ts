import { AgentStepStatus, AgentStepType, AgentTrajectoryStepEntity, AiCapability, AiCostBasis, AiDeploymentKind } from '@arcaai/domains';
import {
  GUARDRAIL_DISPOSITIONS,
  GuardrailDisposition,
  NormalizedLlmUsage,
  toUsageUnitQuantities,
  USAGE_TRIGGERS,
  UsageEventBatchInput,
  UsageIdempotencyKey,
  UsageTrigger,
} from '../usageLedger';

/**
 * `AgentTrajectoryStep` -> usage-ledger emission hook.
 *
 * `buildHarnessUsageEvent` is a PURE mapper: one persisted LLM_CALL step in,
 * one `{common, units}` ledger batch input out (or `null` when the step
 * carries nothing billable). Kept separate from `AgentTrajectoryService` so
 * the token-mapping / provider-canonicalization / idempotency-key-derivation
 * logic has its own focused test surface, mirroring the WS-B normalizer's own
 * pure-function style (`llm-usage-normalizer.ts`).
 *
 * SCOPE (deliberately narrow — see the cheat sheet in
 *   - LLM_CALL steps only. TOOL_CALL/SENSOR/RETRIEVAL/GUARDRAIL/THINKING/
 *     SIGNAL/GATE/PHASE steps never call an LLM through this path.
 *   - F14: `trigger` / `guardrail` / `funding_tier`, when the step carries them. The
 *     workflow interpreter writes all three (`_generation_stats` in
 *     `apps/harness/.../nodes/core.py`); the consultation lane writes none, and a step
 *     without them maps exactly as it always did.
 *   - INPUT_TOKEN / OUTPUT_TOKEN only. AD-1 `GenerationStats`
 *     (apps/text/src/text/models/stats.py) does not surface a cache/reasoning
 *     breakdown on the LLM_CALL step itself — a non-empty reasoning count is
 *     recorded on a SEPARATE `THINKING` step
 *     (`_reasoning_tokens` in apps/harness activities.py), which this lane
 *     does NOT bill (flagged as a follow-up in the report; never
 *     invented here — "never invent" per the contract).
 */

/**
 * Non-canonical spellings TEXT's own `GenerationStats.provider` reports for a
 * provider already in the ledger's `KNOWN_PROVIDERS` vocabulary
 * (`usageLedger/vocabulary.ts`). Copied VERBATIM from TEXT's own
 * `_PROVIDER_TABLES` alias set (apps/text/src/text/models/stats.py) — not
 * invented. Confirmed trap: Azure's provider constructor is literally
 * `provider="azure_openai"` (apps/text/src/text/providers/azure_openai.py),
 * while the ledger's canonical connection id is `azure` — exactly the
 * "spelling trap" the WS-B contract calls out. A provider not listed here is
 * passed through UNCHANGED: `KNOWN_PROVIDERS` is open, not closed (contract
 * — a tenant can register a real `AiProviderConnection` this mapper has
 * never heard of, and rejecting it would drop real usage to protect a naming
 * convention.
 */
const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  azure_openai: 'azure',
  'azure-openai': 'azure',
  lmstudio: 'lm-studio',
  llama_cpp: 'llama-cpp',
  llamacpp: 'llama-cpp',
  aws_bedrock: 'bedrock',
};

/**
 * Ledger provider ids that run on platform hardware — mirrors the
 * self-hosted-server-id group in `KNOWN_PROVIDERS` (`usageLedger/vocabulary.ts`).
 * Everything else defaults to `CLOUD`: a BYOK (tenant-funded) call needs an
 * explicit signal this lane does not have (see the module header on
 * `costBasis`), so `deployment` never claims more than "not self-hosted".
 */
const SELF_HOSTED_PROVIDERS = new Set(['ollama', 'lm-studio', 'vllm', 'llama-cpp', 'built-in']);

function canonicalizeProvider(raw: string): string {
  const trimmed = raw.trim();
  return PROVIDER_ALIASES[trimmed] ?? trimmed;
}

function classifyDeployment(provider: string): AiDeploymentKind {
  return SELF_HOSTED_PROVIDERS.has(provider) ? AiDeploymentKind.SELF_HOSTED : AiDeploymentKind.CLOUD;
}

/**
 * One agentic-loop step's STABLE identity for idempotency purposes.
 *
 * NOT the entity's auto-generated row id: `AgentTrajectoryStepFactory.CreateStep`
 * mints a fresh UUIDv7 on EVERY call (`packages/domains/.../AgentTrajectoryStepFactory.ts`),
 * including a Temporal activity retry that re-POSTs the same logical step. The
 * composite `(sessionId, runId, seq)` tuple — the SAME tuple the
 * `(tenantId, sessionId, runId, seq)` unique constraint already dedupes
 * trajectory persistence on — is what is actually stable across a redelivery.
 * `tenantId` rides `common.tenantId` separately, so it is not repeated here.
 */
function stepIdentity(step: AgentTrajectoryStepEntity): string {
  return `${step.sessionId}:${step.runId ?? ''}:${step.seq}`;
}

function pickPositiveInt(stats: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = stats[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value);
  }
  return undefined;
}

function pickString(stats: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stats[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/**
 * The three dimensions a WORKFLOW-lane step carries and a consultation-lane step does not
 * (F14) — `trigger`, `guardrail` and `funding_tier`, written by the harness interpreter's
 * `_generation_stats`.
 *
 * `trigger` and `guardrail` are CLOSED vocabularies (`usage-attributes.ts`): a value outside
 * the list is DROPPED rather than passed through, because an unbounded rollup dimension forks
 * silently and the ledger's own attribute allow-list would reject the row anyway.
 */
function pickTrigger(stats: Record<string, unknown>): UsageTrigger | undefined {
  const raw = pickString(stats, 'trigger');
  return raw && (USAGE_TRIGGERS as readonly string[]).includes(raw) ? (raw as UsageTrigger) : undefined;
}

function pickGuardrail(stats: Record<string, unknown>): GuardrailDisposition | undefined {
  const raw = pickString(stats, 'guardrail');
  return raw && (GUARDRAIL_DISPOSITIONS as readonly string[]).includes(raw) ? (raw as GuardrailDisposition) : undefined;
}

/**
 * Whether the TENANT's own credential funded this call.
 *
 * The value is the tier the GATEWAY derived for the candidate that actually served
 * (`AgentFundingTier`: `tenant` | `platform`) and rides the step verbatim. Anything else —
 * absent, misspelled, a tier this mapper has never heard of — reads as "not established", which
 * leaves the row on the engine-derived deployment and the default INTERNAL basis. Never the
 * other way round: inferring BYOK from a value nobody derived would convert tenant-funded spend
 * into platform COGS (or hide platform COGS as never-invoiced notional) on one bad literal.
 */
function isTenantFunded(stats: Record<string, unknown>): boolean {
  return pickString(stats, 'funding_tier', 'fundingTier') === 'tenant';
}

/**
 * Map one persisted `AgentTrajectoryStep` onto the usage-ledger's
 * `{common, units}` batch input, or `null` when the step carries nothing
 * billable (wrong step type, no stats, no positive token count, no provider).
 *
 * Deliberately reads the AD-1 `GenerationStats` field names directly
 * (`prompt_tokens` / `predicted_tokens`) rather than routing through
 * `normalizeLlmUsage(provider, 'openai.chat', stats)`: TEXT's OpenAI-chat-wire
 * normalizer reads `completion_tokens`, not `predicted_tokens` — AD-1 is
 * TEXT's OWN already-normalized shape, not the raw OpenAI wire, and running it
 * through that normalizer would silently read the wrong field and emit a
 * zero-quantity OUTPUT_TOKEN row every time. `toUsageUnitQuantities` is still
 * reused for the zero-dropping behaviour it already implements correctly.
 */
export function buildHarnessUsageEvent(step: AgentTrajectoryStepEntity): UsageEventBatchInput | null {
  if (step.stepType !== AgentStepType.LLM_CALL) return null;
  if (!step.stats || typeof step.stats !== 'object' || Array.isArray(step.stats)) return null;

  const stats = step.stats as Record<string, unknown>;

  const rawProvider = pickString(stats, 'provider');
  if (!rawProvider) return null; // never guess attribution

  const inputTokens = pickPositiveInt(stats, 'prompt_tokens', 'promptTokens') ?? 0;
  const outputTokens = pickPositiveInt(stats, 'predicted_tokens', 'predictedTokens') ?? 0;

  const usage: NormalizedLlmUsage = {
    inputTokens,
    outputTokens,
    // AD-1 GenerationStats carries no cache/reasoning breakdown at this step
    // (see module header) — never invented.
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
  const units = toUsageUnitQuantities(usage);
  if (units.length === 0) return null;

  const provider = canonicalizeProvider(rawProvider);
  const model = pickString(stats, 'model') ?? null;
  const stepId = stepIdentity(step);
  const tenantFunded = isTenantFunded(stats);
  const trigger = pickTrigger(stats);
  const guardrail = pickGuardrail(stats);

  return {
    common: {
      tenantId: step.tenantId,
      idempotencyKey: UsageIdempotencyKey.harnessStep(stepId),
      // Event time = when the call finished, matching 's `completedAt`
      // convention; falls back to `startedAt` only when `endedAt` is somehow
      // absent (every real `_TrajectoryBatch.record()` call sets it).
      occurredAt: step.endedAt ?? step.startedAt,
      capability: AiCapability.LLM,
      operation: 'harness.step',
      provider,
      model,
      // BYOK is claimed ONLY from a funding tier the gateway derived; otherwise the
      // engine decides, exactly as before.
      deployment: tenantFunded ? AiDeploymentKind.BYOK : classifyDeployment(provider),
      // The two halves move TOGETHER — `UsageLedgerService` warns on either alone (a BYOK
      // deployment on the INTERNAL basis inflates COGS; the reverse loses platform spend).
      // Omitted for everything else, which defaults to INTERNAL: a consultation-lane step
      // still carries no BYOK signal and nothing is guessed for it.
      ...(tenantFunded ? { costBasis: AiCostBasis.BYOK_NOTIONAL } : {}),
      consultationId: step.consultationId ?? null,
      requestId: step.runId || step.sessionId,
      sessionId: step.sessionId,
      attributesJson: {
        engine: provider,
        interrupted: step.status !== AgentStepStatus.OK,
        // Spread only when the step actually said so, so a consultation-lane row's
        // attribute bag is byte-identical to what it has always been.
        ...(trigger ? { trigger } : {}),
        ...(guardrail ? { guardrail } : {}),
      },
    },
    units,
  };
}
