import { createHash } from 'node:crypto';

/**
 * Tamper-evident hash chain for `HarnessAuditEvent`.
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
  // NULLABLE (consent-abac Phase 4): CONSENT_GIVEN/CONSENT_WITHDRAWN
  // events have no consultation. Folded into the digest as `?? null` below,
  // which is a no-op for every event that DOES carry one (i.e. every event
  // that predates this change) — see the backward-compatibility test.
  consultationId: string | null;
  contextItemVersionId?: string | null;
  action: string;
  modelName: string;
  modelVersion: string;
  promptTemplateId?: string | null;
  promptVersion?: string | null;
  sensorScores: unknown;
  citations: unknown;
  // ENCRYPT-BEFORE-HASH — when an event's PHI payload is
  // encrypted, these hold the Vault-Transit ciphertext (Buffer from the `Bytes?`
  // column, or its utf8 string form). The hash is then derived over the
  // CIPHERTEXT instead of the plaintext `sensorScores`/`citations`, per field
  // and independently, so the chain validates identically on the insert path and
  // the verifier. Absent (legacy/plaintext rows) ⇒ the hash uses the plaintext,
  // i.e. exactly the pre-3D digest, so historical chains keep verifying.
  encryptedSensorScores?: Buffer | Uint8Array | string | null;
  encryptedCitations?: Buffer | Uint8Array | string | null;
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
 * Stable hash representation of an encrypted payload column.
 * Returns the ciphertext as its utf8 string (`vault:vN:<b64>`) when present, or
 * `undefined` when there is no ciphertext (so the caller hashes the plaintext).
 * Bytes columns round-trip as Buffer/Uint8Array; the string branch supports
 * passing the ciphertext directly.
 */
function ciphertextToHashRepr(ct: Buffer | Uint8Array | string | null | undefined): string | undefined {
  if (ct === null || ct === undefined) return undefined;
  if (typeof ct === 'string') return ct.length > 0 ? ct : undefined;
  return ct.length > 0 ? Buffer.from(ct).toString('utf8') : undefined;
}

/**
 * Compute the SHA-256 hash for one audit event over its canonical fields.
 * The field order + canonical JSON make the digest stable and reproducible.
 *
 * ENCRYPT-BEFORE-HASH (Phase 3D): for the `sensorScores`/`citations` slots the
 * digest uses the CIPHERTEXT when `encrypted*` is supplied (per field), else the
 * plaintext value — keeping legacy/plaintext rows byte-identical to the pre-3D
 * digest while encrypted rows are bound to their ciphertext.
 */
export function computeHarnessAuditHash(input: HarnessAuditHashInput): string {
  const sensorScoresRepr = ciphertextToHashRepr(input.encryptedSensorScores) ?? input.sensorScores ?? null;
  const citationsRepr = ciphertextToHashRepr(input.encryptedCitations) ?? input.citations ?? null;
  const canonical = canonicalJson({
    prevHash: input.prevHash,
    tenantId: input.tenantId,
    consultationId: input.consultationId ?? null,
    contextItemVersionId: input.contextItemVersionId ?? null,
    action: input.action,
    modelName: input.modelName,
    modelVersion: input.modelVersion,
    promptTemplateId: input.promptTemplateId ?? null,
    promptVersion: input.promptVersion ?? null,
    sensorScores: sensorScoresRepr,
    citations: citationsRepr,
    gateDecision: input.gateDecision ?? null,
    clinicianId: input.clinicianId ?? null,
    attestationHash: input.attestationHash ?? null,
    createdAt: normalizeCreatedAt(input.createdAt),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Structural shape of a persisted `HarnessAuditEvent` (entity or plain row) the
 * chain helpers accept. Declared structurally so this util does NOT import the
 * entity (which would create a domains util ⇄ entity cycle).
 */
export interface HarnessAuditEventLike {
  tenantId: string;
  consultationId?: string | null;
  contextItemVersionId?: string | null;
  action: string;
  modelName: string;
  modelVersion: string;
  promptTemplateId?: string | null;
  promptVersion?: string | null;
  sensorScores: unknown;
  citations: unknown;
  encryptedSensorScores?: Buffer | Uint8Array | string | null;
  encryptedCitations?: Buffer | Uint8Array | string | null;
  gateDecision?: string | null;
  clinicianId?: string | null;
  attestationHash?: string | null;
  createdAt: Date | string;
  prevHash: string;
  hash: string;
}

/**
 * Map a persisted audit row/entity to the canonical
 * {@link HarnessAuditChainRecord} for verification, carrying the `encrypted*`
 * ciphertext columns so the verifier hashes over ciphertext for encrypted rows
 * and over plaintext for legacy rows — EXACTLY as the insert path did. Using
 * this on BOTH the writer and every verifier is what keeps the chain consistent.
 */
export function toHarnessAuditChainRecord(event: HarnessAuditEventLike): HarnessAuditChainRecord {
  return {
    tenantId: event.tenantId,
    consultationId: event.consultationId ?? null,
    contextItemVersionId: event.contextItemVersionId ?? null,
    action: event.action,
    modelName: event.modelName,
    modelVersion: event.modelVersion,
    promptTemplateId: event.promptTemplateId ?? null,
    promptVersion: event.promptVersion ?? null,
    sensorScores: event.sensorScores ?? null,
    citations: event.citations ?? null,
    encryptedSensorScores: event.encryptedSensorScores ?? null,
    encryptedCitations: event.encryptedCitations ?? null,
    gateDecision: event.gateDecision ?? null,
    clinicianId: event.clinicianId ?? null,
    attestationHash: event.attestationHash ?? null,
    createdAt: event.createdAt,
    prevHash: event.prevHash,
    hash: event.hash,
  };
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
