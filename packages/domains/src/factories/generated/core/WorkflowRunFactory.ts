/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { WorkflowRunEntity, IWorkflowRunEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateWorkflowRunProps extends BaseEntityFactoryCreateProps {
  tenantId: IWorkflowRunEntity['tenantId'];
  workflowVersionId: string;
  workflowSlug: string;
  workflowVersionNumber: number;
  definitionName: string;
  sessionId: IWorkflowRunEntity['sessionId'];
  runId?: IWorkflowRunEntity['runId'];
  trigger: IWorkflowRunEntity['trigger'];
  status?: IWorkflowRunEntity['status'];
  isSandbox?: IWorkflowRunEntity['isSandbox'];
  startedAt: IWorkflowRunEntity['startedAt'];
  endedAt?: IWorkflowRunEntity['endedAt'];
  durationMs?: IWorkflowRunEntity['durationMs'];
  nodeCount?: IWorkflowRunEntity['nodeCount'];
  failedNodeCount?: IWorkflowRunEntity['failedNodeCount'];
  degradedNodeCount?: IWorkflowRunEntity['degradedNodeCount'];
  firstErrorCode?: IWorkflowRunEntity['firstErrorCode'];
  resultRef?: IWorkflowRunEntity['resultRef'];
  metaData?: IWorkflowRunEntity['metaData'];
  Tenant?: IWorkflowRunEntity['Tenant'];

  createdAt?: IWorkflowRunEntity['createdAt'];
  createdBy?: IWorkflowRunEntity['createdBy'];
}

/**
 * TASK-1038 OD-26 — the props of an AGENT run row (`POST /agents/:slug/runs`). There is no
 * workflow identity to pass and no session key to choose: the row is anchored under
 * `agent-run-<runId>` (`AGENT_RUN_SESSION_PREFIX`), a key no workflow lookup ever asks for.
 */
export interface CreateAgentRunProps extends BaseEntityFactoryCreateProps {
  tenantId: IWorkflowRunEntity['tenantId'];
  runId: string;
  agentSlug: string;
  agentVersionId: string;
  agentVersionNumber: number;
  startedAt: IWorkflowRunEntity['startedAt'];
  metaData?: IWorkflowRunEntity['metaData'];
  createdAt?: IWorkflowRunEntity['createdAt'];
  createdBy?: IWorkflowRunEntity['createdBy'];
}

/** The `trigger` every agent run row carries (the column is a code-owned vocabulary string). */
export const AGENT_RUN_TRIGGER = 'agent run';
/** The session-key prefix of an AGENT run row — see `agentRunSessionId`. */
export const AGENT_RUN_SESSION_PREFIX = 'agent-run-';
/** The session key an AGENT run row is anchored under (`(tenantId, sessionId, runId)` is unique). */
export function agentRunSessionId(runId: string): string {
  return `${AGENT_RUN_SESSION_PREFIX}${runId}`;
}

export class WorkflowRunFactory {
  /**
   * Build one run row. `id` is a time-sortable UUIDv7 and `_version`/timestamps
   * follow the house convention; `status` defaults to RUNNING (a run row is
   * created via `recordRunStarted`, before its outcome is known). Ops-telemetry:
   * no sys-event is published on create (see WorkflowRunEntity header).
   */
  static CreateRun(props: CreateWorkflowRunProps): WorkflowRunEntity {
    const id = generateId();
    const now = props.createdAt || new Date();

    return new WorkflowRunEntity({
      id,

      createdAt: now,
      updatedAt: now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,

      tenantId: props.tenantId,
      kind: Enums.WorkflowRunKind.WORKFLOW,
      workflowVersionId: props.workflowVersionId,
      workflowSlug: props.workflowSlug,
      workflowVersionNumber: props.workflowVersionNumber,
      definitionName: props.definitionName,
      sessionId: props.sessionId,
      runId: props.runId ?? '',
      trigger: props.trigger,
      status: props.status ?? Enums.WorkflowRunStatus.RUNNING,
      isSandbox: props.isSandbox ?? false,
      startedAt: props.startedAt,
      endedAt: props.endedAt ?? null,
      durationMs: props.durationMs ?? null,
      nodeCount: props.nodeCount ?? null,
      failedNodeCount: props.failedNodeCount ?? 0,
      degradedNodeCount: props.degradedNodeCount ?? 0,
      firstErrorCode: props.firstErrorCode ?? null,
      // (M-2). Always null at CreateRun time — a run has delivered nothing
      // when it starts; `recordRunFinished` is what writes it.
      resultRef: props.resultRef ?? null,
      // TASK-950 — non-PHI bookkeeping the caller wants stored on the row's `_metadata`
      // (today: `{ actingUserId }` from `WorkflowRunService.recordRunStarted`).
      //
      // Deliberately NOT `?? null`, unlike every sibling above. `_metadata` has to keep three
      // distinguishable states — OMITTED ("this caller had nothing to record"), `{}` ("measured,
      // found nothing"), and a populated bag — and defaulting to `null` collapses the first into
      // a stored fact that was never asserted. `BaseDataModel` coerces `undefined` to `null` at
      // the mapper boundary anyway, so the INSERT is unchanged; what survives here is the
      // absence, which `workflow-run.acting-user.task950.test.ts` pins on `toObject()`.
      metaData: props.metaData,
      Tenant: props.Tenant ?? null,
    });
  }

  /**
   * TASK-1038 OD-26 — one AGENT run row: RUNNING, one step, no workflow identity. Its result is
   * written at the terminal transition as `resultRef = { kind: 'inline', value }`, so the A2
   * retention purge (`workflowRuns.resultRetentionDays`) expires it exactly like a workflow's.
   */
  static CreateAgentRun(props: CreateAgentRunProps): WorkflowRunEntity {
    const id = generateId();
    const now = props.createdAt || new Date();

    return new WorkflowRunEntity({
      id,

      createdAt: now,
      updatedAt: now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,

      tenantId: props.tenantId,
      kind: Enums.WorkflowRunKind.AGENT,
      workflowVersionId: null,
      workflowSlug: null,
      workflowVersionNumber: null,
      definitionName: null,
      agentSlug: props.agentSlug,
      agentVersionId: props.agentVersionId,
      agentVersionNumber: props.agentVersionNumber,
      sessionId: agentRunSessionId(props.runId),
      runId: props.runId,
      trigger: AGENT_RUN_TRIGGER,
      status: Enums.WorkflowRunStatus.RUNNING,
      isSandbox: false,
      startedAt: props.startedAt,
      endedAt: null,
      durationMs: null,
      nodeCount: 1,
      failedNodeCount: 0,
      degradedNodeCount: 0,
      firstErrorCode: null,
      resultRef: null,
      // Verbatim, never `?? null` — the same three-way absence `CreateRun` preserves.
      metaData: props.metaData,
      Tenant: null,
    });
  }
}
