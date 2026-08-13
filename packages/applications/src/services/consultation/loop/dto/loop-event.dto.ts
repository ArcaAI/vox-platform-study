import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * One event the (future) `ConsultationLoopWorkflow` reports for
 * the live client feed — e.g. an action started/finished, a specialist
 * dispatched, derived context re-entering the bus. Carries NO PHI: kind/label
 * ids only, mirroring `HarnessProgressRequest`'s payload-bound posture.
 */
export class HarnessLoopEventRequest {
  @ApiProperty({ description: 'Tenant the loop is acting on behalf of' })
  @IsString()
  @MaxLength(256)
  tenantId: string;

  @ApiPropertyOptional({ description: 'Loop run id (Temporal workflow/run identity), for ops correlation' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  runId?: string;

  @ApiProperty({ description: 'Event kind (e.g. action.started, action.completed, specialist.dispatched)' })
  @IsString()
  @MaxLength(128)
  kind: string;

  @ApiPropertyOptional({ description: 'Human-readable label rendered by the UI' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  label?: string;

  @ApiPropertyOptional({ description: 'Free-form event detail (no PHI — ids/labels only)', nullable: true })
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;
}

/** Best-effort ack — publishing never fails the loop workflow. */
export interface HarnessLoopEventAck {
  ok: boolean;
}

/**
 * The event published on `consultation:loop:{consultationId}` for the SSE
 * relay. Append-only feed (mirrors `consultation:trajectory:{id}`) — every
 * message is self-contained, no fold/snapshot/late-join.
 */
export interface LoopEventDto {
  consultationId: string;
  tenantId?: string;
  runId?: string;
  kind: string;
  label?: string;
  data?: Record<string, unknown>;
  publishedAt: string;
}
