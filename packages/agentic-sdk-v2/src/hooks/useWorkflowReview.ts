/**
 * @arcaai/vox — `useWorkflowReview` (TASK-890).
 *
 * A `core.humanReview` node parks a workflow run on a person and waits, durably, for as long
 * as the node says. Every node downstream of a handle that does not fire is skipped. Since
 * TASK-864 the wait and its two routes have existed on the INTERPRETER, behind the internal
 * service token — so a tenant whose graph contained a review had no way to release it except
 * an operator signalling Temporal by hand. This is the browser client for the gateway proxy.
 *
 * ```tsx
 * const { review, fetchReview, decide } = useWorkflowReview();
 *
 * await fetchReview(slug, runId, nodeId);
 * if (review?.exists && !review.decided) await decide(slug, runId, nodeId, { decision: 'approved' });
 * ```
 *
 * ## The distinction this hook exists to preserve
 *
 * Three outcomes look alike on a screen and must not be one value:
 *
 *   * `review.exists === false` — the interpreter answered: the node has not been reached, or
 *     the review already settled and its durable child is gone. Genuinely nothing to decide.
 *   * `review === null` + `error` — we could not ASK. A 503, an outage, a dropped connection.
 *   * a 404 — the run is not yours, or not this slug's.
 *
 * A reviewer queue that renders the second as the first goes quietly empty during an outage,
 * which is how queued clinical work disappears. So `fetchReview` fails OPEN to `null` (a
 * review panel must not break the screen it sits on) while never manufacturing an answer.
 *
 * `decide`, by contrast, REJECTS on failure. Failing open on a read costs a re-read; failing
 * open on a write would tell a clinician their approval landed when it did not.
 *
 * ## `reviewerId` is not yours to send
 *
 * The gateway resolves the acting user from your session and stamps it; its request DTO
 * declares no such field, so a body carrying one is a 400. This hook drops it at the call site
 * rather than letting that become a confusing round trip — an approval is an attribution.
 */

import { useCallback, useState } from 'react';
import { useApiOperation } from './useApiOperation';
import { WORKFLOW_ENDPOINTS } from '../core/constants';
import type { WorkflowReview, WorkflowReviewDecision, WorkflowReviewDecisionResult } from '../types/workflowRun';

export interface UseWorkflowReviewReturn {
  /**
   * The last review state read, or `null` when the read has not resolved — or FAILED.
   * NEVER conflate `null` with `{ exists: false }`.
   */
  review: WorkflowReview | null;
  /** Read one review node's live state. Resolves to `null` rather than rejecting. */
  fetchReview: (slug: string, runId: string, nodeId: string) => Promise<WorkflowReview | null>;
  /**
   * Release the review with a decision. Rejects on failure — a decision that did not land must
   * not look like one that did. Returns once the signal was SENT; the graph resumes on its own
   * clock, so watch the run stream for what happens next.
   */
  decide: (slug: string, runId: string, nodeId: string, body: WorkflowReviewDecision) => Promise<WorkflowReviewDecisionResult>;
  isLoading: boolean;
  /** Why the last read or decision failed, if it did. */
  error: Error | null;
}

export function useWorkflowReview(): UseWorkflowReviewReturn {
  const { execute, isLoading, error } = useApiOperation('useWorkflowReview');
  const [review, setReview] = useState<WorkflowReview | null>(null);

  const fetchReview = useCallback(
    async (slug: string, runId: string, nodeId: string): Promise<WorkflowReview | null> => {
      try {
        return await execute<WorkflowReview | null>('getWorkflowReview', async (client) => {
          const state = await client.get<WorkflowReview>(WORKFLOW_ENDPOINTS.RUN_REVIEW(slug, runId, nodeId));
          // A payload that is not an object is "we could not ask", not "no review": handing a
          // non-object to a reviewer panel renders a false empty state.
          const value = state !== null && typeof state === 'object' ? state : null;
          setReview(value);
          return value;
        });
      } catch {
        // Fail-open: `execute` has already recorded the reason on `error`. The caller sees
        // `null` — which its own UI must not draw as "nothing to approve".
        setReview(null);
        return null;
      }
    },
    [execute],
  );

  const decide = useCallback(
    async (slug: string, runId: string, nodeId: string, body: WorkflowReviewDecision): Promise<WorkflowReviewDecisionResult> => {
      const result = await execute<WorkflowReviewDecisionResult>('decideWorkflowReview', (client) =>
        // Rebuilt field by field rather than spread: the gateway DTO forbids undeclared
        // properties, so forwarding a caller's object wholesale turns one stray key — a
        // hand-written `reviewerId` most of all — into a 400 the caller cannot read.
        client.post<WorkflowReviewDecisionResult>(WORKFLOW_ENDPOINTS.RUN_REVIEW_DECIDE(slug, runId, nodeId), {
          decision: body.decision,
          ...(body.comment === undefined ? {} : { comment: body.comment }),
          ...(body.editedPayload === undefined ? {} : { editedPayload: body.editedPayload }),
        }),
      );
      // Best-effort refresh so a panel reflects the decision without a second call. It never
      // masks the result: the decision above already succeeded.
      void fetchReview(slug, runId, nodeId);
      return result;
    },
    [execute, fetchReview],
  );

  return { review, fetchReview, decide, isLoading, error };
}
