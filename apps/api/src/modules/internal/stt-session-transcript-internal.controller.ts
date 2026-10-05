import { RunAudioTranscriptService } from '@arcaai/applications';
import type { IActiveUserContext, RunAudioTranscript } from '@arcaai/applications';
import { BadRequestException, Controller, Get, Headers, Param, Query, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { Public } from '../../decorators';
import { HarnessServiceTokenGuard } from '../consultation/harness-service-token.guard';

/**
 * TASK-1042 (C5) — the gateway half of the harness's live-audio read: the finals of the live STT
 * session bound to a standalone run (`input.<audio>.sttSessionId` at run start).
 *
 * Service-to-service only: `@Public()` exempts it from the user-JWT chain and
 * `HarnessServiceTokenGuard` authenticates `X-Service-Token` (the shared `INTERNAL_ACCESS_TOKEN`
 * or the harness's own). Deliberately NOT `InternalServiceTokenGuard`: that one requires a
 * `?service=` selector the harness does not send. `X-Tenant-Id` is MANDATORY (owner directive
 * 2026-08-16) and the read runs in a CLS context bound to it. A READ, so no `InternalTenantLockGuard`.
 *
 * No query DTO on purpose: `runId` is read as a plain query value, so an extra query parameter is
 * ignored rather than refused by the strict global pipe.
 *
 * 404 unless the session's STREAMING job is in that tenant AND bound to `runId` (the harness reads
 * a 404 as "unbound" and stops waiting). The 200 body is C5: `{ state, language, transcript,
 * finals }` — see `RunAudioTranscriptService` for how `truncated` and `timeout` are decided.
 *
 * Excluded from public Swagger (internal plane). Effective path:
 * `/api/v1/internal/stt/sessions/:sessionId/transcript?runId=`.
 */
@ApiExcludeController()
@Public()
@UseGuards(HarnessServiceTokenGuard)
@Controller('internal/stt/sessions')
export class SttSessionTranscriptInternalController {
  constructor(
    private readonly transcripts: RunAudioTranscriptService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  @Get(':sessionId/transcript')
  @ApiOperation({
    summary: 'The finals of the live STT session bound to a standalone workflow run',
    description:
      'Finals read from the session result stream from its first entry. `state` is `live`, `ended`, `truncated` (the retained ' +
      'stream no longer starts at the first final) or `timeout` (bound longer than workflowRuns.liveAudioMaxSeconds without ending).',
  })
  @ApiResponse({ status: 200, description: '`{ state, language, transcript, finals }`' })
  @ApiResponse({ status: 400, description: 'Missing X-Tenant-Id or runId.' })
  @ApiResponse({ status: 401, description: 'Missing or wrong X-Service-Token.' })
  @ApiResponse({ status: 404, description: 'Unknown session, another tenant`s, or not bound to runId.' })
  @ApiResponse({ status: 503, description: 'The result stream cannot be read right now; retry.' })
  async transcript(
    @Param('sessionId') sessionId: string,
    @Query('runId') runId: string | undefined,
    @Headers('x-tenant-id') tenantIdHeader: string | undefined,
  ): Promise<RunAudioTranscript> {
    const tenantId = tenantIdHeader?.trim();
    if (!tenantId) throw new BadRequestException('`X-Tenant-Id` is required on an internal transcript read.');
    const boundRunId = typeof runId === 'string' ? runId.trim() : '';
    if (!boundRunId) throw new BadRequestException('`runId` is required.');
    return this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      return this.transcripts.read({ tenantId, sttSessionId: sessionId, runId: boundRunId });
    });
  }
}
