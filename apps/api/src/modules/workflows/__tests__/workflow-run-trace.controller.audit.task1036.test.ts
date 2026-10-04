/**
 * TASK-1036 (lane B6b) — opening the ADMIN TRACE of a run is an audited PHI read.
 *
 * The trace delivers every stored event of a run, patient data included (protocol-v2.md §5:
 * "PHI is visible to admins, and viewing it is audited"). Like the other PHI reads
 * (`consultationDeclaredRead`, the Prompt Inspector), opening it broadcasts ONE `ResourceViewed`
 * with `forceAuditLog: true` naming WHO opened WHICH run in WHICH tenant — identifiers only, never
 * an event value. A refused open (403, foreign/unknown 404) audits nothing.
 */
import 'reflect-metadata';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ResourceType, SysEventType } from '@arcaai/domains';
import { WorkflowRunTraceController } from '../workflow-run-trace.controller';

const TENANT = '10000000-0000-0000-0000-000000000001';
const run = {
  runId: 'R',
  workflowSlug: 'flow',
  workflowVersionNumber: 3,
  status: 'RUNNING',
  startedAt: '2026-10-04T10:00:00.000Z',
  endedAt: null,
  isSandbox: true,
};

function build(overrides: { access?: () => Promise<void>; getRun?: () => Promise<unknown>; readTimes?: number } = {}) {
  const access = { assertCanTrace: vi.fn(overrides.access ?? (async () => undefined)) };
  const runs = { getRun: vi.fn(overrides.getRun ?? (async () => run)) };
  const stream = {
    streamRun: vi.fn(async (input: { readStatus: () => Promise<unknown> }) => {
      // The stream re-reads status (R-2 terminal re-check); the audit must still be ONE event.
      for (let i = 0; i < (overrides.readTimes ?? 1); i++) await input.readStatus();
    }),
  };
  const cls = {
    get: vi.fn((key: string) => {
      if (key === 'tenantId') return TENANT;
      if (key === 'user') return { id: 'admin-1' };
      if (key === 'correlationId') return 'corr-1';
      return undefined;
    }),
  };
  const events = { emit: vi.fn() };
  const controller = new WorkflowRunTraceController(runs as never, access as never, stream as never, cls as never, events as never);
  return { controller, events };
}

const viewed = (events: { emit: ReturnType<typeof vi.fn> }) => events.emit.mock.calls.filter(([type]) => type === SysEventType.ResourceViewed);

describe('admin trace open — audited PHI read', () => {
  it('broadcasts ONE forced-audit ResourceViewed naming who, which run and which tenant, with no values', async () => {
    const { controller, events } = build({ readTimes: 3 });
    await controller.streamTrace('R', {} as never);

    const calls = viewed(events);
    expect(calls).toHaveLength(1);
    const payload = calls[0][1] as Record<string, unknown>;
    expect(payload).toMatchObject({
      resourceType: ResourceType.WorkflowRun,
      resourceId: 'R',
      tenantId: TENANT,
      responsibleEntityId: 'admin-1',
      forceAuditLog: true,
      data: { action: 'workflowRunTraceOpened', runId: 'R', workflowSlug: 'flow', workflowVersionNumber: 3, isSandbox: true },
    });
    // Identifiers only: nothing from the run's events or outputs.
    expect(Object.keys(payload.data as object).sort()).toEqual(['action', 'isSandbox', 'runId', 'workflowSlug', 'workflowVersionNumber']);
  });

  it('audits nothing when the caller is refused (403)', async () => {
    const { controller, events } = build({ access: async () => Promise.reject(new ForbiddenException()) });
    await expect(controller.streamTrace('R', {} as never)).rejects.toBeInstanceOf(ForbiddenException);
    expect(viewed(events)).toHaveLength(0);
  });

  it('audits nothing for a foreign or unknown run (404)', async () => {
    const { controller, events } = build({ getRun: async () => Promise.reject(new NotFoundException()) });
    await expect(controller.streamTrace('R', {} as never)).rejects.toBeInstanceOf(NotFoundException);
    expect(viewed(events)).toHaveLength(0);
  });
});
