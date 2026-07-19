import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * TASK-511 (Phase 3A) — body for `POST admin/prompt-templates/:id/approve`
 * (GLOBAL_ADMIN only). Approval flips the template to `status = APPROVED` (the
 * gate `prompt-resolution` requires for clinical flows), pins a `PromptVersion`
 * snapshot, and emits the audit sys-event. `expectedVersion` is the OCC token
 * (folded from the `If-Match` header by the `@RequiresIfMatch()` route; body
 * fallback for service-to-service callers).
 */
export class ApprovePromptTemplateRequest {
  @ApiPropertyOptional({ description: 'Free-text approval reason, recorded on the pinned PromptVersion + audit event.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional({ description: 'Current row version (from the prior GET). Approve fails 412 if it drifted.', example: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}
