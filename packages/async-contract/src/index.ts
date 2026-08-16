/**
 * @arcaai/async-contract
 *
 * TASK-717: the normative async task/event envelope, plus the idempotency-key
 * and resume-token conventions, plus a reusable conformance suite. Zero
 * runtime dependencies. Full prose contract:
 * docs/architecture/agentic-workflow-platform/async-contract.md.
 */
export { ASYNC_ENVELOPE_SCHEMA_VERSION, asyncEnvelopeProblems, parseAsyncEnvelope } from './envelope';
export type { AsyncEnvelope } from './envelope';

export { claimCheckRefProblems } from './claim-check-ref';
export type { ClaimCheckRef } from './claim-check-ref';

export { MAX_IDEMPOTENCY_KEY_LENGTH, idempotencyKeyProblems, AsyncIdempotencyKey } from './idempotency';

export { encodeResumeToken, decodeResumeToken, RESUME_FROM_BEGINNING } from './resume-token';

export { assertAsyncConformance } from './conformance/index';
export type { AsyncProducerUnderTest } from './conformance/index';
