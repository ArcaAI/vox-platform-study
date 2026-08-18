/**
 * Idempotency-key convention for the async envelope (§3.5 of
 * docs/architecture/agentic-workflow-platform/async-contract.md).
 *
 * ============================================================================
 * THE ONE RULE, restated from `usageLedger/idempotency-keys.ts:3-26` (the
 * package this convention is generalized from — its header explains WHY at
 * length; read it before touching this file):
 *
 *   A KEY IS DERIVED FROM INTENT, NEVER FROM CHANCE.
 *
 * Every transport this contract documents is at-least-once (§3.4). An
 * `idempotencyKey` minted from a clock, a counter, or `crypto.randomUUID()`
 * makes every redelivery a NEW event, which defeats the only mechanism a
 * consumer has for collapsing duplicates. The key must be a pure function of
 * WHAT happened (a session id, a task id, a node id) so a retry of the same
 * intent always reproduces the same key.
 *
 * COROLLARY, also carried over unchanged: the abort/failure path uses the
 * SAME key as the completion path for the same intent. Inventing an
 * `...:aborted` suffix double-delivers.
 * ============================================================================
 *
 * `AsyncIdempotencyKey` is NOT the SDK request-idempotency mechanism
 * (`packages/agentic-sdk-v2/src/utils/idempotency.ts`,
 * `packages/vox-node/src/resources/consultation-summaries.ts`) — those are
 * client REQUEST keys (a caller de-duplicating its own HTTP retries) and are
 * legitimately random. This module is for an EVENT's identity, which must
 * never be.
 */

/** Hard ceiling on a key. Bounded so a pathological id cannot bloat a unique index. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/** No whitespace, no control characters, bounded length. */
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

/**
 * Problems with an `idempotencyKey` value. Empty array = conforms. Never throws.
 */
export function idempotencyKeyProblems(key: unknown): string[] {
  if (typeof key !== 'string' || key.length === 0) {
    return ['idempotencyKey must be a non-empty string'];
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return [`idempotencyKey must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters (received ${key.length})`];
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return ['idempotencyKey must contain no whitespace or control characters'];
  }
  return [];
}

/**
 * Reject a blank intent id at the point of construction — a blank id
 * collapses every event of a capability onto ONE key.
 */
function requireId(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`AsyncIdempotencyKey: ${name} is required and must be non-blank`);
  }
  return value.trim();
}

/**
 * Recipes from the design doc's recipe table (§3.5). Two recipes named in the
 * table are NOT functions here because they are not derivations:
 *
 *   - Exposure SSE frame (TASK-722): reuse the source envelope's
 *     `idempotencyKey` unchanged. There is nothing to compute.
 *   - Webhook delivery (TASK-727): `hook:<subscriptionId>:<sourceEnvelopeId>`
 *     — this ONE recipe IS a function, `webhookDelivery` below.
 */
export const AsyncIdempotencyKey = {
  /** STT finalized segment: `stt:session:<sessionId>:seg:<utteranceIndex>`. */
  sttSegment: (sessionId: string, utteranceIndex: number): string => `stt:session:${requireId(sessionId, 'sessionId')}:seg:${utteranceIndex}`,

  /** SMR stream chunk: `text:task:<taskId>:chunk:<sequence>`. */
  textChunk: (taskId: string, sequence: number): string => `text:task:${requireId(taskId, 'taskId')}:chunk:${sequence}`,

  /** Workflow node completion (TASK-718): `wf:run:<runId>:node:<nodeId>:<attemptGeneration>`. */
  workflowNode: (runId: string, nodeId: string, attemptGeneration: number): string =>
    `wf:run:${requireId(runId, 'runId')}:node:${requireId(nodeId, 'nodeId')}:${attemptGeneration}`,

  /** Webhook delivery (TASK-727): `hook:<subscriptionId>:<sourceEnvelopeId>`. */
  webhookDelivery: (subscriptionId: string, sourceEnvelopeId: string): string =>
    `hook:${requireId(subscriptionId, 'subscriptionId')}:${requireId(sourceEnvelopeId, 'sourceEnvelopeId')}`,
} as const;
