import { AiUsageUnit } from '@arcaai/domains';

/**
 * Idempotency-key recipes (part of the frozen contract).
 *
 * ============================================================================
 * THE ONE RULE: A KEY IS DERIVED FROM INTENT, NEVER FROM CHANCE.
 * ============================================================================
 * `AiUsageEvent.idempotencyKey` is UNIQUE, and that unique index is the whole
 * anti-double-billing mechanism: an outbox redelivery, a gateway retry, a
 * resumed stream and a duplicate teardown all converge on the same row instead
 * of billing four times. That only works if the key is a pure function of WHAT
 * happened — a job id, a session id, a request id — and never of a clock, a
 * counter, or a UUID minted at emission time. A random key makes every retry a
 * new charge, and the index that was supposed to prevent it will never fire.
 *
 * COROLLARY — THE ABORT PATH USES THE SAME KEY AS THE COMPLETION PATH. A
 * streaming session that aborts and then also runs its normal teardown must
 * emit `stt:session:<id>:SESSION_SECOND` both times; the second one is a no-op
 * at the ledger. Inventing an `...:aborted` variant would bill the session
 * twice, which is exactly the failure the abort path was added to prevent.
 *
 * SHAPE: `<capability-prefix>:<intent-id>` from the builders below, then
 * `:<UNIT>` appended by {@link UsageIdempotencyKey.forUnit} (or by
 * `recordUsage`'s batch expansion, which appends it for you).
 */

/** Hard ceiling on a key. Bounded so a pathological id cannot bloat the index. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/** No whitespace, no control characters, bounded length. */
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;

/**
 * The recipes.
 *
 * | capability          | base key                     | full row key                              |
 * |---------------------|------------------------------|-------------------------------------------|
 * | STT batch           | `stt:job:<jobId>`            | `stt:job:<jobId>:AUDIO_SECOND`            |
 * | STT streaming       | `stt:session:<sessionId>`    | `stt:session:<sessionId>:SESSION_SECOND`  |
 * |                     |                              | `stt:session:<sessionId>:AUDIO_SECOND`    |
 * | LLM (TEXT)           | `llm:<requestId>`            | `llm:<requestId>:INPUT_TOKEN` (etc.)      |
 * | Guardrail           | `guardrail:<requestId>`      | `guardrail:<requestId>:INPUT_TOKEN`       |
 * | TTS                 | `tts:<requestId>`            | `tts:<requestId>:CHARACTER`               |
 * | NLP                 | `nlp:<requestId>`            | `nlp:<requestId>:TEXT_UNIT`               |
 * | Embeddings          | `embed:<requestId>`          | `embed:<requestId>:INPUT_TOKEN`           |
 * | Harness step        | `harness:step:<stepId>`      | `harness:step:<stepId>:OUTPUT_TOKEN`      |
 * | Worker CPU          | `harness:cpu:<s>:<r>:<a>:<n>`| `harness:cpu:<s>:<r>:<a>:<n>:CPU_SECOND`  |
 *
 * NOTE on the NLP recipe: batches NLP to CONSULTATION granularity, so the
 * `<requestId>` a emitter passes is the per-consultation batch id, not a
 * per-utterance one. The recipe does not change; what it identifies does.
 */
export const UsageIdempotencyKey = {
  /** STT batch transcription job (`transcribe.batch`). */
  sttBatchJob: (jobId: string): string => `stt:job:${requireId(jobId, 'jobId')}`,

  /** STT streaming session (`transcribe.stream`) — completion AND abort. */
  sttStreamSession: (sessionId: string): string => `stt:session:${requireId(sessionId, 'sessionId')}`,

  /** One TEXT generation call (`generate`, `generate.stream`, `presummarize`). */
  llmRequest: (requestId: string): string => `llm:${requireId(requestId, 'requestId')}`,

  /** One guardrail validation call (`guardrail.validate`). */
  guardrailRequest: (requestId: string): string => `guardrail:${requireId(requestId, 'requestId')}`,

  /** One synthesis call (`tts.synthesize`). */
  ttsRequest: (requestId: string): string => `tts:${requireId(requestId, 'requestId')}`,

  /** One NLP extraction batch (`ner.extract`) — consultation-granular. */
  nlpRequest: (requestId: string): string => `nlp:${requireId(requestId, 'requestId')}`,

  /** One embedding call (`embed`). */
  embedRequest: (requestId: string): string => `embed:${requireId(requestId, 'requestId')}`,

  /** One agentic-loop step (`harness.step`). */
  harnessStep: (stepId: string): string => `harness:step:${requireId(stepId, 'stepId')}`,

  /**
   * One Temporal activity execution's worker CPU (`workflow.step`, capability
   * `WORKFLOW` — TASK-959 §3.4).
   *
   * `attempt` is part of the key on purpose. A Temporal REDELIVERY of one
   * execution repeats the same attempt and must converge on one row; a real
   * RETRY is `attempt + 1` and is a SECOND execution that really burned CPU,
   * so it must bill separately. Dropping it would silently under-bill every
   * retried activity; keying on the row id instead would bill every redelivery.
   */
  harnessComputeSample: (sessionId: string, runId: string, activityId: string, attempt: number): string =>
    `harness:cpu:${requireId(sessionId, 'sessionId')}:${requireId(runId, 'runId')}:${requireId(activityId, 'activityId')}:${requireAttempt(attempt)}`,

  /**
   * Append the unit to a base key to get the per-row key.
   *
   * `recordUsage`'s batch form does this for you; call it directly only when
   * emitting a single unit through the plain `UsageEventInput` form.
   */
  forUnit: (base: string, unit: AiUsageUnit): string => `${base}:${unit}`,
} as const;

/**
 * Validate a key's shape.
 *
 * @returns every violation; empty means acceptable.
 */
export function validateIdempotencyKey(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) {
    return ['idempotencyKey must be a non-empty string derived from the event intent'];
  }
  if (value.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return [`idempotencyKey must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters (received ${value.length})`];
  }
  if (!IDEMPOTENCY_KEY.test(value)) {
    return ['idempotencyKey must contain no whitespace or control characters'];
  }
  return [];
}

/**
 * Reject a blank intent id at the point of construction.
 *
 * A blank id collapses every event of a capability onto ONE key: the first row
 * wins and every later one is discarded as a replay. Failing loudly here — in
 * the emitter's own tests — beats discovering it as a suspiciously small
 * invoice.
 */
/**
 * A non-negative integer attempt number.
 *
 * Temporal numbers attempts from 1. A missing or malformed one would collapse
 * every retry of an activity onto one key — the first execution billed, every
 * later one discarded as a replay — so it fails loudly here, in the emitter's
 * own tests, rather than as a suspiciously small invoice.
 */
function requireAttempt(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('UsageIdempotencyKey: attempt is required and must be a non-negative integer');
  }
  return value;
}

function requireId(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`UsageIdempotencyKey: ${name} is required and must be non-blank`);
  }
  return value.trim();
}
