// TASK-1038 — run integrity and the delivery plane (OD-25): how long a run's event stream and its
// delivered result survive, and the gateway's delivery-plane tuning (terminal fallback cadence,
// WebSocket backpressure, signed-URL lifetime). Tuning knobs only: every key fails open to its
// default and none gates a privilege check. Read by the gateway itself (no `consumedBy`).

import { SettingDescriptor } from '../registry.types';

export const WORKFLOW_RUNS_EVENT_RETENTION_HOURS_KEY = 'workflowRuns.eventRetentionHours';
export const WORKFLOW_RUNS_RESULT_RETENTION_DAYS_KEY = 'workflowRuns.resultRetentionDays';
export const WORKFLOW_RUNS_TERMINAL_CHECK_SECONDS_KEY = 'workflowRuns.streamTerminalCheckSeconds';
export const WORKFLOW_RUNS_WS_MAX_BUFFERED_BYTES_KEY = 'workflowRuns.wsMaxBufferedBytes';
export const WORKFLOW_RUNS_RESULT_URL_TTL_SECONDS_KEY = 'workflowRuns.resultUrlTtlSeconds';
// TASK-1038 B3a — the payload-size limits the gateway resolves and hands the harness with every
// run start (`limits` on `POST /workflow-runs:start`; lane B1 reads exactly these names). They
// replace the A1-era `HARNESS_CLAIM_CHECK_*` env knobs under the owner's config rule.
export const WORKFLOW_RUNS_NODE_OUTPUT_CLAIM_CHECK_MIN_BYTES_KEY = 'workflowRuns.nodeOutputClaimCheckMinBytes';
export const WORKFLOW_RUNS_RESULT_INLINE_MAX_BYTES_KEY = 'workflowRuns.resultInlineMaxBytes';
export const WORKFLOW_RUNS_ACTIVITY_INPUT_MAX_BYTES_KEY = 'workflowRuns.activityInputMaxBytes';
// TASK-1038 E2 (fix 4, R2) — the ceiling on one agent run (`POST /agents/:slug/runs`).
export const WORKFLOW_RUNS_AGENT_RUN_MAX_SECONDS_KEY = 'workflowRuns.agentRunMaxSeconds';

export const WORKFLOW_RUNS_DEFAULTS = {
  /** OD-25: run events expire 24 h after the run is terminal. */
  eventRetentionHours: 24,
  /** OD-25: results are kept 30 days. */
  resultRetentionDays: 30,
  /** How long an idle stream waits before re-checking whether the run already ended. */
  streamTerminalCheckSeconds: 30,
  /** A WebSocket client with more than this many bytes unsent is paused until it drains. */
  wsMaxBufferedBytes: 1024 * 1024,
  /** Lifetime of the signed URL `GET …/runs/:runId/result` hands out for a claim-checked result. */
  resultUrlTtlSeconds: 300,
  /** A node output larger than this (serialized) is claim-checked instead of travelling inline (R-3). */
  nodeOutputClaimCheckMinBytes: 20 * 1024,
  /** A delivered result at most this large rides inline on `run.completed`; larger is a `ref` (D-I). */
  resultInlineMaxBytes: 64 * 1024,
  /** An activity input over this many bytes fails the run with `PAYLOAD_TOO_LARGE` (below Temporal's 2 MB blob limit). */
  activityInputMaxBytes: 1536 * 1024,
  /** R2: an agent run still executing after this many seconds is aborted and ends TIMED_OUT. */
  agentRunMaxSeconds: 900,
} as const;

function wholeNumberBetween(min: number, max: number): (value: unknown) => string | undefined {
  return (value: unknown): string | undefined => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min) return `Must be a whole number of at least ${min}.`;
    if (value > max) return `Must not exceed ${max}.`;
    return undefined;
  };
}

const COMMON = {
  tier: 'global-kv',
  dataType: 'number',
  sensitivity: 'internal',
  editableBy: 'GlobalSetting',
  failMode: 'open-to-default',
  category: 'Workflow Runs',
} as const;

