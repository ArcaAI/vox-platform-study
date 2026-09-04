/**
 * (realtime-trigger binding) — resolves a PUBLISHED `stt`-palette
 * `WorkflowDefinition` to the `pipelineId` an EXISTING STT entry point (realtime WS or batch)
 * should bind to.
 *
 * central design decision, restated for this file: publishing an `stt`-palette
 * `WorkflowDefinition` never creates a new execution surface — it compiles into an `AsrPipeline`
 * (Task 4, `SttPipelineCompilerService`). This resolver is therefore the ONLY piece Task 6 adds:
 * given the tenant + the `WorkflowDefinition.slug` a session/consultation-open call wants to
 * bind to, it finds the currently-PUBLISHED row for that slug, re-derives the SAME deterministic
 * `AsrPipeline` slug Task 4's compiler wrote to (`sttWorkflowPipelineSlug`), and looks up its id
 * through `PipelineService` — never a raw repository call, and never a second, parallel mapping
 * of `WorkflowDefinition -> AsrPipeline` maintained by hand.
 *
 * Deliberately NOT built here (out of scope, per Task 6 + the grep-gate
 * test proving it): the actual call site that invokes `resolvePipelineId` from a real
 * session/consultation-open flow. `apps/api/src/modules/streaming/**` and
 * `apps/stt/src/stt/streaming/**` are untouched by this ticket's diff — wiring THIS resolver
 * into `CreateStreamingSessionRequest.pipelineId` resolution is the next pass's job.
 */
import { Injectable } from '@nestjs/common';
import { WorkflowDefinitionRepository } from '@arcaai/domains';
import { sttWorkflowPipelineSlug } from '../compilers/stt-pipeline.compiler';
import { PipelineService } from '../../stt/pipeline/pipeline.service';

const STT_PALETTE_KEY = 'stt';

@Injectable()
/** @deprecated TASK-861 — removed in R4. Never wired on the hot path; the ASR Agent path (`AsrAgentResolverService`) is the one resolution. */
export class SttPipelineResolverService {
  constructor(
    private readonly workflowDefinitionRepository: WorkflowDefinitionRepository,
    private readonly pipelineService: PipelineService,
  ) {}

  /**
   * Returns the `AsrPipeline` id a session for `workflowDefinitionSlug` should bind to, or
   * `null` when there is no PUBLISHED `stt`-palette definition for that slug, or no compiled
   * `AsrPipeline` row exists yet for it. Never throws for an absent binding — an absent binding
   * means "fall back to the tenant's existing pipeline resolution" (`resolveDefaultPipelineId` /
   * `fallback_pipeline_id`,, not a hard error.
   */
  async resolvePipelineId(tenantId: string, workflowDefinitionSlug: string): Promise<string | null> {
    const published = await this.workflowDefinitionRepository.findPublishedBySlug(tenantId, workflowDefinitionSlug);
    if (!published || published.paletteKey !== STT_PALETTE_KEY) {
      return null;
    }

    const pipelineSlug = sttWorkflowPipelineSlug(published.slug);
    const pipeline = await this.pipelineService.getBySlug(pipelineSlug);
    return pipeline?.id ?? null;
  }
}
