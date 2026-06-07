import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body for `POST /admin/harness/workflows/:id/cancel` and `.../terminate`
 * (TASK-330 Phase 6 — Phase B). `reason` is forwarded to Temporal as the
 * cancel/terminate reason for the workflow-history record.
 */
export class WorkflowActionRequest {
  @ApiPropertyOptional({ description: 'Reason recorded on the Temporal cancel/terminate (audit trail).', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** Body for `POST /admin/harness/workflows/:id/signal`. */
export class SignalWorkflowRequest {
  @ApiProperty({ description: 'Temporal signal name to deliver (e.g. `approve`).', example: 'approve' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  signalName: string;

  @ApiPropertyOptional({ description: 'Optional JSON payload forwarded as the signal argument.' })
  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}
