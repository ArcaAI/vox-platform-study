/**
 * TASK-1038 OD-26 (lane B6a) — the run read model now holds AGENT runs (`POST /agents/:slug/runs`)
 * beside workflow runs, so every WORKFLOW reader must ask for `kind = WORKFLOW` and the shared
 * plumbing that SHOULD see agent runs must not.
 *
 *   - the admin runs list (`listRuns`)                → WORKFLOW only, sandbox flag or not;
 *   - the declared consultation read (governing run)  → WORKFLOW only;
 *   - WORKFLOW_INVOCATIONS metering                   → WORKFLOW only (an agent run is metered by its
 *                                                       tokens, never as a workflow invocation);
 *   - the OD-25 result purge                          → covers AGENT results too (no kind filter),
 *                                                       so an agent's output is gone after
 *                                                       `workflowRuns.resultRetentionDays`;
 *   - the WORKFLOW DTO mapper                         → never NULLs a field on a WORKFLOW row.
 *
 * (`findByRunKey`'s own `kind = WORKFLOW` filter is pinned in packages/domains.)
 */
import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { WorkflowRunFactory, WorkflowRunKind } from '@arcaai/domains';
import { WorkflowRunService } from '../workflow-run.service';
import { WorkflowRunDtoMapper } from '../workflow-run.dto.mapper';
import { WorkflowRunResultRetentionService } from '../workflow-run-result-retention.service';
import { ConsultationReadService } from '../../consultation-read/consultation-read.service';
import { MeteringService } from '../../metering/metering.service';

const TENANT = '50000000-0000-0000-0000-000000000000';

describe('WorkflowRunService.listRuns', () => {
  function build() {
    const repository = { findAll: vi.fn().mockResolvedValue([]), findByRunKey: vi.fn().mockResolvedValue(null) };
    const service = new WorkflowRunService(repository as never, { emit: vi.fn() } as never, { get: vi.fn() } as never);
    return { service, repository };
  }

  it('lists WORKFLOW runs only — an agent run never appears in the runs list', async () => {
    const { service, repository } = build();
    await service.listRuns(TENANT);
    expect(repository.findAll.mock.calls[0][0].where).toMatchObject({ tenantId: TENANT, kind: WorkflowRunKind.WORKFLOW });
  });

  it('keeps the kind filter when sandbox runs are included', async () => {
    const { service, repository } = build();
    await service.listRuns(TENANT, { includeSandbox: true, workflowSlug: 'scribe' });
    expect(repository.findAll.mock.calls[0][0].where).toMatchObject({ kind: WorkflowRunKind.WORKFLOW, workflowSlug: 'scribe' });
  });
});

describe('WorkflowRunDtoMapper', () => {
  it('maps a WORKFLOW row unchanged (identity columns are non-null on that kind)', () => {
    const entity = WorkflowRunFactory.CreateRun({
      tenantId: TENANT,
      workflowVersionId: 'def-1',
      workflowSlug: 'triage_flow',
      workflowVersionNumber: 2,
      definitionName: 'Triage Flow',
      sessionId: 'workflow-interpreter-run-1',
      runId: 'run-1',
      trigger: 'api invoke',
      startedAt: new Date('2026-10-04T00:00:00.000Z'),
    });
    expect(WorkflowRunDtoMapper.toResponse(entity)).toMatchObject({
      workflowVersionId: 'def-1',
      workflowSlug: 'triage_flow',
      workflowVersionNumber: 2,
      definitionName: 'Triage Flow',
    });
  });
});

describe('ConsultationReadService — the governing run', () => {
  it('reads the run with kind = WORKFLOW, so an agent run id is a plain 404', async () => {
    const runs = { findAll: vi.fn().mockResolvedValue([]) };
    const service = new ConsultationReadService(
      { emit: vi.fn() } as never,
      { get: vi.fn() } as never,
      runs as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(
      service.read({ tenantId: TENANT, runId: 'arun-1', consultationId: 'c-1', nodeId: 'n-1', paths: ['consultation.patient.age'] } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(runs.findAll).toHaveBeenCalledWith({ filters: { tenantId: TENANT, runId: 'arun-1', kind: WorkflowRunKind.WORKFLOW } });
  });
});

describe('MeteringService — WORKFLOW_INVOCATIONS', () => {
  it('counts WORKFLOW runs only', async () => {
    const baseClient = {
      consultation: { count: vi.fn().mockResolvedValue(0) },
      audioRecording: { aggregate: vi.fn().mockResolvedValue({ _sum: { duration: 0 } }) },
      summaryMeta: { count: vi.fn().mockResolvedValue(0) },
      workflowRun: { count: vi.fn().mockResolvedValue(3) },
      aiUsageRollupDaily: {
        aggregate: vi.fn().mockResolvedValue({ _sum: { quantitySum: { toNumber: () => 0 } } }),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      aiUsageEvent: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const service = new MeteringService(
      { getValueWithDefault: vi.fn((_key: string, fallback: unknown) => fallback) } as never,
      { addCronJob: vi.fn(), getCronJob: vi.fn(), deleteCronJob: vi.fn() } as never,
      { baseClient } as never,
    );
    expect((await service.getCurrentUsage(TENANT, new Date('2026-03-17T09:41:23.456Z'))).workflowInvocations).toBe(3);
    expect(baseClient.workflowRun.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ tenantId: TENANT, kind: WorkflowRunKind.WORKFLOW }),
    });
  });
});

describe('WorkflowRunResultRetentionService — agent results expire too (OD-25)', () => {
  it('selects candidates without a kind filter and tombstones an AGENT row past its window', async () => {
    const now = new Date('2026-10-04T04:45:00.000Z');
    const agentRow = {
      id: 'agent-row',
      tenantId: TENANT,
      kind: WorkflowRunKind.AGENT,
      endedAt: new Date(now.getTime() - 40 * 86_400_000),
      resultRef: { kind: 'inline', value: { text: 'note' } },
      version: 2,
    };
    const rows = [agentRow];
    const repository = {
      findAll: vi.fn(async () => rows.splice(0)),
      updateWithVersion: vi.fn(async (_id: string, entity: unknown) => entity),
    };
    const service = new WorkflowRunResultRetentionService(repository as never, { resolve: vi.fn(() => ({ value: 30 })) } as never);
    service.now = () => now;

    expect(await service.purgeExpired()).toEqual({ scanned: 1, expired: 1 });
    const [props] = repository.findAll.mock.calls[0] as unknown as [{ where: unknown }];
    expect(JSON.stringify(props.where)).not.toContain('kind":"WORKFLOW');
    expect((repository.updateWithVersion.mock.calls[0][1] as { resultRef: unknown }).resultRef).toEqual({ kind: 'expired', expiredAt: now.toISOString() });
  });
});
