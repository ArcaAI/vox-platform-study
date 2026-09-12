import { AgentStepStatus, AgentStepType, AgentTrajectoryStepEntity, AiCapability, AiCostBasis, AiDeploymentKind } from '@arcaai/domains';
import {
  appendComputeAndByteUnits,
  type ComputeAugmentedBatch,
  type ComputeDevice,
  GUARDRAIL_DISPOSITIONS,
  GuardrailDisposition,
  NormalizedLlmUsage,
  toUsageUnitQuantities,
  USAGE_LEGS,
  USAGE_TRIGGERS,
  UsageEventBatchInput,
  UsageIdempotencyKey,
  UsageLeg,
  UsageOperation,
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
 *   - All FIVE token counts since TASK-959 (TASK-957 F-6). The interpreter now
 *     stamps TEXT's normalized `usage_detail` counts flat onto the step's stats
 *     (`cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`), so a
 *     reasoning model bound to a workflow agent is no longer structurally
 *     unbillable. A step that carries none still maps to two rows and nothing
 *     is invented — the counts are read defensively, never defaulted.
 *   - Occupancy seconds and third-party bytes since TASK-959 (§3.2, §4.2),
 *     appended by the shared `appendComputeAndByteUnits`. `device` is passed IN:
 *     resolving it needs a settings read, and this mapper stays pure.
 *   - A LOSING fallback leg since TASK-959 (§6.2). A candidate that raised
 *     before another one served arrives as an ordinary `LLM_CALL` step at its
 *     own `seq` with `leg: "failed"` and NO token counts; it bills one
 *     `CPU_SECOND` row, because the attempt cost the platform real CPU and the
 *     tenant nothing.
 *
 * THE OPERATION SPLIT (TASK-957 F-1). A step whose `stats.trigger` is
 * `WORKFLOW_RUN` is billed as `workflow.step`; everything else stays
 * `harness.step`. `harness.step` is in `NON_BILLABLE_LLM_OPERATIONS` and
 * `workflow.step` deliberately is not, so tenant-consumed workflow inference
 * becomes billable BY CONSTRUCTION rather than by a rule someone has to
 * remember to apply. The idempotency key does NOT move with it: it is the
 * `(sessionId, runId, seq)` tuple and nothing else, so a step re-POSTed across
 * a deploy that changed the operation still converges on one row.
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
 * `leg` — which attempt of a fallback chain this step is (§6.2).
 *
 * The harness stamps `"failed"` and nothing else: a candidate that SERVED
 * carries no `leg` at all, because "the leg that answered" is what every other
 * column on the row already says. Read through the closed vocabulary so a
 * future `primary`/`fallback` spelling works and a typo is dropped rather than
 * rejected at emit time.
 */
function pickLeg(stats: Record<string, unknown>): UsageLeg | undefined {
  const raw = pickString(stats, 'leg');
  return raw && (USAGE_LEGS as readonly string[]).includes(raw) ? (raw as UsageLeg) : undefined;
}

/**
 * The operation this step bills under (TASK-957 F-1) — see the module header.
 */
function pickOperation(trigger: UsageTrigger | undefined): UsageOperation {
  return trigger === 'WORKFLOW_RUN' ? 'workflow.step' : 'harness.step';
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
export function buildHarnessUsageEvent(step: AgentTrajectoryStepEntity, options: BuildHarnessUsageOptions = {}): UsageEventBatchInput | null {
  return buildHarnessUsageBatches(step, options)?.batch ?? null;
}

/** What the SERVICE resolves and the mapper cannot (see the module header). */
export interface BuildHarnessUsageOptions {
  /**
   * The device a SELF-HOSTED engine ran on, from
   * `metering.compute.deviceByProvider`. Resolving it is a settings read, which
   * would make this mapper impure and untestable as a pure function — so
   * `AgentTrajectoryService` resolves it and passes it in. Omitted resolves to
   * `cpu` (the cheaper unit, never nothing) and is IGNORED for a cloud or BYOK
   * step, whose seconds are HOPE's own CPU spent calling the vendor.
   */
  device?: ComputeDevice | null;
}

/**
 * The FULL-FIDELITY form of {@link buildHarnessUsageEvent}.
 *
 * Identical but for the one case a single batch cannot express: a tenant-funded
 * step's platform CPU leg is `INTERNAL` while its token rows stay
 * `BYOK_NOTIONAL` (§6.3), and `costBasis` lives on `common`.
 */
export function buildHarnessUsageBatches(step: AgentTrajectoryStepEntity, options: BuildHarnessUsageOptions = {}): ComputeAugmentedBatch | null {
  if (step.stepType !== AgentStepType.LLM_CALL) return null;
  if (!step.stats || typeof step.stats !== 'object' || Array.isArray(step.stats)) return null;

  const stats = step.stats as Record<string, unknown>;

  const rawProvider = pickString(stats, 'provider');
  if (!rawProvider) return null; // never guess attribution

  const leg = pickLeg(stats);
  // §6.2 — a losing leg is a step that RAISED. Both halves are required: the
  // label alone on an OK step would be a contradiction the harness never emits,
  // and a non-OK step WITHOUT it is an ordinary error record, not a metered
  // attempt. Demanding both keeps this from widening into "bill every failure".
  const failedLeg = leg === 'failed' && step.status !== AgentStepStatus.OK;

  const usage: NormalizedLlmUsage = {
    inputTokens: pickPositiveInt(stats, 'prompt_tokens', 'promptTokens') ?? 0,
    outputTokens: pickPositiveInt(stats, 'predicted_tokens', 'predictedTokens') ?? 0,
    // TASK-957 F-6 — TEXT's normalized counts, stamped flat on the step by the
    // interpreter. Read defensively: absent stays 0, never invented.
    cacheReadTokens: pickPositiveInt(stats, 'cache_read_tokens', 'cacheReadTokens') ?? 0,
    cacheWriteTokens: pickPositiveInt(stats, 'cache_write_tokens', 'cacheWriteTokens') ?? 0,
    reasoningTokens: pickPositiveInt(stats, 'reasoning_tokens', 'reasoningTokens') ?? 0,
  };
  const units = failedLeg ? [] : toUsageUnitQuantities(usage);

  const totalMs = pickPositiveInt(stats, 'total_ms', 'totalMs');
  const engineMs = pickPositiveInt(stats, 'engine_ms', 'engineMs');

  // No billable token AND not a failed leg — exactly the pre-TASK-959 answer.
  // The timing alone deliberately does NOT rescue such a step: a duration on an
  // unlabelled error is an error record, and billing it would quietly widen
  // §6.2's narrow "the losing candidate of a fallback chain" into "every
  // failure anywhere", inventing a row for every step type that ever fails.
  if (units.length === 0 && !failedLeg) return null;
  // A failed leg with no duration has nothing to bill — the whole point of the
  // row is the seconds, and there are none to record.
  if (failedLeg && totalMs === undefined && engineMs === undefined) return null;

  const provider = canonicalizeProvider(rawProvider);
  const model = pickString(stats, 'model') ?? null;
  const stepId = stepIdentity(step);
  const tenantFunded = isTenantFunded(stats);
  const trigger = pickTrigger(stats);
  const guardrail = pickGuardrail(stats);

  // A failed leg generated nothing, so there is no tenant spend to record as
  // notional — only the seconds HOPE burned trying, which are platform cost.
  // `deployment` still names the candidate that was attempted; the BASIS is
  // what makes those seconds COGS (the shape `UsageLedgerService` exempts).
  const notional = tenantFunded && !failedLeg;
  // Stamped EXPLICITLY rather than left to the contract's default, because on a
  // BYOK row the reader's first question is "was the notional flag forgotten?"
  // — and on a failed leg the answer is "no, there is deliberately nothing
  // notional to record". `UsageLedgerService` exempts this exact shape.
  const platformFundedByokLeg = tenantFunded && failedLeg;

  const batch: UsageEventBatchInput = {
    common: {
      tenantId: step.tenantId,
      idempotencyKey: UsageIdempotencyKey.harnessStep(stepId),
      // Event time = when the call finished, matching 's `completedAt`
      // convention; falls back to `startedAt` only when `endedAt` is somehow
      // absent (every real `_TrajectoryBatch.record()` call sets it).
      occurredAt: step.endedAt ?? step.startedAt,
      capability: AiCapability.LLM,
      operation: pickOperation(trigger),
      provider,
      model,
      // BYOK is claimed ONLY from a funding tier the gateway derived; otherwise the
      // engine decides, exactly as before.
      deployment: tenantFunded ? AiDeploymentKind.BYOK : classifyDeployment(provider),
      // The two halves move TOGETHER — `UsageLedgerService` warns on either alone (a BYOK
      // deployment on the INTERNAL basis inflates COGS; the reverse loses platform spend).
      // Omitted for everything else, which defaults to INTERNAL: a consultation-lane step
      // still carries no BYOK signal and nothing is guessed for it.
      ...(notional ? { costBasis: AiCostBasis.BYOK_NOTIONAL } : {}),
      ...(platformFundedByokLeg ? { costBasis: AiCostBasis.INTERNAL } : {}),
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
        ...(leg ? { leg } : {}),
      },
    },
    units,
  };

  return appendComputeAndByteUnits(batch, {
    device: options.device,
    totalMs,
    engineMs,
    requestBytes: pickPositiveInt(stats, 'request_bytes', 'requestBytes'),
    responseBytes: pickPositiveInt(stats, 'response_bytes', 'responseBytes'),
    // The counts originate in TEXT's own httpx transport and ride the step
    // verbatim — the same wire figure, one hop further on.
    byteSource: 'wire',
  });
}
