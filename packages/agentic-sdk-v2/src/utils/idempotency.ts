/**
 * TASK-299 D-9 — Idempotency-Key utilities.
 *
 * The SDK injects an `idempotencyKey` into side-effectful POST bodies so
 * the backend can dedupe duplicate user-actions (double-clicks, retries,
 * navigation re-mounts). The backend stores the key in Redis with a 24h
 * TTL and returns the original `jobId` on collision (HTTP 200).
 *
 * NOTE: we ship the key as a body field instead of an HTTP header because
 * `AgenticClient.post` does not currently accept custom headers and that
 * file is owned by another workstream — see the TASK-299 README hand-off
 * section.
 */

/**
 * Generate a new RFC 4122 v4 idempotency key. Falls back to a non-secure
 * pseudo-UUID when the runtime does not expose `crypto.randomUUID`
 * (e.g. older Node/jsdom test environments) — sufficient for dedupe
 * uniqueness within a single user session.
 */
export function generateIdempotencyKey(): string {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Merge an idempotency key into a POST body. If the caller already
 * supplied one we honor it; otherwise we mint a fresh UUID.
 */
export function withIdempotencyKey<T extends Record<string, unknown> | undefined>(body: T, explicitKey?: string): T & { idempotencyKey: string } {
  const idempotencyKey = explicitKey ?? generateIdempotencyKey();
  const base = (body ?? {}) as Record<string, unknown>;
  // Do not overwrite a key already present in the body.
  if (typeof base.idempotencyKey === 'string' && base.idempotencyKey.length > 0) {
    return base as T & { idempotencyKey: string };
  }
  return { ...base, idempotencyKey } as T & { idempotencyKey: string };
}
