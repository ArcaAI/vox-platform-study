import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { WorkflowRun, WorkflowRunEntity, WorkflowRunEntityMapper, WorkflowRunKind, agentRunSessionId } from '@arcaai/domains';

/** The mapper hands Prisma ISO strings for timestamps; Postgres hands back `Date`s. */
const DATE_COLUMNS = ['startedAt', 'endedAt', 'createdAt', 'updatedAt'];

function revive(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data };
  for (const column of DATE_COLUMNS) if (typeof out[column] === 'string') out[column] = new Date(out[column] as string);
  return out;
}

/**
 * An in-memory stand-in for `WorkflowRunRepository` — the Postgres run read model agent runs now
 * live in (TASK-1038 OD-26, lane B6a). Rows go through the REAL mapper in both directions, and the
 * two database guarantees the agent run service leans on are reproduced:
 *   - the unique key `(tenantId, sessionId, runId)` — a second create is a Prisma `P2002`;
 *   - `updateWithVersion` is a compare-and-set on `_version` — drift throws
 *     `OptimisticConcurrencyException`, a win bumps the version.
 * `rows` survives a "restart" (a new service instance) the way a Postgres row does.
 */
export class FakeWorkflowRunRepository {
  readonly rows = new Map<string, Record<string, unknown>>();
  private readonly mapper = WorkflowRunEntityMapper.getInstance();

  async create(entity: WorkflowRunEntity): Promise<WorkflowRunEntity> {
    const data = revive(this.mapper.toPersistence(entity) as unknown as Record<string, unknown>);
    for (const row of this.rows.values()) {
      if (row.tenantId === data.tenantId && row.sessionId === data.sessionId && row.runId === data.runId) {
        throw Object.assign(new Error('Unique constraint failed on WorkflowRun_session_run_key'), { code: 'P2002' });
      }
    }
    const stored = { ...data, version: 1 };
    this.rows.set(String(stored.id), stored);
    return this.toEntity(stored);
  }

  async findAgentRun(tenantId: string, runId: string): Promise<WorkflowRunEntity | null> {
    for (const row of this.rows.values()) {
      if (row.tenantId === tenantId && row.kind === WorkflowRunKind.AGENT && row.sessionId === agentRunSessionId(runId) && row.runId === runId) {
        return this.toEntity(row);
      }
    }
    return null;
  }

  async updateWithVersion(id: string, entity: WorkflowRunEntity, expectedVersion: number): Promise<WorkflowRunEntity> {
    const row = this.rows.get(id);
    if (!row) throw new Error(`no row ${id}`);
    if (row.version !== expectedVersion) {
      throw new OptimisticConcurrencyException('workflowRun', id, { expectedVersion, currentVersion: row.version as number });
    }
    const changes = revive(this.mapper.toPersistenceChanges(entity) as unknown as Record<string, unknown>);
    const next = { ...row, ...changes, version: (row.version as number) + 1 };
    this.rows.set(id, next);
    return this.toEntity(next);
  }

  /** The one stored row of a run (tests read the raw columns). */
  rowOf(runId: string): Record<string, unknown> | undefined {
    return [...this.rows.values()].find((row) => row.runId === runId);
  }

  private toEntity(row: Record<string, unknown>): WorkflowRunEntity {
    return this.mapper.toDomainEntity(new WorkflowRun(structuredClone(row) as never));
  }
}
