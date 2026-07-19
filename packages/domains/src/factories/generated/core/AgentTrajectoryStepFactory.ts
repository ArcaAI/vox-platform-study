/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { AgentTrajectoryStepEntity, IAgentTrajectoryStepEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateAgentTrajectoryStepProps extends BaseEntityFactoryCreateProps {
  tenantId: IAgentTrajectoryStepEntity['tenantId'];
  consultationId?: IAgentTrajectoryStepEntity['consultationId'];
  sessionKind: IAgentTrajectoryStepEntity['sessionKind'];
  sessionId: IAgentTrajectoryStepEntity['sessionId'];
  runId?: IAgentTrajectoryStepEntity['runId'];
  seq: IAgentTrajectoryStepEntity['seq'];
  stepType: IAgentTrajectoryStepEntity['stepType'];
  name: IAgentTrajectoryStepEntity['name'];
  status: IAgentTrajectoryStepEntity['status'];
  startedAt: IAgentTrajectoryStepEntity['startedAt'];
  endedAt?: IAgentTrajectoryStepEntity['endedAt'];
  durationMs?: IAgentTrajectoryStepEntity['durationMs'];
  stats?: IAgentTrajectoryStepEntity['stats'];
  payloadRef?: IAgentTrajectoryStepEntity['payloadRef'];
  errorCode?: IAgentTrajectoryStepEntity['errorCode'];
  correlationId?: IAgentTrajectoryStepEntity['correlationId'];
  Tenant?: IAgentTrajectoryStepEntity['Tenant'];

  createdAt?: IAgentTrajectoryStepEntity['createdAt'];
  createdBy?: IAgentTrajectoryStepEntity['createdBy'];
}

export class AgentTrajectoryStepFactory {
  /**
   * Build one ordered trajectory step. `id` is a time-sortable UUIDv7 and
   * `_version`/timestamps follow the house convention; the emitter assigns
   * `seq` (per-session monotonic). Ops-telemetry: no sys-event is published on
   * create (see AgentTrajectoryStepEntity header).
   */
  static CreateStep(props: CreateAgentTrajectoryStepProps): AgentTrajectoryStepEntity {
    const id = generateId();
    const now = props.createdAt || new Date();

    return new AgentTrajectoryStepEntity({
      id,

      createdAt: now,
      updatedAt: now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,

      tenantId: props.tenantId,
      consultationId: props.consultationId ?? null,
      sessionKind: props.sessionKind,
      sessionId: props.sessionId,
      runId: props.runId ?? '',
      seq: props.seq,
      stepType: props.stepType,
      name: props.name,
      status: props.status,
      startedAt: props.startedAt,
      endedAt: props.endedAt ?? null,
      durationMs: props.durationMs ?? null,
      stats: props.stats ?? null,
      payloadRef: props.payloadRef ?? null,
      errorCode: props.errorCode ?? null,
      correlationId: props.correlationId ?? null,
      Tenant: props.Tenant ?? null,
    });
  }
}
