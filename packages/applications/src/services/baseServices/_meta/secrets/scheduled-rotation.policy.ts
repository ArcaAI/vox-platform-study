// TASK-302 Phase 6 Task 6.6 (Stream B) — Scheduled rotation policy.
//
// Pure helpers for the scheduled-rotation processor. Kept separate
// from the processor itself so the policy can be unit-tested without
// spinning up BullMQ / Redis / Vault.

export interface RotationPolicy {
  /** Vault kv-v2 key under secret/data/<prefix>/<key>. */
  key: string;
  /** Maximum age in days before rotation is due. */
  maxAgeDays: number;
}

/**
 * Map of key → last-rotation epoch-ms timestamp. Sourced from the
 * `auditLog` table by the processor (which records every rotation it
 * performs). Missing keys are treated as "never rotated" → due
 * immediately.
 */
export type LastRotatedMap = Record<string, number | undefined>;

/**
 * Return the subset of policy keys whose lastRotated timestamp is
 * STRICTLY older than `maxAgeDays`. Boundary semantics:
 *   - lastRotated === now - maxAgeDays days       → NOT due (24h grace)
 *   - lastRotated === now - maxAgeDays days - 1ms → DUE
 *
 * Missing entries in `lastRotated` count as "rotate immediately".
 */
export function policyDueKeys(nowMs: number, policies: RotationPolicy[], lastRotated: LastRotatedMap): string[] {
  const due: string[] = [];
  for (const policy of policies) {
    const last = lastRotated[policy.key];
    if (last === undefined) {
      due.push(policy.key);
      continue;
    }
    const ageMs = nowMs - last;
    const thresholdMs = policy.maxAgeDays * 86400_000;
    if (ageMs > thresholdMs) {
      due.push(policy.key);
    }
  }
  return due;
}
