import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ActivityRunProducer, IActivityRunRecordReader, IActivityRunRecordReaderToken } from '../../ai-activity-run/IAiActivityRunService';
import { IContextService } from '../context/IContextService';

/**
 * What produced the rated item version, frozen onto the feedback row: ids, slugs, versions and
 * model names only — never content. `source` says which record answered.
 */
export interface FeedbackProvenanceSnapshot {
  source: 'activity_run' | 'summary_meta';
  activityRunId: string | null;
  activityKind: string | null;
  encounterSeq: number | null;
  workflowSlug: string | null;
  workflowVersion: number | null;
  workflowRunId: string | null;
  nodeId: string | null;
  agentSlug: string | null;
  agentVersion: number | null;
  modelName: string | null;
  provider: string | null;
  deployment: string | null;
  promptTemplateId: string | null;
  promptVersion: string | null;
}

/** The denormalised `prov*` columns the rollup groups by. */
export interface FeedbackProvenanceColumns {
  provAgentSlug: string | null;
  provAgentVersion: number | null;
  provModelName: string | null;
  provPromptVersion: string | null;
  provWorkflowRunId: string | null;
  provActivityRunId: string | null;
}

export function provenanceColumns(snapshot: FeedbackProvenanceSnapshot | null): FeedbackProvenanceColumns {
  return {
    provAgentSlug: snapshot?.agentSlug ?? null,
    provAgentVersion: snapshot?.agentVersion ?? null,
    provModelName: snapshot?.modelName ?? null,
    provPromptVersion: snapshot?.promptVersion ?? null,
    provWorkflowRunId: snapshot?.workflowRunId ?? null,
    provActivityRunId: snapshot?.activityRunId ?? null,
  };
}

function fromProducer(run: ActivityRunProducer): FeedbackProvenanceSnapshot {
  return {
    source: 'activity_run',
    activityRunId: run.activityRunId,
    activityKind: run.activityKind ?? null,
    encounterSeq: run.encounterSeq,
    workflowSlug: run.workflowSlug,
    workflowVersion: run.workflowVersion,
    workflowRunId: run.workflowRunId,
    nodeId: run.nodeId,
    agentSlug: run.agentSlug,
    agentVersion: run.agentVersion,
    modelName: run.modelName,
    provider: run.provider,
    deployment: run.deployment,
    promptTemplateId: run.promptTemplateId,
    promptVersion: run.promptVersion === null || run.promptVersion === undefined ? null : String(run.promptVersion),
  };
}

/**
 * Resolves the provenance of a rated item version. The activity-run record is authoritative;
 * until it is wired (or when it has no producer for the item) the item's `SummaryMeta` answers,
 * which covers generated notes only. Provenance is best-effort: a failing lookup yields `null`
 * rather than refusing the clinician's feedback.
 */
@Injectable()
export class FeedbackProvenanceResolver {
  private readonly logger = new Logger(FeedbackProvenanceResolver.name);

  constructor(
    @Inject(IContextService) private readonly contextService: Pick<IContextService, 'getSummaryMeta'>,
    @Optional() @Inject(IActivityRunRecordReaderToken) private readonly runReader?: IActivityRunRecordReader,
  ) {}

  async resolve(input: {
    tenantId: string;
    consultationId: string;
    contextItemId: string;
    versionNumber?: number;
  }): Promise<FeedbackProvenanceSnapshot | null> {
    if (this.runReader) {
      try {
        const run = await this.runReader.findProducerOf(input);
        if (run) return fromProducer(run);
      } catch (error) {
        this.logger.warn({ message: 'feedback.provenance_run_lookup_failed', consultationId: input.consultationId, error: errorText(error) });
      }
    }
    try {
      const meta = await this.contextService.getSummaryMeta(input.contextItemId);
      if (!meta) return null;
      return {
        source: 'summary_meta',
        activityRunId: null,
        activityKind: null,
        encounterSeq: null,
        workflowSlug: null,
        workflowVersion: null,
        workflowRunId: null,
        nodeId: null,
        agentSlug: null,
        agentVersion: null,
        modelName: meta.aiModelVersion ?? meta.aiModelId ?? null,
        provider: null,
        deployment: null,
        promptTemplateId: null,
        promptVersion: meta.promptVersion ?? null,
      };
    } catch (error) {
      this.logger.warn({ message: 'feedback.provenance_summary_meta_failed', consultationId: input.consultationId, error: errorText(error) });
      return null;
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
