/**
 * TASK-1036 (OD-4) — the socket lane is gated by the workflow's SETTINGS.
 *
 * `POST /workflows/:slug/runs/:runId/stream-ticket` mints a socket ticket. A workflow whose
 * effective settings do not admit the `socket` connection must not hand one out: 400
 * `MODE_UNSUPPORTED`, and no ticket exists. Ownership (404) is still proved FIRST.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WorkflowsController } from '../workflows.controller';

const TENANT = '50000000-0000-0000-0000-000000000001';
const RUN_ID = 'run-42';

function make(over: { assertEntryAllowed?: ReturnType<typeof vi.fn>; getRunStatus?: ReturnType<typeof vi.fn> } = {}) {
  const workflowExposureService = {
    getRunStatus: over.getRunStatus ?? vi.fn(async () => ({ runId: RUN_ID, slug: 'report', workflowVersionNumber: 3, status: 'RUNNING' })),
  };
  const streamTicketService = {
    issueTicket: vi.fn(async (input: { scope: string }) => ({ ticket: 'TICKET-abc', expiresAt: 1_700_000_030_000, scope: input.scope })),
  };
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'u1', tenantId: TENANT } : undefined)) };
  const entryGate = { assertAnyEntryAllowed: over.assertEntryAllowed ?? vi.fn(async () => undefined) };
  const controller = new WorkflowsController(
    workflowExposureService as never,
    { stream: vi.fn() } as never,
    undefined,
    streamTicketService as never,
    cls as never,
    entryGate as never,
  );
  return { controller, streamTicketService, entryGate, workflowExposureService };
}

describe('stream-ticket is gated by the workflow settings (sse OR socket — TASK-1038 E2 fix 1)', () => {
  it('asks the gate whether the run’s own workflow version admits sse OR socket, then mints', async () => {
    const { controller, entryGate, streamTicketService } = make();
    const result = await controller.issueRunStreamTicket('report', RUN_ID);
    // The ticket opens either lane (`url` socket, `sseUrl` SSE; the browser `useRun` uses SSE), so
    // an [api, sse] workflow must still get one. Each lane is enforced again at redemption.
    expect(entryGate.assertAnyEntryAllowed).toHaveBeenCalledWith('report', 3, ['sse', 'socket']);
    expect(result.ticket).toBe('TICKET-abc');
    expect(streamTicketService.issueTicket).toHaveBeenCalledTimes(1);
  });

  it('refuses with 400 MODE_UNSUPPORTED and mints NOTHING when the settings admit neither lane', async () => {
    const assertEntryAllowed = vi.fn(async () => {
      throw new BadRequestException({ code: 'MODE_UNSUPPORTED', message: "transport 'socket' requires the workflow to admit the 'socket' connection" });
    });
    const { controller, streamTicketService } = make({ assertEntryAllowed });
    await expect(controller.issueRunStreamTicket('report', RUN_ID)).rejects.toMatchObject({ response: { code: 'MODE_UNSUPPORTED' } });
    expect(streamTicketService.issueTicket).not.toHaveBeenCalled();
  });

  it('keeps ownership first: a foreign run is a 404 before the gate is consulted', async () => {
    const getRunStatus = vi.fn(async () => {
      throw new NotFoundException('Workflow run not found');
    });
    const { controller, entryGate } = make({ getRunStatus });
    await expect(controller.issueRunStreamTicket('report', RUN_ID)).rejects.toBeInstanceOf(NotFoundException);
    expect(entryGate.assertAnyEntryAllowed).not.toHaveBeenCalled();
  });
});
