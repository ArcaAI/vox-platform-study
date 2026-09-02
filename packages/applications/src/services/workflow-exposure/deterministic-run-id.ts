import { createHash } from 'node:crypto';

/**
 * The run id for an idempotent invocation — a pure function of
 * `(tenantId, workflowSlug, idempotencyKey)` (TASK-850 lane A step 6).
 *
 * ## Why a DERIVED id rather than a stored one
 *
 * The exposure plane already accepted `Idempotency-Key`, but the only thing behind it was a
 * best-effort Redis response cache: `tryReadIdempotencyCache` swallows every failure by design,
 * so on an eviction, a cold node, or Redis being unreachable the SAME key produced a fresh
 * `generateId()` run id, a fresh Temporal workflow id, and a second, separately-billed LLM run.
 * A retried webhook is exactly the case that mechanism was supposed to cover, and exactly the
 * case in which it failed open.
 *
 * Deriving the id removes the need to coordinate at all. Two deliveries of the same key
 * independently compute the same run id, so they address the same durable `WorkflowRun` row
 * (`recordRunStarted` is idempotent on `(tenantId, sessionId, runId)`) and the same Temporal
 * workflow id (`interpreter_workflow_id(runId)`), where `USE_EXISTING` + `REJECT_DUPLICATE`
 * refuse a second execution. Redis stays as a fast path and is no longer load-bearing.
 *
 * ## Why the inputs are exactly these three
 *
 * `tenantId` because an idempotency key is the CALLER's namespace, and two tenants must be able
 * to send the same key without colliding — a collision here would hand one tenant another's run.
 * `slug` because the same key against a different workflow is a different intent. And the key
 * itself. Nothing else: the PAYLOAD is deliberately excluded, because a retry that differs only
 * in a timestamp field is still the same delivery, and hashing the payload would silently start
 * the second run this function exists to prevent.
 *
 * ## Format
 *
 * SHA-256 over length-prefixed inputs, rendered as an RFC 9562 version-8 (custom) UUID.
 * Length prefixes rather than a delimiter because a delimiter is forgeable: with `a:b:c`,
 * `("ab", "c")` and `("a", "bc")` hash identically once a tenant id or slug may contain the
 * delimiter. v8 rather than v5 because v5 mandates SHA-1; v8 is precisely the "vendor-defined
 * hash" version, and `WorkflowRun.runId` is a plain `String` column with no version constraint.
 */
export function deterministicRunId(tenantId: string, slug: string, idempotencyKey: string): string {
  const hash = createHash('sha256');
  for (const part of [tenantId, slug, idempotencyKey]) {
    const bytes = Buffer.from(part, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  const digest = hash.digest();

  // RFC 9562 §4.1-4.2: version nibble in byte 6, variant bits (10xx) in byte 8.
  digest[6] = (digest[6] & 0x0f) | 0x80;
  digest[8] = (digest[8] & 0x3f) | 0x80;

  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
