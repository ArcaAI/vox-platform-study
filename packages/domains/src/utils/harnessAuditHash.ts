import { createHash } from 'node:crypto';

/**
 * Tamper-evident hash chain for `HarnessAuditEvent` (TASK-330 Phase 0).
 *
 * Each audit event stores `hash = SHA-256(canonical fields incl. prevHash)` and
 * `prevHash = hash of the previous event for the same tenant`. Because the
 * previous hash is folded into the next event's digest, editing or removing any
 * historical row invalidates every subsequent `hash` — and the table is
 * append-only at the DB-privilege layer (the migration REVOKEs UPDATE/DELETE),
 * so an attacker cannot rewrite the chain to cover their tracks.
 *
 * @see research/clinical-harness/03-medical-ai-evaluation-guardrails-governance.md
 */

/** Canonical fields hashed for a single audit event (everything except `hash`). */
export interface HarnessAuditHashInput {
  tenantId: string;
  consultationId: string;
  contextItemVersionId?: string | null;
  action: string;
  modelName: string;
  modelVersion: string;
  promptTemplateId?: string | null;
  promptVersion?: string | null;
  sensorScores: unknown;
  citations: unknown;
  gateDecision?: string | null;
  clinicianId?: string | null;
  attestationHash?: string | null;
  createdAt: Date | string;
  /** The previous event's `hash`, or {@link GENESIS_PREV_HASH} for the first. */
  prevHash: string;
}

/** A persisted audit row: the canonical input plus its stored `hash`. */
export type HarnessAuditChainRecord = HarnessAuditHashInput & { hash: string };

export interface HarnessAuditChainVerification {
  valid: boolean;
  /** Index of the first event that breaks the chain, or `null` when valid. */
  brokenAtIndex: number | null;
  reason?: string;
}

/** Anchor for the first event in a tenant's chain (32 zero bytes, hex). */
export const GENESIS_PREV_HASH = '0'.repeat(64);

/**
 * Deterministically serialize a value with object keys sorted recursively, so
 * `{a,b}` and `{b,a}` (and equivalent nested shapes) hash identically.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

function normalizeCreatedAt(createdAt: Date | string): string {
  return createdAt instanceof Date ? createdAt.toISOString() : new Date(createdAt).toISOString();
}

/**
 * Compute the SHA-256 hash for one audit event over its canonical fields.
 * The field order + canonical JSON make the digest stable and reproducible.
 */
export function computeHarnessAuditHash(input: HarnessAuditHashInput): string {
  const canonical = canonicalJson({
    prevHash: input.prevHash,
    tenantId: input.tenantId,
    consultationId: input.consultationId,
    contextItemVersionId: input.contextItemVersionId ?? null,
    action: input.action,
    modelName: input.modelName,
    modelVersion: input.modelVersion,
    promptTemplateId: input.promptTemplateId ?? null,
    promptVersion: input.promptVersion ?? null,
    sensorScores: input.sensorScores ?? null,
    citations: input.citations ?? null,
    gateDecision: input.gateDecision ?? null,
    clinicianId: input.clinicianId ?? null,
    attestationHash: input.attestationHash ?? null,
    createdAt: normalizeCreatedAt(input.createdAt),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Verify a tenant's audit chain (oldest → newest). The chain is valid when, for
 * every event: (1) its stored `hash` equals the recomputed hash of its fields
 * (no tampering), and (2) its `prevHash` equals the previous event's `hash`
 * (the genesis anchor for the first event — no splicing/deletion).
 */
export function verifyHarnessAuditChain(events: HarnessAuditChainRecord[]): HarnessAuditChainVerification {
  let expectedPrevHash = GENESIS_PREV_HASH;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    if (event.prevHash !== expectedPrevHash) {
      return {
        valid: false,
        brokenAtIndex: i,
        reason: `prevHash mismatch at index ${i}: expected ${expectedPrevHash}, got ${event.prevHash}`,
      };
    }

    const recomputed = computeHarnessAuditHash(event);
    if (recomputed !== event.hash) {
      return {
        valid: false,
        brokenAtIndex: i,
        reason: `hash mismatch at index ${i}: stored ${event.hash}, recomputed ${recomputed}`,
      };
    }

    expectedPrevHash = event.hash;
  }

  return { valid: true, brokenAtIndex: null };
}
