import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body of `POST /api/v1/workflows/:slug/runs/:runId/reviews/:nodeId/decide` (TASK-890 §3.9).
 *
 * The wire shape of the interpreter's own `ReviewDecisionRequest`
 * (`apps/harness/src/harness/api/endpoints/interpreter.py`) MINUS `reviewerId`.
 *
 * **`reviewerId` is deliberately absent and must stay absent.** The gateway resolves the acting
 * user from CLS and stamps it on the way through — the same rule
 * `ApproveWorkflowRunGateInput.clinicianId` records ("the ACTING user, resolved server-side from
 * CLS — never accepted from a client body"). A review decision is an attribution, and a body
 * field would let a caller attribute their own approval to someone else. The global pipe runs
 * `forbidNonWhitelisted`, so a body that carries `reviewerId` is a 400 rather than a silently
 * dropped field — which is the difference between "you may not do that" and "we ignored you".
 */
export class ReviewDecisionRequest {
  @ApiProperty({ enum: ['approved', 'rejected'], description: 'The human decision. There is no third value: a timeout is the workflow’s own outcome, never a decision.' })
  @IsIn(['approved', 'rejected'])
  decision: 'approved' | 'rejected';

  @ApiPropertyOptional({ description: 'Free-text rationale recorded with the decision.' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  comment?: string;

  @ApiPropertyOptional({
    type: Object,
    description:
      'A corrected payload to hand back to the graph in place of what was reviewed. Honoured ONLY when the review node was authored with `allowEdit` — the workflow drops it otherwise (`review_workflow.py`), which is the node author’s decision and not this route’s.',
  })
  @IsOptional()
  @IsObject()
  editedPayload?: Record<string, unknown>;
}
