/**
 * TASK-1038 D-I — the result a run DELIVERED, as the harness puts it on `workflow.run.completed`
 * (`payload.result`; absent when the graph delivered nothing). The same value is persisted
 * verbatim as `WorkflowRun.resultRef` and served by `GET workflows/:slug/runs/:runId/result`.
 *
 * - `inline` — the output itself, small enough (≤ 64 KB, the producer's rule) to travel inline.
 * - `ref` — a claim-check pointer into object storage; the result route signs a short-lived URL.
 */
export type RunResult =
  | { kind: 'inline'; value: unknown }
  | { kind: 'ref'; bucket: string; key: string; sizeBytes: number; sha256: string };

/** Structural check — a malformed value is never persisted as if it were a result. */
export function isRunResult(value: unknown): value is RunResult {
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

/** `payload.result` of a completed event → a validated result, or `undefined`. */
export function runResultFromPayload(payload: Record<string, unknown> | undefined): RunResult | undefined {
  const result = payload?.result;
  return isRunResult(result) ? result : undefined;
}
