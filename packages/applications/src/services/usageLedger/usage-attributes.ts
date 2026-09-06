/**
 * `AiUsageEvent.attributesJson` allow-list (deliverable 5).
 *
 * ============================================================================
 * WHY AN ALLOW-LIST AND NOT A DENY-LIST
 * ============================================================================
 * The usage ledger is the only plane the billing pipeline reads, and decision
 * D17 keeps that pipeline outside 45 CFR *on the grounds that it
 * carries no PHI*. `attributesJson` is the sole free-shaped column on the row,
 * so it is the sole way that claim could become false. A deny-list protects
 * against the keys someone thought of; an allow-list protects against the ones
 * nobody did — including the field a future emitter adds in a hurry.
 *
 * Two rules, both enforced below:
 *   1. The KEY must be declared here.
 *   2. The VALUE must be enum-ish: a bounded id/enum string (no spaces, no
 *      prose punctuation), a safe integer, or a boolean. Nested objects and
 *      arrays are rejected outright — a blob can hide a transcript.
 *
 * EXTENDING THE LIST IS A DELIBERATE ACT. Add a key here only when it is a
 * DIMENSION (something you would group a rollup by or price on), never when it
 * is a description. If the value could ever be typed by a human, it does not
 * belong in this plane at all.
 */

/** Value shapes an attribute may take. */
type UsageAttributeType = 'string' | 'number' | 'boolean';

/**
 * `trigger` — WHICH PRODUCT ACTIVITY caused this inference (TASK-890 OD-E).
 *
 * Every other column on a ledger row answers "what ran and what did it cost".
 * None of them answers "why", and without that a tenant whose spend doubled
 * cannot be told whether its clinicians consulted twice as much or one engineer
 * left a prompt test looping. It is a closed vocabulary for the same reason
 * `USAGE_OPERATIONS` is: an unbounded rollup dimension forks silently.
 *
 * FIVE VALUES, one per activity that reaches an inference service:
 *
 * | value | emitted by |
 * |--------------------|-------------------------------------------------------|
 * | `AGENT_INVOCATION` | `POST /agents/:slug/{invocations,speech,transcriptions}` |
 * | `AGENT_TEST` | the draft-agent test route (§3.8) |
 * | `PROMPT_TEST` | the prompt-template test bench |
 * | `WORKFLOW_RUN` | a durable or realtime workflow step |
 * | `CONSULTATION` | the clinical paths (summary, STT, NER, realtime lane) |
 */
export const USAGE_TRIGGERS = ['AGENT_INVOCATION', 'AGENT_TEST', 'PROMPT_TEST', 'WORKFLOW_RUN', 'CONSULTATION'] as const;

export type UsageTrigger = (typeof USAGE_TRIGGERS)[number];

/**
 * `guardrail` — the SCREENING DISPOSITION of the call this row bills (OD-R).
 *
 * `screened` = the guard ran; `opted_out` = the tenant turned it off for this
 * agent/workflow node; `platform_off` = the platform kill-switch
 * (`text.externalGuardrail.enabled`) is off, so nobody's opt-out was even
 * consulted. Distinguishing the last two matters: one is a tenant decision on
 * the record, the other is a platform state that makes every opt-out moot.
 */
export const GUARDRAIL_DISPOSITIONS = ['screened', 'opted_out', 'platform_off'] as const;

export type GuardrailDisposition = (typeof GUARDRAIL_DISPOSITIONS)[number];

/**
 * The declared keys and their types.
 *
 * | key | why it earns a slot |
 * |----------------|------------------------------------------------------------|
 * | `channelCount` | dual-mic recordings bill 1x (OQ2) but keep the count for repricing |
 * | `engine` | which self-hosted engine served the call (COGS attribution) |
 * | `pipelineId` | STT pipeline-tier rate resolution + provenance |
 * | `languageMode` | `en` / `ml` / `ml-en` — drives pipeline-tier cost |
 * | `serviceTier` | provider service tier (`batch` is ~50% off at every lab) |
 * | `interrupted` | the abort path emitted this row (fairness + reconciliation) |
 * | `streamKind` | `ws` / `sse` — how the usage was observed |
 * | `cacheTtl` | Anthropic 5m vs 1h cache write (x1.25 vs x2.00) |
 * | `endpointKind` | which API shape the normalizer branched on |
 * | `contextBand` | the price-book context band this row was rated against |
 * | `trigger` | WHICH product activity caused the call ({@link USAGE_TRIGGERS}) |
 * | `guardrail` | the screening disposition ({@link GUARDRAIL_DISPOSITIONS}) |
 */
