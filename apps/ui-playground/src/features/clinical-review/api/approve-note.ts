import type { SummaryApprovalResponse } from '@arcaai/vox';

/**
 * Approve + sign a reviewed draft note (TASK-330 Phase 1, Lane J).
 *
 * Production wiring: once the harness draft endpoint persists the
 * PENDING_REVIEW note + `citationsMap`, the review screen loads off that live
 * consultation and this becomes a single call to the **already-existing**
 * approve endpoint —
 *
 *   POST /api/v1/consultations/:consultationId/summary/:noteContextItemId/approve
 *
 * surfaced by the SDK as `useArca().summary.approveSummary(noteContextItemId)`
 * (see `SUMMARY_ENDPOINTS.APPROVE`). The endpoint is server-side already; only
 * the draft/provenance source lands in a parallel lane.
 *
 * Until the screen is wired to live data we stub the round-trip so the demo
 * runs standalone. Swap the body for the SDK call when integrating.
 */
export async function approveReviewedNote(input: { consultationId: string; noteContextItemId: string }): Promise<SummaryApprovalResponse> {
  await new Promise((resolve) => setTimeout(resolve, 600));
  return {
    contextItemId: input.noteContextItemId,
    approvalStatus: 'APPROVED',
    approvedBy: 'demo-clinician',
    approvedAt: new Date().toISOString(),
  };
}
