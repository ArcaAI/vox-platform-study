/**
 * The governed note's run records (a `core.agent` finalizer inside a
 * WorkflowInterpreter run).
 *
 * The interpreter's trajectory session is `workflow-interpreter-<runId>` and
 * its steps carry the TEMPORAL run id, which is not the HOPE workflow run the
 * console links to. The harness stamps the HOPE run id as
 * `stats.workflow_run_id`; the record must name THAT run while the runKey keeps
 * the step's own `(sessionId, runId, seq)` so a re-delivered batch still
 * converges on one row.
 */

import { describe, expect, it } from 'vitest';
import { AgentSessionKind, AgentStepStatus, AgentStepType, AgentTrajectoryStepFactory, AiActivityKind } from '@arcaai/domains';

import { ActivityRunMapper } from '../activity-run.mapper';

const TENANT = 'tenant-1';
const CONSULTATION = '01a10d86-f20c-7981-9a2d-dac631adc7c1';
const HOPE_RUN = '01a10d86-f2ef-7d30-a177-6b7824aa4423';
const TEMPORAL_RUN = '01a10d86-f3df-7bc2-b230-9df7a8d48dd6';

const GOVERNED = {
  workflow_slug: 'arcaai-bren-consultation',
  workflow_version: 1,
  workflow_run_id: HOPE_RUN,
  agent_slug: 'casenote-finalization',
  agent_version: 1,
  plan_id: '01a10d88-3a12-7855-91fa-7f7ee0f09d22',
  encounter_seq: 1,
  context_window: 32768,
  budget_strategy: 'single_pass',
  call_count: 1,
};

function governedStep(seq: number, stepType: AgentStepType, stats: Record<string, unknown>) {
  return AgentTrajectoryStepFactory.CreateStep({
    tenantId: TENANT,
    consultationId: CONSULTATION,
    sessionKind: AgentSessionKind.HARNESS_DOC,
    sessionId: `workflow-interpreter-${HOPE_RUN}`,
    runId: TEMPORAL_RUN,
    seq,
    stepType,
    name: stepType === AgentStepType.NODE ? 'core.agent' : 'generate',
    status: AgentStepStatus.OK,
    startedAt: new Date('2026-10-05T19:26:34.000Z'),
    endedAt: new Date('2026-10-05T19:27:01.000Z'),
    durationMs: 27000,
    stats,
  });
}

describe('ActivityRunMapper.fromTrajectoryStep — governed note', () => {
  it('names the HOPE workflow run, not the Temporal run, and keeps the step-derived runKey', () => {
    const run = ActivityRunMapper.fromTrajectoryStep(
      governedStep(49, AgentStepType.LLM_CALL, {
        ...GOVERNED,
        activity_kind: 'NOTE_SECTION_GROUP',
        call_index: 1,
        max_tokens: 1792,
        provider: 'lm-studio',
        model: 'gemma-4-e2b-it-qat',
        prompt_tokens: 1912,
        predicted_tokens: 1421,
      }),
      { nodeId: 'n_finalize' },
      null,
    );

    expect(run).toMatchObject({
      runKey: `trajectory:workflow-interpreter-${HOPE_RUN}:${TEMPORAL_RUN}:49`,
      consultationId: CONSULTATION,
      activityKind: AiActivityKind.NOTE_SECTION_GROUP,
      workflowSlug: 'arcaai-bren-consultation',
      workflowVersion: 1,
      workflowRunId: HOPE_RUN,
      nodeId: 'n_finalize',
      agentSlug: 'casenote-finalization',
      agentVersion: 1,
      model: 'gemma-4-e2b-it-qat',
      tokensIn: 1912,
      tokensOut: 1421,
      contextUsed: 3333,
      contextWindow: 32768,
      outputCap: 1792,
      durationMs: 27000,
      callIndex: 1,
      callCount: 1,
    });
  });

  it('fills the note-level NOTE_GENERATE record with the served model and the summed tokens', () => {
    const run = ActivityRunMapper.fromTrajectoryStep(
      governedStep(48, AgentStepType.NODE, {
        ...GOVERNED,
        activity_kind: 'NOTE_GENERATE',
        provider: 'lm-studio',
        model: 'gemma-4-e2b-it-qat',
        prompt_tokens: 1912,
        predicted_tokens: 1421,
        context_item_id: '01a10d88-a676-7388-9c14-32f878239675',
        output_version: 1,
      }),
      { nodeId: 'n_finalize' },
      null,
    );

    expect(run).toMatchObject({
      consultationId: CONSULTATION,
      activityKind: AiActivityKind.NOTE_GENERATE,
      workflowSlug: 'arcaai-bren-consultation',
      workflowVersion: 1,
      workflowRunId: HOPE_RUN,
      model: 'gemma-4-e2b-it-qat',
      provider: 'lm-studio',
      tokensIn: 1912,
      tokensOut: 1421,
      contextWindow: 32768,
      contextItemId: '01a10d88-a676-7388-9c14-32f878239675',
      outputVersionNumber: 1,
    });
  });

  it('still falls back to the step run id when no workflow run id is stamped (harness-doc)', () => {
    const run = ActivityRunMapper.fromTrajectoryStep(
      governedStep(3, AgentStepType.NODE, { activity_kind: 'NOTE_GENERATE', call_count: 1 }),
      {},
      null,
    );
    expect(run?.workflowRunId).toBe(TEMPORAL_RUN);
  });

  it('drops a stamped workflow run id that is not an identifier', () => {
    const run = ActivityRunMapper.fromTrajectoryStep(
      governedStep(3, AgentStepType.NODE, { activity_kind: 'NOTE_GENERATE', workflow_run_id: 'not an id' }),
      {},
      null,
    );
    expect(run?.workflowRunId).toBe(TEMPORAL_RUN);
  });
});