export const USAGE_ATTRIBUTE_KEYS = {
  channelCount: 'number',
  engine: 'string',
  pipelineId: 'string',
  languageMode: 'string',
  serviceTier: 'string',
  interrupted: 'boolean',
  streamKind: 'string',
  cacheTtl: 'string',
  endpointKind: 'string',
  contextBand: 'string',
  trigger: 'string',
  guardrail: 'string',
} as const satisfies Record<string, UsageAttributeType>;

/** The typed attribute bag emitters build. */
export interface UsageAttributes {
  channelCount?: number | null;
  engine?: string | null;
  pipelineId?: string | null;
  languageMode?: string | null;
  serviceTier?: string | null;
  interrupted?: boolean | null;
  streamKind?: string | null;
  cacheTtl?: string | null;
  endpointKind?: string | null;
  contextBand?: string | null;
  /** Closed vocabulary — see {@link USAGE_TRIGGERS}. */
  trigger?: UsageTrigger | null;
  /** Closed vocabulary — see {@link GUARDRAIL_DISPOSITIONS}. */
  guardrail?: GuardrailDisposition | null;
}

/**
 * Enum-ish / opaque-id string shape.
 *
 * Deliberately excludes whitespace and prose punctuation: `018f3c2a-...`,
 * `ml-en`, `whisper_cpp`, `128k+` and `anthropic.messages` all pass;
 * `patient reports chest pain` does not. `+` is admitted for the context-band
 * spelling the price book already uses.
 */
const ENUM_ISH_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$/;

/**
 * Validate an attribute bag against the allow-list.
 *
 * @returns EVERY violation found (never short-circuits) so a failing emitter is
 *          fixed in one pass instead of one round trip per bad key.
 *          An empty array means the bag is safe to persist.
 */
export function validateUsageAttributes(attributes: unknown): string[] {
  if (attributes === null || attributes === undefined) return [];

  if (typeof attributes !== 'object' || Array.isArray(attributes)) {
    return ['attributesJson must be a plain object of allow-listed keys'];
  }

  const violations: string[] = [];

  for (const [key, value] of Object.entries(attributes as Record<string, unknown>)) {
    const expectedType = (USAGE_ATTRIBUTE_KEYS as Record<string, UsageAttributeType | undefined>)[key];

    if (!expectedType) {
      violations.push(`attributesJson key "${key}" is not allow-listed (PHI rule — see usage-attributes.ts)`);
      continue;
    }

    // An explicit null is "this dimension does not apply", not free text.
    if (value === null || value === undefined) continue;

    if (typeof value !== expectedType) {
      violations.push(`attributesJson key "${key}" must be a ${expectedType}, received ${describeType(value)}`);
      continue;
    }

    if (expectedType === 'string' && !ENUM_ISH_VALUE.test(value as string)) {
      violations.push(`attributesJson key "${key}" must be an enum-ish value or opaque id (no free text, <= 64 chars)`);
      continue;
    }

    if (expectedType === 'number' && !Number.isSafeInteger(value as number)) {
      violations.push(`attributesJson key "${key}" must be a safe integer, received ${String(value)}`);
    }
  }

  return violations;
}

function describeType(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Stamp `trigger` onto a batch a builder already produced.
 *
 * The LLM builders (`buildLlmUsageInput` and friends) map an `apps/text` usage
 * block onto ledger rows; they know nothing about WHY the call happened, and
 * threading a caller-supplied dimension through every builder signature would
 * put the same optional parameter on five functions. So the activity is stamped
 * here, by the caller that knows it, in one place all four lanes share.
 *
 * Returns a NEW batch — a caller may legitimately build once and emit twice
 * (the abort path and the completion path converge on one idempotency key), so
 * mutating the input would let the second emission inherit the first's dimension.
 * A `null` batch (nothing was consumed) passes through as `null`.
 */
export function withUsageTrigger<T extends { common: { attributesJson?: UsageAttributes | null } }>(
  batch: T | null,
  trigger: UsageTrigger,
): T | null {
  if (!batch) return null;
  return {
    ...batch,
    common: { ...batch.common, attributesJson: { ...(batch.common.attributesJson ?? {}), trigger } },
  };
}
