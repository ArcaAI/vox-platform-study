import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Live state of ONE `core.humanReview` node of a run — the projection of the review child
 * workflow's `state` query (`apps/harness/.../review_workflow.py`).
 *
 * `exists: false` is a NORMAL answer, not an error: the node has not been reached yet, or the
 * review already settled and the child is gone. It is deliberately distinct from a 404, which
 * means the RUN is not yours (or not this slug's) — a reviewer UI must be able to tell
 * "nothing to decide here" from "you are looking at someone else's run".
 */
export class WorkflowReviewResponse {
  @ApiProperty()
  runId: string;

  @ApiProperty({ description: 'The graph node id of the `core.humanReview` node — a graph may carry several.' })
  nodeId: string;

  @ApiProperty({ description: 'Whether a review child is currently live for this node. `false` is normal.' })
  exists: boolean;

  @ApiPropertyOptional({ nullable: true, description: 'WAITING | ESCALATED | DECIDED | TIMED_OUT. `null` when no child exists.' })
  phase: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'How many times the wait has escalated. `null` when no child exists.' })
  escalations: number | null;

  @ApiProperty({ description: 'Whether a decision signal has been accepted. A review is decided once; a second signal is ignored.' })
  decided: boolean;

  @ApiPropertyOptional({
    nullable: true,
    enum: ['approved', 'rejected'],
    description: 'The decision, once made. `null` while waiting — NEVER a default, because a timeout must not read as an approval.',
  })
  decision: 'approved' | 'rejected' | null;
}

/** Response of `POST …/reviews/:nodeId/decide` — the signal was SENT; the graph resumes on its own clock. */
export class WorkflowReviewDecisionResponse {
  @ApiProperty()
  runId: string;

  @ApiProperty()
  nodeId: string;

  @ApiProperty({ description: 'The decision the interpreter was signalled with.' })
  decision: 'approved' | 'rejected';

  @ApiProperty({ description: 'True once the signal reached the review child. The graph may not have resumed yet.' })
  signaled: boolean;

  @ApiPropertyOptional({ nullable: true, description: 'The acting user, resolved from CLS by the gateway — never from the request body.' })
  reviewerId: string | null;
}
