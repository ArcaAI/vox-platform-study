/**
 * TASK-1038 D-I — the result a workflow run DELIVERED.
 *
 * The harness puts it on `workflow.run.completed` (`payload.result`; absent when the graph
 * delivered nothing). The gateway persists it verbatim as `WorkflowRun.resultRef` and serves it
 * from `GET workflows/:slug/runs/:runId/result`:
 *
 * - `inline` — the output itself, small enough (≤ 64 KB, the producer's rule) to travel inline;
 * - `ref` — a claim-check pointer into object storage, for which the route signs a short-lived
 *   GET URL.
 *
 * Once `workflowRuns.resultRetentionDays` has passed, the daily purge replaces the stored value
 * with an `expired` TOMBSTONE (the run's status and counts are kept; only the output goes), so
 * the result route can answer "this existed and is gone" (410) rather than "there never was one".
 */
export type DeliveredRunResult =
  | { kind: 'inline'; value: unknown }
  | { kind: 'ref'; bucket: string; key: string; sizeBytes: number; sha256: string };

export interface ExpiredRunResult {
  kind: 'expired';
  expiredAt: string;
}

export type PersistedRunResult = DeliveredRunResult | ExpiredRunResult;

/** Structural check — a malformed value is never persisted or served as if it were a result. */
export function isDeliveredRunResult(value: unknown): value is DeliveredRunResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'inline') return Object.prototype.hasOwnProperty.call(candidate, 'value');
  if (candidate.kind === 'ref') {
    return (
      typeof candidate.bucket === 'string' &&
      candidate.bucket.length > 0 &&
      typeof candidate.key === 'string' &&
      candidate.key.length > 0 &&
      typeof candidate.sizeBytes === 'number' &&
      Number.isFinite(candidate.sizeBytes) &&
      candidate.sizeBytes >= 0 &&
      typeof candidate.sha256 === 'string' &&
      candidate.sha256.length > 0
    );
  }
  return false;
}

/** `payload.result` of a completed event (or a harness status read) → a validated result, or `undefined`. */
export function deliveredRunResultFrom(payload: Record<string, unknown> | null | undefined): DeliveredRunResult | undefined {
  const result = payload?.result;
  return isDeliveredRunResult(result) ? result : undefined;
}

/**
 * The stored `WorkflowRun.resultRef` → what it means, or `null` when the run delivered nothing.
 *
 * Also reads the two shapes the column's schema comment described before this ticket
 * (`{ outputs }` inline, `{ resultRef: { bucket, key, sizeBytes } }` claim-checked): no producer
 * ever wrote them (D-I), but a row written by hand or by a test fixture must not be misread.
 */
export function readPersistedRunResult(stored: unknown): PersistedRunResult | null {
  if (isDeliveredRunResult(stored)) return stored;
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const candidate = stored as Record<string, unknown>;
  if (candidate.kind === 'expired' && typeof candidate.expiredAt === 'string') return { kind: 'expired', expiredAt: candidate.expiredAt };
  if (Object.prototype.hasOwnProperty.call(candidate, 'outputs')) return { kind: 'inline', value: candidate.outputs };
  const legacy = candidate.resultRef as Record<string, unknown> | undefined;
  if (legacy && typeof legacy.bucket === 'string' && typeof legacy.key === 'string') {
    return {
      kind: 'ref',
      bucket: legacy.bucket,
      key: legacy.key,
      sizeBytes: typeof legacy.sizeBytes === 'number' ? legacy.sizeBytes : 0,
      sha256: typeof legacy.sha256 === 'string' ? legacy.sha256 : '',
    };
  }
  return null;
}
