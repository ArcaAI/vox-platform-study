import {
  AgentStepStatus,
  AgentStepType,
  AiActivityKind,
  AiActivityRunEntity,
  AiActivityRunStatus,
  AiCostBasis,
  AiDeploymentKind,
  type AgentTrajectoryStepEntity,
  type CreateAiActivityRunProps,
} from '@arcaai/domains';
import type { ActivityRunRecord, RunSummary } from '@arcaai/types';

import type { UsageEventBatchInput } from '../usageLedger/dto';
import type { ActivityRunProducer, AiActivityRunInput } from './IAiActivityRunService';

/**
 * `<producer>:<sessionId>:<runId>:<seq>`. The run id may be empty (the
 * non-Temporal sentinel); the producer and session may not, and the sequence
 * is a non-negative integer. A session id that itself contains `:` is
 * tolerated — the key only has to be stable, not parseable back.
 */
const RUN_KEY = /^[A-Za-z0-9_.-]+:[^\s:]+(?::[^\s:]*)+:\d+$/;

/**
 * An identifier: a slug, a uuid, a model id, a code. Anything with whitespace
 * or prose punctuation is not one — the run record holds ids, enums and
 * numbers only, so a value that does not match is dropped rather than stored.
 */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,199}$/;

/** The producer prefix of a run written for a trajectory step. */
export const TRAJECTORY_RUN_PRODUCER = 'trajectory';

/** Run status per trajectory step status; `STARTED` has no run yet. */
const STEP_STATUS_TO_RUN: Partial<Record<AgentStepStatus, AiActivityRunStatus>> = {
  [AgentStepStatus.OK]: AiActivityRunStatus.OK,
  [AgentStepStatus.ERROR]: AiActivityRunStatus.ERROR,
  [AgentStepStatus.SKIPPED]: AiActivityRunStatus.SKIPPED,
  [AgentStepStatus.TIMEOUT]: AiActivityRunStatus.TIMEOUT,
  [AgentStepStatus.DEGRADED]: AiActivityRunStatus.DEGRADED,
};

/** The step types that represent one AI activity. */
const RUN_STEP_TYPES: ReadonlySet<AgentStepType> = new Set([AgentStepType.LLM_CALL, AgentStepType.NODE]);

export function isRunKey(value: unknown): value is string {
  return typeof value === 'string' && RUN_KEY.test(value);
}

export function asIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return IDENTIFIER.test(trimmed) ? trimmed : null;
}

export function asCount(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}

function asEnum<T extends Record<string, string>>(enumObject: T, value: unknown): T[keyof T] | null {
  return typeof value === 'string' && Object.values(enumObject).includes(value) ? (value as T[keyof T]) : null;
}

function asMicros(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  const count = asCount(value);
  return count === null ? null : BigInt(count);
}

function asDate(value: unknown): Date | null {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
}

function pick(stats: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (stats[key] !== undefined && stats[key] !== null) return stats[key];
  }
  return undefined;
}

/** Trajectory step → run record extras that have no column (ids only). */
export interface TrajectoryRunInput extends AiActivityRunInput {
  planId?: string | null;
}

