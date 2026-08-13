/**
 * @arcaai/vox - Consultation-loop workflow event types.
 *
 * Mirrors the gateway `LoopEventDto` published on `consultation:loop:{id}`
 * and relayed verbatim over `GET /consultations/:id/loop/stream`. Carries NO
 * PHI: kind/label/data are ids and short strings only (mirrors
 * `HarnessProgressRequest`'s payload-bound posture server-side).
 */
export interface LoopEvent {
  consultationId: string;
  tenantId?: string;
  /** Loop run id (Temporal workflow/run identity), for ops correlation. */
  runId?: string;
  /** Event kind — an OPEN string namespace (e.g. `action.started`, `specialist.dispatched`), not a closed enum. */
  kind: string;
  /** Human-readable label rendered by the UI. */
  label?: string;
  /** Free-form event detail (no PHI — ids/labels only). */
  data?: Record<string, unknown>;
  publishedAt: string;
}
