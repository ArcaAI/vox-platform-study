/**
 * TASK-1038 OD-35 — the workflow run stream-ticket mint is bound to the run's starter (through
 * `getRunStatus`, which answers a foreign principal's run with the unknown-run 404 BEFORE anything
 * is minted) and records the reader it proved on the ticket, so the redeeming SSE/socket request
 * is checked as the same principal rather than as the key's bound human.
 */
import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowsController } from '../workflows.controller';

const TENANT = '50000000-0000-0000-0000-000000000001';
const RUN = 'run-42';
const READER = { principal: { type: 'apiKey', id: 'key-A' }, tenantWide: false };

function make(getRunStatus: ReturnType<typeof vi.fn>) {
  const streamTicketService = {
    issueTicket: vi.fn(async (input: { scope: string }) => ({ ticket: 'T', expiresAt: 1, scope: input.scope })),
  };
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'human-1', tenantId: TENANT } : undefined)) };
  const runAccess = { resolveReader: vi.fn(async () => READER) };
  const controller = new WorkflowsController(
    { getRunStatus } as never,
    { stream: vi.fn() } as never,
    undefined,
    streamTicketService as never,
    cls as never,
    undefined,
    runAccess as never,
  );
  return { controller, streamTicketService, runAccess };
}

describe('OD-35 — POST /workflows/:slug/runs/:runId/stream-ticket', () => {
  it('records the proved run reader on the ticket', async () => {
    const { controller, streamTicketService, runAccess } = make(vi.fn(async () => ({ runId: RUN, workflowVersionNumber: 1, status: 'RUNNING' })));
    await controller.issueRunStreamTicket('report', RUN);
    expect(runAccess.resolveReader).toHaveBeenCalledWith('workflow');
    expect(streamTicketService.issueTicket).toHaveBeenCalledWith(expect.objectContaining({ scope: `workflow_run:${RUN}`, runReader: READER }));
  });

  it('a run another principal started: the unknown-run 404, no reader resolved, nothing minted', async () => {
    const { controller, streamTicketService, runAccess } = make(
      vi.fn(async () => {
        throw new NotFoundException(`WorkflowRun ${RUN} not found`);
      }),
    );
    await expect(controller.issueRunStreamTicket('report', RUN)).rejects.toBeInstanceOf(NotFoundException);
    expect(runAccess.resolveReader).not.toHaveBeenCalled();
    expect(streamTicketService.issueTicket).not.toHaveBeenCalled();
  });
});
