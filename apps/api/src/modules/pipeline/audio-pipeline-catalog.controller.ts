import { PipelineResponse, PipelineService } from '@arcaai/applications';
import { Controller, NotFoundException, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiEndpoint, Authorize, RequiredScopes } from '../../decorators';

/**
 * Read-only ASR pipeline catalog for clinicians — the non-admin half of
 * `audio/pipelines` (`AudioPipelineController` at `admin/audio/pipelines` is
 * the admin half).
 *
 * (drift D-E): this class used to carry `Public` in its name, which
 * read as "the `@Public()` one". It never carried `@Public` — it is
 * `@Authorize()` + `@ForbidApiKey()`-free JWT/key surface, and "public" here
 * only ever meant "non-admin". `@Public()` means UNAUTHENTICATED everywhere
 * else in this codebase (it is the deny-by-default opt-out the boot audits
 * read), so the name was actively misleading. The PATH is unchanged: this is a
 * class rename, nothing else.
 */
@ApiBearerAuth()
@ApiTags('audio-pipelines')
@Controller('audio/pipelines')
@Authorize()
// API-KEY-NOTE: policy A1. Read-only ASR pipeline catalog — REUSES the
// existing `stt:model:read` rather than minting a scope of its own: this is
// the pipeline half of the same "what can I transcribe with" question the
// STT model list answers, and a key issued to transcribe already needs it.
@RequiredScopes('stt:model:read')
/** @deprecated TASK-861 — removed in R4 with `AsrPipeline`; `GET /agents?task=SPEECH_TO_TEXT` is the replacement catalogue. Reads keep answering for the window. */
export class AudioPipelineCatalogController {
  constructor(private readonly pipelineService: PipelineService) {}

  @ApiEndpoint({
    returnedModel: PipelineResponse,
    multi: true,
  })
  async fetchAll(): Promise<PipelineResponse[]> {
    return this.pipelineService.getAll();
  }

  /**
   * Non-admin read-by-id (tenant-scoped via `getById`).
   *
   * Cross-tenant lookups return 404 (not 403) to avoid existence leaks.
   */
  @ApiEndpoint({
    returnedModel: PipelineResponse,
    path: ':id',
    by: ['id'],
  })
  @ApiParam({ name: 'id', description: 'Pipeline ID', type: String })
  @ApiResponse({ status: 404, description: 'Pipeline not found' })
  async fetchById(@Param('id') id: string): Promise<PipelineResponse> {
    const pipeline = await this.pipelineService.getById(id);
    if (!pipeline) {
      throw new NotFoundException(`Pipeline ${id} not found`);
    }
    return pipeline;
  }

  /**
   * Non-admin read-by-slug (tenant-scoped via `getBySlug`).
   */
  @ApiEndpoint({
    returnedModel: PipelineResponse,
    path: 'slug/:slug',
    by: ['slug'],
  })
  @ApiParam({ name: 'slug', description: 'Pipeline slug', type: String })
  @ApiResponse({ status: 404, description: 'Pipeline not found' })
  async fetchBySlug(@Param('slug') slug: string): Promise<PipelineResponse> {
    const pipeline = await this.pipelineService.getBySlug(slug);
    if (!pipeline) {
      throw new NotFoundException(`Pipeline ${slug} not found`);
    }
    return pipeline;
  }
}