export class ActivityRunMapper {
  /**
   * Validated factory props for one run, or `null` when the input cannot be a
   * run record at all (bad key, unknown kind/status, no start time). Every
   * string column is reduced to an identifier and every number to a finite
   * non-negative integer; anything else becomes `null`.
   */
  static toCreateProps(input: TrajectoryRunInput): CreateAiActivityRunProps | null {
    const activityKind = asEnum(AiActivityKind, input.activityKind);
    const status = asEnum(AiActivityRunStatus, input.status);
    const startedAt = asDate(input.startedAt);
    if (!isRunKey(input.runKey) || !asIdentifier(input.tenantId) || !activityKind || !status || !startedAt) return null;

    const planId = asIdentifier(input.planId);
    return {
      tenantId: input.tenantId,
      runKey: input.runKey,
      consultationId: asIdentifier(input.consultationId),
      encounterSeq: asCount(input.encounterSeq),
      activityKind,
      status,
      workflowSlug: asIdentifier(input.workflowSlug),
      workflowVersion: asCount(input.workflowVersion),
      workflowRunId: asIdentifier(input.workflowRunId),
      nodeId: asIdentifier(input.nodeId),
      agentId: asIdentifier(input.agentId),
      agentSlug: asIdentifier(input.agentSlug),
      agentVersion: asCount(input.agentVersion),
      promptTemplateId: asIdentifier(input.promptTemplateId),
      promptVersion: asCount(input.promptVersion),
      model: asIdentifier(input.model),
      provider: asIdentifier(input.provider),
      deployment: asEnum(AiDeploymentKind, input.deployment),
      startedAt,
      endedAt: asDate(input.endedAt),
      durationMs: asCount(input.durationMs),
      tokensIn: asCount(input.tokensIn),
      tokensOut: asCount(input.tokensOut),
      contextUsed: asCount(input.contextUsed),
      contextWindow: asCount(input.contextWindow),
      outputCap: asCount(input.outputCap),
      stopReason: asIdentifier(input.stopReason),
      budgetStrategy: asIdentifier(input.budgetStrategy),
      callIndex: asCount(input.callIndex),
      callCount: asCount(input.callCount),
      costMicros: asMicros(input.costMicros),
      costBasis: asEnum(AiCostBasis, input.costBasis),
      usageRequestId: asIdentifier(input.usageRequestId),
      errorCode: asIdentifier(input.errorCode),
      contextItemId: asIdentifier(input.contextItemId),
      outputVersionNumber: asCount(input.outputVersionNumber),
      ...(planId ? { metaData: { planId } } : {}),
    } as CreateAiActivityRunProps;
  }

  /**
   * One finished LLM_CALL / NODE trajectory step → its run record, or `null`
   * when the step is not an AI activity (other step types, an unfinished step,
   * or a step whose stats declare no known `activity_kind`).
   *
   * `usage` is the ledger batch the same step produced, when it produced one:
   * deployment, cost basis and the ledger idempotency key are copied from it so
   * the run and its usage rows can never disagree.
   */
  static fromTrajectoryStep(
    step: AgentTrajectoryStepEntity,
    attribution: { nodeId?: string | null },
    usage: UsageEventBatchInput | null,
  ): TrajectoryRunInput | null {
    if (!RUN_STEP_TYPES.has(step.stepType)) return null;
    const status = STEP_STATUS_TO_RUN[step.status];
    if (!status) return null;
    const stats = step.stats && typeof step.stats === 'object' && !Array.isArray(step.stats) ? (step.stats as Record<string, unknown>) : {};
    const activityKind = asEnum(AiActivityKind, stats.activity_kind);
    if (!activityKind) return null;

    const tokensIn = asCount(pick(stats, 'prompt_tokens', 'promptTokens'));
    const tokensOut = asCount(pick(stats, 'predicted_tokens', 'predictedTokens', 'completion_tokens', 'completionTokens'));
    const common = usage?.common;

    return {
      tenantId: step.tenantId,
      runKey: `${TRAJECTORY_RUN_PRODUCER}:${step.sessionId}:${step.runId ?? ''}:${step.seq}`,
      consultationId: step.consultationId ?? null,
      encounterSeq: asCount(stats.encounter_seq),
      activityKind,
      status,
      workflowSlug: asIdentifier(stats.workflow_slug),
      workflowVersion: asCount(stats.workflow_version),
      // A WorkflowInterpreter step carries the TEMPORAL run id; the harness
      // stamps the HOPE workflow run it belongs to, which is what a run links to.
      workflowRunId: asIdentifier(stats.workflow_run_id) ?? (step.runId ? step.runId : null),
      nodeId: asIdentifier(attribution.nodeId),
      agentId: asIdentifier(stats.agent_id),
      agentSlug: asIdentifier(stats.agent_slug),
      agentVersion: asCount(stats.agent_version),
      promptTemplateId: asIdentifier(stats.prompt_template_id),
      promptVersion: asCount(stats.prompt_version),
      model: asIdentifier(common?.model ?? stats.model),
      provider: asIdentifier(common?.provider ?? stats.provider),
      deployment: common?.deployment ?? null,
      startedAt: step.startedAt,
      endedAt: step.endedAt ?? null,
      durationMs: asCount(step.durationMs) ?? durationBetween(step.startedAt, step.endedAt),
      tokensIn,
      tokensOut,
      // The context the call occupied: its prompt plus what it generated.
      contextUsed: tokensIn === null ? null : tokensIn + (tokensOut ?? 0),
      contextWindow: asCount(stats.context_window),
      outputCap: asCount(stats.max_tokens),
      stopReason: asIdentifier(pick(stats, 'stop_reason', 'stopReason')),
      budgetStrategy: asIdentifier(pick(stats, 'budget_strategy', 'budget_mode')),
      callIndex: asCount(stats.call_index),
      callCount: asCount(stats.call_count),
      costBasis: common?.costBasis ?? null,
      usageRequestId: common?.idempotencyKey ?? null,
      errorCode: asIdentifier(step.errorCode),
      contextItemId: asIdentifier(stats.context_item_id),
      outputVersionNumber: asCount(stats.output_version),
      planId: asIdentifier(stats.plan_id),
    };
  }

