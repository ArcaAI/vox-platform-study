/**
 * Harness-assurance helpers (TASK-355 Phase D Slice 6b — Q5 live per-claim feed).
 *
 * Pure transforms used by `useHarnessAssurance` and the review panel:
 *   - `reduceHarnessAssuranceMessage` classifies a raw SSE `message` payload into
 *     a per-claim event, the terminal (closed) `assurance_complete` event, a
 *     heartbeat, or invalid.
 *   - `normalizeHarnessAssuranceEvent` coerces the payload defensively so the
 *     live N-of-M counter and the safety/amendment banners can never render
 *     malformed entries.
 *
 * Each SSE message is FULL-STATE (the complete accumulated claim-verdict list),
 * so the client stays stateless: render the latest event, nothing to merge.
 * Carries NO PHI (claim ids, sensor keys, verdict labels only). Mirrors
 * `lib/harness-progress.ts` (no `@arcaai/vox` runtime dependency).
 */

/** One resolved claim verdict in the accumulated assurance snapshot. */
export interface HarnessAssuranceClaim {
  claimId: string;
  sensor: string;
  /** Per-claim verdict label, e.g. 'grounded' | 'ungrounded'. */
  verdict: string;
  label?: string;
  ordinal: number;
  /** ISO timestamp the verdict resolved ('' when absent). */
  at: string;
}

export interface HarnessAssuranceEvent {
  consultationId: string;
  jobId?: string;
  /** Total verifiable claims in the run (when the harness reported it). */
  total?: number;
  claims: HarnessAssuranceClaim[];
  /** Aggregate gate verdict (PASS | REGEN | FLAG) — terminal event only. */
  gateDecision: string | null;
  /** True when the safety sensor FLAGged the note — terminal event only. */
  safetyFlag: boolean;
  /** True when assurance ran with reduced coverage (a sensor degraded). */
  reducedAssurance: boolean;
  /** Q2b — an adverse verdict landed AFTER an early sign (amendment alert). */
  postSignAlert: boolean;
  updatedAt: string;
  closed: boolean;
}

/** Classification of a raw SSE `message` payload. */
export type HarnessAssuranceMessage =
  { kind: 'event'; event: HarnessAssuranceEvent } | { kind: 'closed'; event: HarnessAssuranceEvent } | { kind: 'heartbeat' } | { kind: 'invalid' };

function isHeartbeat(value: Record<string, unknown>): boolean {
  if (value.type === 'heartbeat' || value.heartbeat === true) return true;
  // A bare {} or a payload with no assurance content is treated as a keep-alive.
  const hasContent = Array.isArray(value.claims) || typeof value.consultationId === 'string';
  return !hasContent && value.closed !== true;
}

/** Coerce a parsed payload into a well-formed `HarnessAssuranceEvent`. */
export function normalizeHarnessAssuranceEvent(raw: Record<string, unknown>): HarnessAssuranceEvent {
  // Dedupe-last keyed on `claimId+sensor`: duplicate keys in a malformed payload
  // would otherwise become duplicate React keys in the verdict list.
  const byKey = new Map<string, HarnessAssuranceClaim>();
  if (Array.isArray(raw.claims)) {
    (raw.claims as unknown[]).forEach((entry, index) => {
      if (typeof entry !== 'object' || entry === null) return;
      const c = entry as Record<string, unknown>;
      if (typeof c.claimId !== 'string' || !c.claimId) return;
      if (typeof c.sensor !== 'string' || !c.sensor) return;
      byKey.set(`${c.claimId}__${c.sensor}`, {
        claimId: c.claimId,
        sensor: c.sensor,
        verdict: typeof c.verdict === 'string' ? c.verdict : '',
        label: typeof c.label === 'string' && c.label ? c.label : undefined,
        ordinal: typeof c.ordinal === 'number' && Number.isFinite(c.ordinal) ? c.ordinal : index + 1,
        at: typeof c.at === 'string' ? c.at : '',
      });
    });
  }
  const claims: HarnessAssuranceClaim[] = [...byKey.values()].sort((a, b) => a.ordinal - b.ordinal);

  return {
    consultationId: typeof raw.consultationId === 'string' ? raw.consultationId : '',
    jobId: typeof raw.jobId === 'string' ? raw.jobId : undefined,
    total: typeof raw.total === 'number' && Number.isFinite(raw.total) ? raw.total : undefined,
    claims,
    gateDecision: typeof raw.gateDecision === 'string' ? raw.gateDecision : null,
    safetyFlag: raw.safetyFlag === true,
    reducedAssurance: raw.reducedAssurance === true,
    postSignAlert: raw.postSignAlert === true,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    closed: raw.closed === true,
  };
}

/**
 * Classify a raw SSE data string. Heartbeats and parse failures never throw —
 * the stream hook simply ignores them.
 */
export function reduceHarnessAssuranceMessage(rawData: string): HarnessAssuranceMessage {
  const trimmed = rawData?.trim();
  if (!trimmed) return { kind: 'heartbeat' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: 'invalid' };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'invalid' };
  }

  const value = parsed as Record<string, unknown>;
  if (isHeartbeat(value)) return { kind: 'heartbeat' };

  const event = normalizeHarnessAssuranceEvent(value);
  return event.closed ? { kind: 'closed', event } : { kind: 'event', event };
}
