import type { AiActivityKind, AiActivityRunStatus } from '@arcaai/domains';

/** One AI activity (a model call, an STT session, a sensor). Ids, enums and numbers only — never free text. */
export interface AiActivityRunInput {
  tenantId: string;
  /** `<producer>:<sessionId>:<runId>:<seq>` — the idempotent upsert key. */
  runKey: string;
  consultationId?: string | null;
  encounterSeq?: number | null;
  activityKind: AiActivityKind;
  status: AiActivityRunStatus;
  workflowSlug?: string | null;
  workflowVersion?: number | null;
  workflowRunId?: string | null;
  nodeId?: string | null;
  agentId?: string | null;
  agentSlug?: string | null;
  agentVersion?: number | null;
  promptTemplateId?: string | null;
  promptVersion?: number | null;
  model?: string | null;
  provider?: string | null;
  deployment?: string | null;
  startedAt: Date;
  endedAt?: Date | null;
  durationMs?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  contextUsed?: number | null;
  contextWindow?: number | null;
  outputCap?: number | null;
  stopReason?: string | null;
  budgetStrategy?: string | null;
  callIndex?: number | null;
  callCount?: number | null;
  costMicros?: bigint | null;
  costBasis?: string | null;
  usageRequestId?: string | null;
  errorCode?: string | null;
  contextItemId?: string | null;
  outputVersionNumber?: number | null;
}

export abstract class IAiActivityRunService {
  abstract record(input: AiActivityRunInput, tx?: unknown): Promise<void>;
}

export const IAiActivityRunServiceToken = Symbol('IAiActivityRunService');

/** The run that produced a given item version — feedback provenance and the console Run table. */
export interface ActivityRunProducer {
  activityRunId: string;
  activityKind: AiActivityKind;
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
  promptVersion: number | null;
  startedAt: Date;
  endedAt: Date | null;
  contextUsed: number | null;
  contextWindow: number | null;
  outputCap: number | null;
  stopReason: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costMicros: bigint | null;
  costBasis: string | null;
  durationMs: number | null;
}

export abstract class IActivityRunRecordReader {
  abstract findProducerOf(input: {
    tenantId: string;
    consultationId: string;
    contextItemId: string;
    versionNumber?: number;
  }): Promise<ActivityRunProducer | null>;
  abstract listForConsultation(input: { tenantId: string; consultationId: string }): Promise<ActivityRunProducer[]>;
}

export const IActivityRunRecordReaderToken = Symbol('IActivityRunRecordReader');
