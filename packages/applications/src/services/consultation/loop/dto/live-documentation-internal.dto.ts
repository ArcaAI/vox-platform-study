import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * TASK-662 — body of `POST /internal/harness/consultations/:id/live-documentation/start`.
 * The (future) `ConsultationLoopWorkflow`'s `livedoc.start` action calls
 * `LiveDocumentationService.start()` through this route; the loop never
 * imports `@arcaai/applications` service internals directly (harness is a
 * separate deployable), so this is the wire shape.
 */
export class HarnessLiveDocStartRequest {
  @ApiProperty({ description: 'Tenant the loop is acting on behalf of' })
  @IsString()
  @IsNotEmpty()
  tenantId: string;

  @ApiPropertyOptional({ description: 'Acting user id, when known' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ description: 'STT streaming session id; when present the watcher subscribes to its transcript stream.' })
  @IsOptional()
  @IsString()
  sessionId?: string;
}

/** Body of `POST /internal/harness/consultations/:id/live-documentation/stop`. */
export class HarnessLiveDocStopRequest {
  @ApiProperty({ description: 'Tenant the loop is acting on behalf of' })
  @IsString()
  @IsNotEmpty()
  tenantId: string;

  @ApiPropertyOptional({ description: 'Whether to persist the final snapshot as a PRE_SUMMARY context item.' })
  @IsOptional()
  @IsBoolean()
  persistSnapshot?: boolean;
}

/** Best-effort ack — mirrors `HarnessLoopEventAck`/`HarnessProgressAck`. */
export interface HarnessLiveDocAck {
  ok: boolean;
}
