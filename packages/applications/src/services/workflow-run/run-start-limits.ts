import type { TenantSettingsService } from '../settings-registry/tenant-settings.service';
import {
  WORKFLOW_RUNS_ACTIVITY_INPUT_MAX_BYTES_KEY,
  WORKFLOW_RUNS_DEFAULTS,
  WORKFLOW_RUNS_EVENT_RETENTION_HOURS_KEY,
  WORKFLOW_RUNS_NODE_OUTPUT_CLAIM_CHECK_MIN_BYTES_KEY,
  WORKFLOW_RUNS_RESULT_INLINE_MAX_BYTES_KEY,
} from '../settings-registry/descriptors/workflow-runs.descriptors';
import { GUARDRAIL_HOLD_TIMEOUT_SECONDS_KEY, GUARDRAIL_JUDGE_DEFAULTS } from '../settings-registry/descriptors/guardrail-judge.descriptors';

/** The payload-size limits a run start carries (lane B1 reads exactly these names). */
export interface RunStartPayloadLimits {
  nodeOutputClaimCheckMinBytes: number;
  resultInlineMaxBytes: number;
  activityInputMaxBytes: number;
}

/** What `POST /workflow-runs:start` carries beside the run identity (TASK-1038 B3a). */
export interface RunStartLimits {
  /** `workflowRuns.eventRetentionHours × 3600` — the TTL the harness puts on a terminal append (OD-25). */
  retentionSeconds: number;
  limits: RunStartPayloadLimits;
  /**
   * TASK-1050 (README §9.8.1) — `guardrail.hold.timeoutSeconds`: how long a node held on a guardrail block waits
   * for a resolution before the run ends `GUARDRAIL_BLOCKED` (lane W2f reads exactly this name).
   */
  guardrailHoldTimeoutSeconds: number;
}

/**
 * Resolve the retention and payload limits for one run start (gateway-resolved injection, rule
 * 06). Platform-tier knobs, each failing OPEN to its descriptor default: an absent resolver, an
 * unset or invalid value, or a resolver error never blocks a run start.
 */
export function resolveRunStartLimits(settings: Pick<TenantSettingsService, 'resolvePlatform'> | undefined): RunStartLimits {
  const read = (key: string, fallback: number): number => {
    try {
      const value = settings?.resolvePlatform<number>(key).value;
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    retentionSeconds: read(WORKFLOW_RUNS_EVENT_RETENTION_HOURS_KEY, WORKFLOW_RUNS_DEFAULTS.eventRetentionHours) * 3600,
    limits: {
      nodeOutputClaimCheckMinBytes: read(WORKFLOW_RUNS_NODE_OUTPUT_CLAIM_CHECK_MIN_BYTES_KEY, WORKFLOW_RUNS_DEFAULTS.nodeOutputClaimCheckMinBytes),
      resultInlineMaxBytes: read(WORKFLOW_RUNS_RESULT_INLINE_MAX_BYTES_KEY, WORKFLOW_RUNS_DEFAULTS.resultInlineMaxBytes),
      activityInputMaxBytes: read(WORKFLOW_RUNS_ACTIVITY_INPUT_MAX_BYTES_KEY, WORKFLOW_RUNS_DEFAULTS.activityInputMaxBytes),
    },
    guardrailHoldTimeoutSeconds: read(GUARDRAIL_HOLD_TIMEOUT_SECONDS_KEY, GUARDRAIL_JUDGE_DEFAULTS[GUARDRAIL_HOLD_TIMEOUT_SECONDS_KEY]),
  };
}
