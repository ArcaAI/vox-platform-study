/**
 * TASK-1038 OD-26 (lane B6a) — the run read model holds AGENT runs as well as WORKFLOW runs.
 *
 * `POST /agents/:slug/runs` used to keep its run in Redis (persistence disabled → lost on restart,
 * PHI resident for 30 days). It now writes a `WorkflowRun` row with `kind = AGENT`. What this file
 * locks in:
 *   1. every existing WORKFLOW write is unchanged — `CreateRun` defaults `kind` to WORKFLOW;
 *   2. `CreateAgentRun` names the agent identity, leaves the workflow identity NULL, and anchors
 *      the row under its own session key (`agent-run-<runId>`), so no workflow by-run-key lookup
 *      (`workflow-interpreter-…` / `wf-…`) can ever land on it;
 *   3. `validate()` holds "one identity, by kind" (the CHECK constraint's domain twin);
 *   4. the mapper round-trips the new columns and still never writes `_version`;
 *   5. the repository's WORKFLOW lookup filters `kind = WORKFLOW`, and the agent lookup
 *      `kind = AGENT` under the agent session key.
 */
import { describe, it, expect, vi } from 'vitest';
import { BusinessException } from '@arcaai/exceptions';

import { WorkflowRunFactory, agentRunSessionId } from '../../../../factories/generated/core/WorkflowRunFactory';
import { WorkflowRunEntityMapper } from '../../../../mappers/generated/core/WorkflowRunEntityMapper';
import { WorkflowRun } from '../../../../models/generated/core/WorkflowRunModel';
import { WorkflowRunStatus } from '../../../../enums/generated/WorkflowRunStatus';
import { WorkflowRunKind } from '../../../../enums/generated/WorkflowRunKind';
import { WorkflowRunRepository } from '../../../../repositories/generated/core/WorkflowRunRepository';

const TENANT = '50000000-0000-0000-0000-000000000000';
const STARTED_AT = new Date('2026-10-04T00:00:00.000Z');

const workflowRun = () =>
  WorkflowRunFactory.CreateRun({
    tenantId: TENANT,
    workflowVersionId: 'def-1',
    workflowSlug: 'triage_flow',
    workflowVersionNumber: 1,
    definitionName: 'Triage Flow',
    sessionId: 'workflow-interpreter-run-1',
    runId: 'run-1',
    trigger: 'api invoke',
    startedAt: STARTED_AT,
  });

const agentRun = () =>
  WorkflowRunFactory.CreateAgentRun({
    tenantId: TENANT,
    runId: 'arun-1',
    agentSlug: 'scribe',
    agentVersionId: 'agent-v3',
    agentVersionNumber: 3,
    startedAt: STARTED_AT,
    metaData: { agentTask: 'TEXT_GENERATION', requestBodyHash: 'abc' },
  });

describe('factory', () => {
  it('CreateRun is a WORKFLOW row, exactly as before — no agent identity', () => {
    const entity = workflowRun();
    expect(entity.kind).toBe(WorkflowRunKind.WORKFLOW);
    expect(entity.agentSlug).toBeNull();
    expect(entity.agentVersionId).toBeNull();
    expect(entity.agentVersionNumber).toBeNull();
    expect(() => entity.validate()).not.toThrow();
  });

  it('CreateAgentRun is an AGENT row: agent identity set, workflow identity NULL, own session key', () => {
    const entity = agentRun();
    expect(entity.kind).toBe(WorkflowRunKind.AGENT);
    expect(entity).toMatchObject({
      agentSlug: 'scribe',
      agentVersionId: 'agent-v3',
      agentVersionNumber: 3,
      workflowVersionId: null,
      workflowSlug: null,
      workflowVersionNumber: null,
      definitionName: null,
      runId: 'arun-1',
      sessionId: 'agent-run-arun-1',
      trigger: 'agent run',
      status: WorkflowRunStatus.RUNNING,
      isSandbox: false,
      resultRef: null,
    });
    expect(entity.sessionId).toBe(agentRunSessionId('arun-1'));
    expect(entity.metaData).toEqual({ agentTask: 'TEXT_GENERATION', requestBodyHash: 'abc' });
    expect(() => entity.validate()).not.toThrow();
  });
});

