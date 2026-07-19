import { AgentTrajectoryStepEntity, JsonValue } from '@arcaai/domains';
import { AgentTrajectoryStepResponse } from './dto';

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/**
 * TASK-510 Phase 2B — entity → response projection. `payloadRef` is
 * intentionally omitted (claim-check / encrypted pointer, `@Secret` on the
 * entity), so it never leaves the service.
 */
export class AgentTrajectoryDtoMapper {
  static toStepResponse(e: AgentTrajectoryStepEntity): AgentTrajectoryStepResponse {
    return {
      id: e.id,
      tenantId: e.tenantId,
      consultationId: e.consultationId ?? null,
      sessionKind: String(e.sessionKind),
      sessionId: e.sessionId,
      runId: e.runId ?? '',
      seq: e.seq,
      stepType: String(e.stepType),
      name: e.name,
      status: String(e.status),
      startedAt: toIso(e.startedAt),
      endedAt: e.endedAt ? toIso(e.endedAt) : null,
      durationMs: e.durationMs ?? null,
      stats: (e.stats ?? null) as JsonValue | null,
      errorCode: e.errorCode ?? null,
      correlationId: e.correlationId ?? null,
      createdAt: toIso(e.createdAt),
    };
  }
}