export const WORKFLOW_RUNS_SETTINGS: SettingDescriptor[] = [
  {
    ...COMMON,
    key: WORKFLOW_RUNS_EVENT_RETENTION_HOURS_KEY,
    maxScope: 'system',
    globalOnly: true,
    label: 'Run event retention (hours)',
    description:
      "How many hours a workflow run's event stream (the frames SSE and WebSocket clients replay on reconnect) is kept in Redis after the run reaches a terminal state.",
    default: WORKFLOW_RUNS_DEFAULTS.eventRetentionHours,
    validate: wholeNumberBetween(1, 24 * 30),
  },
  {
    ...COMMON,
    key: WORKFLOW_RUNS_RESULT_RETENTION_DAYS_KEY,
    maxScope: 'tenant',
    globalOnly: false,
    category: 'Data retention',
    label: 'Workflow result retention (days)',
    description:
      "How many days a finished workflow run's delivered result stays readable through GET /workflows/:slug/runs/:runId/result before the daily purge expires it. The run's status and counts are kept.",
    default: WORKFLOW_RUNS_DEFAULTS.resultRetentionDays,
    validate: wholeNumberBetween(1, 365),
  },
  {
    ...COMMON,
    key: WORKFLOW_RUNS_TERMINAL_CHECK_SECONDS_KEY,
    maxScope: 'system',
    globalOnly: true,
    label: 'Run stream terminal re-check (seconds)',
    description:
      'How long an idle run stream (SSE, WebSocket, blocking mode, background completion watcher) waits before re-reading the run status, so a stream whose completion event was lost still ends.',
    default: WORKFLOW_RUNS_DEFAULTS.streamTerminalCheckSeconds,
    validate: wholeNumberBetween(5, 600),
  },
  {
    ...COMMON,
    key: WORKFLOW_RUNS_WS_MAX_BUFFERED_BYTES_KEY,
    maxScope: 'system',
    globalOnly: true,
    label: 'Run WebSocket backpressure threshold (bytes)',
    description:
      'A workflow-run WebSocket whose unsent buffer exceeds this many bytes stops reading new run events until the client catches up. The events stay in the run stream; nothing is dropped.',
    default: WORKFLOW_RUNS_DEFAULTS.wsMaxBufferedBytes,
    validate: wholeNumberBetween(16 * 1024, 64 * 1024 * 1024),
  },
  {
    ...COMMON,
    key: WORKFLOW_RUNS_RESULT_URL_TTL_SECONDS_KEY,
    maxScope: 'system',
    globalOnly: true,
    label: 'Workflow result signed-URL lifetime (seconds)',
    description: 'Lifetime of the short-lived signed URL returned for a claim-checked (large) workflow result.',
    default: WORKFLOW_RUNS_DEFAULTS.resultUrlTtlSeconds,
    validate: wholeNumberBetween(30, 3600),
  },
  {
    ...COMMON,
    key: WORKFLOW_RUNS_NODE_OUTPUT_CLAIM_CHECK_MIN_BYTES_KEY,
    maxScope: 'system',
    globalOnly: true,
    label: 'Node output claim-check threshold (bytes)',
    description:
      'A workflow node output larger than this many bytes (serialized) is stored in the claim-check bucket and passed by reference, keeping Temporal history small. Sent to the harness with every run start.',
    default: WORKFLOW_RUNS_DEFAULTS.nodeOutputClaimCheckMinBytes,
    validate: wholeNumberBetween(1024, 1024 * 1024),
  },
  {
    ...COMMON,
    key: WORKFLOW_RUNS_RESULT_INLINE_MAX_BYTES_KEY,
    maxScope: 'system',
    globalOnly: true,
    label: 'Inline run result ceiling (bytes)',
    description:
      'A delivered workflow result at most this many bytes rides inline on the run-completed event; a larger one is claim-checked and read through a signed URL. Never above the run protocol`s 64 KiB inline rule.',
    default: WORKFLOW_RUNS_DEFAULTS.resultInlineMaxBytes,
    validate: wholeNumberBetween(1024, 64 * 1024),
  },
  {
    ...COMMON,
    key: WORKFLOW_RUNS_ACTIVITY_INPUT_MAX_BYTES_KEY,
    maxScope: 'system',
    globalOnly: true,
    label: 'Activity input ceiling (bytes)',
    description:
      'The largest input (serialized) a workflow step may hand a Temporal activity; a larger one fails the run by name (PAYLOAD_TOO_LARGE) instead of stalling it. Kept below Temporal`s 2 MB payload limit.',
    default: WORKFLOW_RUNS_DEFAULTS.activityInputMaxBytes,
    validate: wholeNumberBetween(64 * 1024, 2 * 1000 * 1000),
  },
  {
    ...COMMON,
    key: WORKFLOW_RUNS_AGENT_RUN_MAX_SECONDS_KEY,
    maxScope: 'system',
    globalOnly: true,
    label: 'Agent run ceiling (seconds)',
    description:
      'An agent run (POST /agents/:slug/runs) still executing after this many seconds is aborted and ends TIMED_OUT (RUN_TIMED_OUT). A run left RUNNING past it by a lost process is swept to TIMED_OUT by the gateway.',
    default: WORKFLOW_RUNS_DEFAULTS.agentRunMaxSeconds,
    validate: wholeNumberBetween(30, 6 * 3600),
  },
];
