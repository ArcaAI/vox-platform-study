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
  workflowVersionId: IWorkflowRunEntity['workflowVersionId'];
  workflowSlug: IWorkflowRunEntity['workflowSlug'];
  workflowVersionNumber: IWorkflowRunEntity['workflowVersionNumber'];
  definitionName: IWorkflowRunEntity['definitionName'];
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
  Tenant?: IWorkflowRunEntity['Tenant'];

  createdAt?: IWorkflowRunEntity['createdAt'];
  createdBy?: IWorkflowRunEntity['createdBy'];
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
      Tenant: props.Tenant ?? null,
    });
  }
}
