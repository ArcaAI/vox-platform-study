import { BadRequestException, Controller, Get, Param, Query, Sse, type MessageEvent } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Observable } from 'rxjs';
import { ConsultationLifecycleEventPublisher } from '@arcaai/applications';
import { Authorize, RequiredScopes, RequiredSvcScopes } from '../../decorators';
import { TenantOwnedResource } from '../../common';
import { StreamScope } from '../auth';

/**
 * `GET consultations/:id/events` — the consultation's lifecycle events (opened, started, paused,
 * stopped, transcript_final, processing_changed, approved, closed, reopened …) over SSE, with a
 * `?since=<seq>` replay from the publisher's buffer. Guarded like the live-summary stream: the
 * tenant is asserted before the stream opens (cross-tenant 404), a JWT client may use a
 * single-use `consultation_lifecycle:<id>` ticket, a machine presents its own credential.
 */
@ApiBearerAuth()
@ApiTags('consultations')
@Controller('consultations')
@Authorize()
@RequiredScopes('consultation:session:write')
export class ConsultationLifecycleEventsController {
  constructor(private readonly events: ConsultationLifecycleEventPublisher) {}

  @Get(':id/events')
  @Sse()
  @TenantOwnedResource({ modelName: 'Consultation', paramName: 'id' })
  @StreamScope({ namespace: 'consultation_lifecycle', param: 'id' })
  @RequiredSvcScopes('svc:consultation:session:write')
  @ApiOperation({
    summary: 'Stream lifecycle events for a consultation via SSE',
    description:
      'Server-Sent Events, one `LifecycleEvent` JSON per frame: `{type, consultationId, status, processing, processingReason?, closedReason?, encounterSeq, version, at, seq}`. ' +
      '`status` here is always the seven-value lifecycle vocabulary. Frames carry state only, never content. ' +
      '`since` replays the buffered frames with a greater `seq` (the last 50) before the live ones; a client that reconnects passes the last `seq` it saw. ' +
      'A consultation silent for 30 days restarts its `seq` at 1 — re-read the consultation then. ' +
      'Accepts `Authorization: Bearer <jwt>`, a service-account token, or a single-use `?ticket=<ticket>` from `POST /auth/stream-ticket` with scope `consultation_lifecycle:<id>`. ' +
      'Consumers that hold no connection learn the same changes through the `ResourceUpdated` webhook (`data.action = "lifecycle"`).',
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiQuery({ name: 'since', required: false, type: Number, description: 'Replay frames with a `seq` greater than this.' })
  @ApiResponse({ status: 400, description: '`since` is not a non-negative integer.' })
  @ApiResponse({ status: 404, description: 'Consultation not found — also the answer for a cross-tenant id, resolved before the stream opens.' })
  streamEvents(@Param('id') id: string, @Query('since') since?: string): Observable<MessageEvent> {
    return this.events.subscribe(id, parseSince(since));
  }
}

function parseSince(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new BadRequestException({ code: 'SINCE_INVALID', message: '`since` must be a non-negative integer event sequence number.' });
  }
  return Number(raw);
}