  static toProducer(entity: AiActivityRunEntity): ActivityRunProducer {
    return {
      activityRunId: entity.id,
      activityKind: entity.activityKind,
      encounterSeq: entity.encounterSeq ?? null,
      workflowSlug: entity.workflowSlug ?? null,
      workflowVersion: entity.workflowVersion ?? null,
      workflowRunId: entity.workflowRunId ?? null,
      nodeId: entity.nodeId ?? null,
      agentSlug: entity.agentSlug ?? null,
      agentVersion: entity.agentVersion ?? null,
      modelName: entity.model ?? null,
      provider: entity.provider ?? null,
      deployment: entity.deployment ?? null,
      promptTemplateId: entity.promptTemplateId ?? null,
      promptVersion: entity.promptVersion ?? null,
      startedAt: entity.startedAt,
      endedAt: entity.endedAt ?? null,
      contextUsed: entity.contextUsed ?? null,
      contextWindow: entity.contextWindow ?? null,
      outputCap: entity.outputCap ?? null,
      stopReason: entity.stopReason ?? null,
      tokensIn: entity.tokensIn ?? null,
      tokensOut: entity.tokensOut ?? null,
      costMicros: entity.costMicros ?? null,
      costBasis: entity.costBasis ?? null,
      durationMs: entity.durationMs ?? null,
    };
  }

  /** The console's run summary (`@arcaai/types` `RunSummary`). */
  static toRunSummary(entity: AiActivityRunEntity): RunSummary {
    return {
      runId: entity.workflowRunId || entity.id,
      workflowSlug: entity.workflowSlug ?? '',
      workflowVersion: entity.workflowVersion ?? '',
      agentSlug: entity.agentSlug ?? '',
      agentVersion: entity.agentVersion ?? '',
      model: entity.model ?? '',
      provider: entity.provider ?? '',
      durationMs: entity.durationMs ?? 0,
      tokensIn: entity.tokensIn ?? 0,
      tokensOut: entity.tokensOut ?? 0,
      contextUsed: entity.contextUsed ?? 0,
      contextWindow: entity.contextWindow ?? 0,
      // Micros of one call never approach 2^53, so the wire number is exact.
      costMicros: entity.costMicros === null || entity.costMicros === undefined ? null : Number(entity.costMicros),
      costBasis: entity.costBasis ?? null,
      stopReason: entity.stopReason ?? null,
      startedAt: entity.startedAt.toISOString(),
    };
  }

  /** The console's run-table row (`@arcaai/types` `ActivityRunRecord`). */
  static toActivityRunRecord(entity: AiActivityRunEntity): ActivityRunRecord {
    return {
      ...ActivityRunMapper.toRunSummary(entity),
      id: entity.id,
      nodeId: entity.nodeId ?? '',
      activityKind: entity.activityKind,
      outputCap: entity.outputCap ?? null,
      deployment: entity.deployment ?? null,
      endedAt: (entity.endedAt ?? entity.startedAt).toISOString(),
      versionNumber: entity.outputVersionNumber ?? 0,
    };
  }
}

function durationBetween(startedAt: Date, endedAt?: Date | null): number | null {
  if (!endedAt) return null;
  const ms = endedAt.getTime() - startedAt.getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}
