/**
 * TASK-1038 E2 (fix 1) — the SSE lane is enforced where the SSE stream REDEEMS a run ticket.
 *
 * The mint (`POST …/stream-ticket`) admits a workflow whose settings enable `sse` OR `socket`. The
 * socket lane is enforced by the WS gateway; the SSE lane here: a `?ticket=` request on
 * `GET :slug/runs/:runId/stream` for a workflow that does not admit `sse` is 400
 * `MODE_UNSUPPORTED`, and nothing is streamed. A bearer (non-ticket) request is unchanged.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { WorkflowsController } from '../workflows.controller';

const TENANT = '50000000-0000-0000-0000-000000000001';

function make(gate: ReturnType<typeof vi.fn>) {
  const getRunStatus = vi.fn(async () => ({ runId: 'run-1', slug: 'report', workflowVersionNumber: 4, status: 'RUNNING' }));
  const stream = vi.fn(async () => undefined);
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : undefined)) };
  const entryGate = { assertEntryAllowed: gate, assertAnyEntryAllowed: vi.fn() };
  const controller = new WorkflowsController({ getRunStatus } as never, { stream } as never, undefined, undefined, cls as never, entryGate as never);
  return { controller, stream, getRunStatus };
}

const res = {} as never;

describe('SSE redemption of a run ticket enforces the `sse` lane', () => {
  it('asks the gate about `sse` for the run’s own version, then streams', async () => {
    const gate = vi.fn(async () => undefined);
    const { controller, stream } = make(gate);
    await controller.streamRunStatus('report', 'run-1', res, undefined, undefined, undefined, '2', undefined, { query: { ticket: 'T-1' } } as never);
    expect(gate).toHaveBeenCalledWith('report', 4, 'sse');
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('refuses 400 MODE_UNSUPPORTED and streams nothing when the workflow does not admit sse', async () => {
    const gate = vi.fn(async () => {
      throw new BadRequestException({ code: 'MODE_UNSUPPORTED', message: 'x' });
    });
    const { controller, stream } = make(gate);
    await expect(
      controller.streamRunStatus('report', 'run-1', res, undefined, undefined, undefined, '2', undefined, { query: { ticket: 'T-1' } } as never),
    ).rejects.toMatchObject({ response: { code: 'MODE_UNSUPPORTED' } });
    expect(stream).not.toHaveBeenCalled();
  });

  it('does not consult the lane gate for a bearer (non-ticket) request', async () => {
    const gate = vi.fn(async () => undefined);
    const { controller, stream, getRunStatus } = make(gate);
    await controller.streamRunStatus('report', 'run-1', res, undefined, undefined, undefined, undefined, undefined, { query: {} } as never);
    expect(gate).not.toHaveBeenCalled();
    expect(getRunStatus).not.toHaveBeenCalled();
    expect(stream).toHaveBeenCalledTimes(1);
  });
});