describe('validate — one identity, by kind', () => {
  it('a WORKFLOW row without its workflow identity is refused', () => {
    const entity = workflowRun();
    entity.workflowSlug = null;
    expect(() => entity.validate()).toThrow(BusinessException);
  });

  it('an AGENT row without its agent identity is refused', () => {
    const entity = agentRun();
    entity.agentVersionId = null;
    expect(() => entity.validate()).toThrow(BusinessException);
  });

  it('an AGENT row carrying a workflow identity is refused', () => {
    const entity = agentRun();
    entity.workflowSlug = 'triage_flow';
    expect(() => entity.validate()).toThrow(BusinessException);
  });
});

describe('mapper', () => {
  it('writes kind + agent identity, never `_version`', () => {
    const persisted = WorkflowRunEntityMapper.getInstance().toPersistence(agentRun()) as unknown as Record<string, unknown>;
    expect(persisted).toMatchObject({ kind: 'AGENT', agentSlug: 'scribe', agentVersionId: 'agent-v3', agentVersionNumber: 3, workflowSlug: null });
    expect(persisted).not.toHaveProperty('version');
  });

  it('reads an AGENT row back with its kind and identity', () => {
    const row = new WorkflowRun({
      id: 'row-1',
      tenantId: TENANT,
      kind: WorkflowRunKind.AGENT,
      workflowVersionId: null,
      workflowSlug: null,
      workflowVersionNumber: null,
      definitionName: null,
      agentSlug: 'scribe',
      agentVersionId: 'agent-v3',
      agentVersionNumber: 3,
      sessionId: 'agent-run-arun-1',
      runId: 'arun-1',
      trigger: 'agent run',
      status: WorkflowRunStatus.COMPLETED,
      isSandbox: false,
      startedAt: STARTED_AT,
      endedAt: STARTED_AT,
      durationMs: 5,
      nodeCount: 1,
      failedNodeCount: 0,
      degradedNodeCount: 0,
      firstErrorCode: null,
      resultRef: { kind: 'inline', value: { text: 'x' } },
      version: 2,
      createdAt: STARTED_AT,
      updatedAt: STARTED_AT,
    } as never);
    const entity = WorkflowRunEntityMapper.getInstance().toDomainEntity(row);
    expect(entity.kind).toBe(WorkflowRunKind.AGENT);
    expect(entity.agentSlug).toBe('scribe');
    expect(entity.agentVersionNumber).toBe(3);
    expect(entity.resultRef).toEqual({ kind: 'inline', value: { text: 'x' } });
  });
});

describe('repository lookups filter by kind', () => {
  function repo() {
    const delegate = { findMany: vi.fn(async () => []) };
    const repository = new WorkflowRunRepository({ getDatabaseService: () => ({ workflowRun: delegate }) } as never);
    return { repository, delegate };
  }

  it('findByRunKey — the WORKFLOW lookup — never matches an AGENT row', async () => {
    const { repository, delegate } = repo();
    await repository.findByRunKey(TENANT, 'workflow-interpreter-run-1', 'run-1');
    expect(delegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT, sessionId: 'workflow-interpreter-run-1', runId: 'run-1', kind: 'WORKFLOW' }),
      }),
    );
  });

  it('findAgentRun reads kind = AGENT under the agent session key', async () => {
    const { repository, delegate } = repo();
    expect(await repository.findAgentRun(TENANT, 'arun-1')).toBeNull();
    expect(delegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT, sessionId: 'agent-run-arun-1', runId: 'arun-1', kind: 'AGENT' }),
      }),
    );
  });
});
